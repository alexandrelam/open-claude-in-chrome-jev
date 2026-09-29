// Exploring a page too big for one request.
//
// Every Jev decision used to be one shot over a window of the page: a step saw
// the controls on screen and 300 characters of text, a question saw the first
// 6,000 characters of one content root. On a long article or a listing the
// answer was often past the window, and Jev answered from what it had, with
// confidence. On a results page whose cards are each an <article>, the "page"
// it read was the first card.
//
// Here the page is a tree of regions (content.ts buildPageMap: landmarks,
// named regions, heading sections, runs of repeated cards), and Jev works
// through it the way a person skims:
//
//   1. score  — every region at the current level is scored for relevance to
//               the task from its name, size and first words, all in parallel;
//   2. select — the clearly relevant ones, plus the best few others (the beam);
//   3. expand — a selected region still too big to read whole is opened, and
//               its parts become the next level; repeat for a few rounds;
//   4. read   — the selected regions are read whole when they fit one request,
//               else each chunk is asked which passages bear on the questions
//               (the map) and the final question is asked over those passages
//               only (the reduce);
//   5. widen  — when the final answer is still unsure, the next-best regions
//               are added and it is asked once more.
//
// Jev still never writes. Each hop is a batch of score or choice questions, and
// the "notes" carried from the map to the reduce are passages Jev selected,
// quoted verbatim from the page.

import { STATE_TOKEN_BUDGET, estimateTokens } from "./shortlist.ts";
import { EVIDENCE_SUFFIX, evidenceQuestions, numberedText, splitPassages } from "./evidence.ts";
import { MAX_CHOICES } from "./config.ts";
import { pool } from "./pool.ts";
import type { ClaudeQuestion, Decide, JevConfig, JevQuestions, PageRegion, Row } from "./types.ts";

/** One region of the page, linked into a tree. */
export interface GNode {
  id: string;
  kind: string;
  name: string;
  /** Text the region holds itself: rendered text, then collapsed text, marked. */
  own: string;
  children: GNode[];
  parent: GNode | null;
  /** Controls that sit directly in this region. */
  rows: Row[];
  /** Characters of text in this region and every region under it. */
  chars: number;
  /** Controls in this region and every region under it. */
  controls: number;
  inView: boolean;
  /** Position in document order. */
  order: number;
}

export interface Graph {
  root: GNode;
  nodes: Map<string, GNode>;
  /** The map hit its size cap, so part of the page is missing from it. */
  truncated: boolean;
}

// A region with less text than this of its own and a single part is only a
// wrapper around that part, and is folded into it.
const MIN_OWN = 40;
const SCALE = ["Irrelevant", "Possibly relevant", "Directly relevant"];
// Regions scored per request. Questions in one request run in parallel, so
// this only bounds the size of one request, not the time.
const MAX_SCORED_PER_REQUEST = 64;
// "Directly relevant" regions kept per round, beyond the beam.
const MAX_DIRECT = 16;
// A region this small is shown whole when scored; a bigger one by how it
// starts and the names of its parts, which is its outline.
const FULL_CARD_CHARS = 1200;
const PREVIEW_CHARS = 300;
const OUTLINE_CHARS = 400;
const CONCURRENCY = 4;
// A list whose items average more than this is a list of sections (a mobile
// Wikipedia article), not of cards, and is opened like any other region.
const CARD_CHARS = 1500;
// A passage chosen with less probability than this is not a note.
const NOTE_P = 0.1;
const NOTES_PER_QUESTION = 6;

const cleanName = (s: string): string =>
  s
    .replace(/\[(edit|modifier|bearbeiten|editar)[^\]]*\]/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

const joinText = (...parts: string[]): string => parts.filter(Boolean).join(" ").trim();

function ownText(r: PageRegion): string {
  const shown = (r.text || "").trim();
  const hidden = (r.hidden || "").trim();
  return hidden ? joinText(shown, `[collapsed on the page: ${hidden}]`) : shown;
}

/**
 * Link jev_snapshot's flat region list into a tree and give each control its
 * region. Wrappers are folded into their only part, and a region with both
 * text and parts gets its text as a part of its own, so every region is
 * either read whole or opened into parts that cover all of it.
 */
export function buildGraph(
  regions: readonly PageRegion[],
  rows: readonly Row[] = [],
  { title = "", truncated = false }: { title?: string; truncated?: boolean } = {},
): Graph {
  const byId = new Map<string, GNode>();
  const make = (id: string, kind: string, name: string, own: string, inView = false): GNode => ({
    id,
    kind,
    name: cleanName(name),
    own,
    children: [],
    parent: null,
    rows: [],
    chars: 0,
    controls: 0,
    inView,
    order: 0,
  });
  for (const r of regions) byId.set(r.id, make(r.id, r.kind, r.name, ownText(r), Boolean(r.inView)));
  let root = regions.find((r) => r.parent === null && byId.has(r.id));
  const rootNode = root ? (byId.get(root.id) as GNode) : make("r0", "page", title, "");
  if (!root) byId.set(rootNode.id, rootNode);
  if (!rootNode.name) rootNode.name = cleanName(title);
  for (const r of regions) {
    const node = byId.get(r.id) as GNode;
    if (node === rootNode) continue;
    const parent = (r.parent !== null ? byId.get(r.parent) : undefined) ?? rootNode;
    node.parent = parent;
    parent.children.push(node);
  }

  // Fold wrappers. `alias` sends a folded region's controls to what replaced it.
  const alias = new Map<string, GNode>();
  const squash = (n: GNode): GNode => {
    n.children = n.children.map(squash);
    const only = n.children[0];
    if (n !== rootNode && n.children.length === 1 && only && n.own.length < MIN_OWN) {
      if (!only.name) only.name = n.name;
      // A card wrapper keeps its identity: the region inside a card is the card.
      if (n.kind === "item" || n.kind === "dialog") only.kind = n.kind;
      only.own = joinText(n.own, only.own);
      only.parent = n.parent;
      only.inView ||= n.inView;
      alias.set(n.id, only);
      return only;
    }
    return n;
  };
  rootNode.children = rootNode.children.map(squash);
  for (const c of rootNode.children) c.parent = rootNode;

  // A region with parts keeps its own text as its first part.
  const splitOwn = (n: GNode): void => {
    n.children.forEach(splitOwn);
    if (n.children.length && n.own.length >= MIN_OWN) {
      const text = make(`${n.id}~`, "text", n.name ? `${n.name} (text)` : "", n.own, n.inView);
      text.parent = n;
      n.children.unshift(text);
      n.own = "";
    }
  };
  splitOwn(rootNode);

  const nodes = new Map<string, GNode>();
  let order = 0;
  const index = (n: GNode): void => {
    n.order = order++;
    nodes.set(n.id, n);
    n.children.forEach(index);
  };
  index(rootNode);
  const resolve = (id: string | undefined): GNode => {
    if (!id) return rootNode;
    return nodes.get(id) ?? alias.get(id) ?? rootNode;
  };
  for (const row of rows) resolve(row.region).rows.push(row);

  const total = (n: GNode): void => {
    n.children.forEach(total);
    n.chars = n.own.length + n.children.reduce((a, c) => a + c.chars, 0);
    n.controls = n.rows.length + n.children.reduce((a, c) => a + c.controls, 0);
  };
  total(rootNode);
  return { root: rootNode, nodes, truncated };
}

/**
 * A graph for text that has no page behind it (a jev_assess text item, or a
 * page read by selector): the text cut into parts of about `partChars`.
 */
export function graphFromText(text: string, { title = "", partChars = FULL_CARD_CHARS } = {}): Graph {
  const passages = splitPassages(text, { limit: Number.MAX_SAFE_INTEGER });
  const parts: string[] = [];
  let cur = "";
  for (const p of passages) {
    if (cur && cur.length + p.length + 1 > partChars) {
      parts.push(cur);
      cur = "";
    }
    cur = joinText(cur, p);
  }
  if (cur) parts.push(cur);
  const regions: PageRegion[] = [{ id: "r0", parent: null, kind: "page", name: title, text: "" }];
  parts.forEach((p, i) =>
    regions.push({ id: `r${i + 1}`, parent: "r0", kind: "text", name: `part ${i + 1} of ${parts.length}`, text: p }),
  );
  return buildGraph(regions, [], { title });
}

/** "item "Studio 22 m²"", or the bare kind for a region with no name. */
export function label(n: GNode): string {
  return n.name ? `${n.kind} "${n.name}"` : n.kind;
}

/** The region's text and all of its parts', in document order, parts named. */
export function nodeText(n: GNode): string {
  const parts: string[] = [];
  const walk = (x: GNode): void => {
    if (x !== n && x.name && x.kind !== "text") parts.push(`§ ${x.name}:`);
    if (x.own) parts.push(x.own);
    x.children.forEach(walk);
  };
  walk(n);
  return parts.join(" ");
}

/** Every control in the region and its parts, in document order. */
export function subtreeRows(n: GNode): Row[] {
  const out: Row[] = [...n.rows];
  for (const c of n.children) out.push(...subtreeRows(c));
  return out;
}

/**
 * How Jev sees a region it is asked to score: what it is and how big, then
 * all of its text when it is small, else how it starts and its outline (the
 * names of its parts). A preview alone hid a fact sitting mid-region.
 */
export function card(n: GNode): string {
  const bits = [n.id, label(n), `${n.chars} chars${n.children.length ? ` in ${n.children.length} parts` : ""}`];
  if (n.controls) bits.push(`${n.controls} controls`);
  if (n.inView) bits.push("on screen");
  const text = nodeText(n);
  if (text.length <= FULL_CARD_CHARS) {
    bits.push(text);
  } else {
    bits.push(`${text.slice(0, PREVIEW_CHARS)}…`);
    const outline = n.children
      .map((c) => c.name)
      .filter((name) => name && !name.endsWith("(text)"))
      .join(", ");
    if (outline)
      bits.push(`parts: ${outline.length > OUTLINE_CHARS ? `${outline.slice(0, OUTLINE_CHARS)}…` : outline}`);
  }
  return bits.join(" | ");
}

export interface Visit {
  round: number;
  id: string;
  label: string;
  score: number;
  kept: boolean;
  expanded: boolean;
}

export interface Exploration {
  /** The regions to read or act in, in document order. */
  focus: GNode[];
  /** Regions scored and passed over, best first: what widening adds. */
  ranked: Array<{ node: GNode; score: number }>;
  visits: Visit[];
  rounds: number;
  requests: number;
}

export interface ExploreOptions {
  /** What the regions are scored against: the goal, or the questions. */
  intent: string;
  context?: string | undefined;
  /** "read" never opens a list of cards: reading covers every card. */
  mode: "read" | "act";
  beam?: number | undefined;
  maxRounds?: number | undefined;
  leafChars?: number | undefined;
}

/** Score each region's relevance to the task, 0..2, in as few requests as fit. */
async function scoreNodes(
  decide: Decide,
  nodes: readonly GNode[],
  intent: string,
  context: string | undefined,
): Promise<{ scores: Map<GNode, number>; requests: number }> {
  const batches: GNode[][] = [];
  let cur: GNode[] = [];
  let tokens = 0;
  for (const n of nodes) {
    const t = estimateTokens(card(n));
    if (cur.length && (cur.length >= MAX_SCORED_PER_REQUEST || tokens + t > STATE_TOKEN_BUDGET)) {
      batches.push(cur);
      cur = [];
      tokens = 0;
    }
    cur.push(n);
    tokens += t;
  }
  if (cur.length) batches.push(cur);

  const scores = new Map<GNode, number>();
  await pool(batches, CONCURRENCY, async (batch) => {
    const questions: JevQuestions = {};
    batch.forEach((n, i) => {
      questions[`s${i + 1}`] = {
        type: "score",
        instructions: `How likely is region ${n.id} to hold what the task needs? A small region is shown whole; a large one only by how it starts and the names of its parts, so it can hold it further in.`,
        criteria: SCALE,
      };
    });
    const { answers } = await decide(
      { task: intent, ...(context ? { context } : {}), regions: batch.map((n) => card(n)) },
      questions,
    );
    batch.forEach((n, i) => scores.set(n, answers[`s${i + 1}`]?.score ?? 0));
  });
  return { scores, requests: batches.length };
}

function opensUp(n: GNode, mode: ExploreOptions["mode"]): boolean {
  if (!n.children.length) return false;
  if (mode === "read" && n.kind === "list") return n.chars / n.children.length > CARD_CHARS;
  return true;
}

// Regions one round scores, at most, once the tree is unfolded.
const FRONTIER_SIZE = 40;

/**
 * Open the biggest regions of a frontier, without asking Jev, until it has
 * about FRONTIER_SIZE regions or none is big enough to be worth opening.
 *
 * Pages nest their content under wrappers (Wikipedia: body, main, content,
 * the list of sections), and scoring one wrapper per round spent the whole
 * round budget before a single section was scored: the explorer then read
 * almost the entire article as notes. Opening wrappers is free; only the
 * choice between real parts needs Jev.
 */
export function unfold(nodes: readonly GNode[], mode: ExploreOptions["mode"], leafChars: number): GNode[] {
  let frontier = [...nodes];
  for (;;) {
    const big = frontier
      .filter((n) => opensUp(n, mode) && n.chars > leafChars / 4)
      .sort((a, b) => b.chars - a.chars)[0];
    if (!big || frontier.length - 1 + big.children.length > FRONTIER_SIZE) break;
    frontier = frontier.flatMap((n) => (n === big ? n.children : [n]));
  }
  return frontier.sort((a, b) => a.order - b.order);
}

/**
 * Find the regions the task is about: score, keep the best, open the ones
 * still too big, for at most `maxRounds` rounds. A page that fits
 * `leafChars` whole is its own focus, and costs no request.
 */
export async function explore(decide: Decide, graph: Graph, opts: ExploreOptions): Promise<Exploration> {
  const { intent, context, mode, beam = 4, maxRounds = 3, leafChars = 24_000 } = opts;
  const out: Exploration = { focus: [], ranked: [], visits: [], rounds: 0, requests: 0 };
  if (graph.root.chars <= leafChars || !graph.root.children.length) {
    out.focus = [graph.root];
    return out;
  }

  let frontier = unfold(graph.root.children, mode, leafChars);
  while (frontier.length && out.rounds < maxRounds) {
    out.rounds++;
    const { scores, requests } = await scoreNodes(decide, frontier, intent, context);
    out.requests += requests;
    const sorted = [...frontier].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || a.order - b.order);
    const kept = new Set<GNode>();
    for (const n of sorted) if ((scores.get(n) ?? 0) >= 1.5 && kept.size < MAX_DIRECT) kept.add(n);
    const direct = kept.size;
    for (const n of sorted) {
      if (kept.size >= direct + beam) break;
      if ((scores.get(n) ?? 0) >= 0.5) kept.add(n);
    }
    // Nothing looked relevant: keep the two best rather than nothing, so the
    // reading can still say what the page does hold.
    if (!kept.size) sorted.slice(0, 2).forEach((n) => kept.add(n));
    // An open dialog covers the page: whatever the task, it is in the way.
    for (const n of frontier) if (n.kind === "dialog" && n.inView) kept.add(n);

    const keptList = [...kept];
    const size = keptList.reduce((a, n) => a + n.chars, 0);
    const share = leafChars / Math.max(1, keptList.length);
    const open =
      size <= leafChars || out.rounds >= maxRounds ? [] : keptList.filter((n) => opensUp(n, mode) && n.chars > share);
    for (const n of frontier) {
      const score = scores.get(n) ?? 0;
      const isKept = kept.has(n);
      const opened = open.includes(n);
      out.visits.push({
        round: out.rounds,
        id: n.id,
        label: label(n),
        score: Number(score.toFixed(2)),
        kept: isKept,
        expanded: opened,
      });
      if (isKept && !opened) out.focus.push(n);
      else if (!isKept) out.ranked.push({ node: n, score });
    }
    frontier = unfold(
      open.flatMap((n) => n.children),
      mode,
      leafChars,
    );
  }
  out.focus.sort((a, b) => a.order - b.order);
  out.ranked.sort((a, b) => b.score - a.score || a.node.order - b.node.order);
  return out;
}

/** Add the next-best regions to the focus, for a second look. Null when none are left. */
export function widen(exp: Exploration, count = 4): Exploration | null {
  // Only regions Jev thought might hold it: widening into the nav bar and the
  // footer spends a request to read noise.
  const within = (n: GNode, f: GNode): boolean => {
    for (let x: GNode | null = n; x; x = x.parent) if (x === f) return true;
    return false;
  };
  const extra = exp.ranked
    .filter(({ node, score }) => score >= 0.5 && !exp.focus.some((f) => within(node, f)))
    .slice(0, count);
  if (!extra.length) return null;
  const added = new Set(extra.map((e) => e.node));
  return {
    focus: [...exp.focus, ...added].sort((a, b) => a.order - b.order),
    ranked: exp.ranked.filter(({ node }) => !added.has(node)),
    visits: [
      ...exp.visits,
      ...extra.map(({ node, score }) => ({
        round: exp.rounds + 1,
        id: node.id,
        label: label(node),
        score: Number(score.toFixed(2)),
        kept: true,
        expanded: false,
      })),
    ],
    rounds: exp.rounds + 1,
    requests: exp.requests,
  };
}

export interface Reading {
  text: string;
  /** "whole": the focus read as it is. "notes": only the passages chosen from it. */
  mode: "whole" | "notes";
  requests: number;
}

/** A passage of the page and where it sits, for the notes. */
interface Passage {
  text: string;
  at: number;
}

/**
 * The text of the focus, as Jev will be asked about it: whole when it fits
 * one request, else the passages each chunk says bear on the questions.
 */
export async function readFocus(
  decide: Decide,
  focus: readonly GNode[],
  {
    questions,
    intent,
    context,
    leafChars = 24_000,
  }: {
    questions?: readonly ClaudeQuestion[] | null | undefined;
    intent: string;
    context?: string | undefined;
    leafChars?: number | undefined;
  },
): Promise<Reading> {
  const many = focus.length > 1;
  const blocks = focus.map((n) => (many || n.parent ? `§ ${label(n)}: ${nodeText(n)}` : nodeText(n)));
  const whole = blocks.join("\n");
  if (whole.length <= leafChars) return { text: whole, mode: "whole", requests: 0 };

  // The map. A list is read card by card, and each passage keeps its card's
  // or region's name in front, so a quote from a listing says which listing
  // it is from and never runs from one card into the next.
  const units = focus.flatMap((n) => (n.kind === "list" && n.children.length ? n.children : [n]));
  const tagged = units.length > 1;
  const passages: Passage[] = [];
  for (const n of units) {
    const tag = tagged && n.name ? `[${n.name.slice(0, 40)}] ` : "";
    for (const p of splitPassages(nodeText(n), { limit: Number.MAX_SAFE_INTEGER })) {
      passages.push({ text: tag + p, at: passages.length });
    }
  }
  const chunks: Passage[][] = [];
  let cur: Passage[] = [];
  let size = 0;
  for (const p of passages) {
    if (cur.length && (size + p.text.length > leafChars || cur.length >= MAX_CHOICES - 1)) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += p.text.length + 1;
  }
  if (cur.length) chunks.push(cur);

  const asked: ReadonlyArray<Pick<ClaudeQuestion, "key" | "question">> = questions?.length
    ? questions
    : [{ key: "task", question: intent }];
  const chosen = new Map<number, number>();
  await pool(chunks, CONCURRENCY, async (chunk) => {
    const { answers } = await decide(
      { task: intent, ...(context ? { context } : {}), page_text: numberedText(chunk.map((p) => p.text)) },
      evidenceQuestions(asked, chunk.length),
    );
    for (const q of asked) {
      const probs = answers[q.key + EVIDENCE_SUFFIX]?.probabilities ?? {};
      Object.entries(probs)
        .filter(([k, p]) => k.startsWith("p") && p >= NOTE_P)
        .sort((a, b) => b[1] - a[1])
        .slice(0, NOTES_PER_QUESTION)
        .forEach(([k, p]) => {
          const passage = chunk[Number(k.slice(1)) - 1];
          if (passage) chosen.set(passage.at, Math.max(p, chosen.get(passage.at) ?? 0));
        });
    }
  });

  // The reduce reads the notes in page order; past the budget, the likeliest win.
  let notes = [...chosen.entries()].sort((a, b) => b[1] - a[1]);
  let used = 0;
  notes = notes.filter(([at]) => {
    const len = (passages[at]?.text.length ?? 0) + 1;
    if (used + len > leafChars) return false;
    used += len;
    return true;
  });
  const text = notes
    .map(([at]) => at)
    .sort((a, b) => a - b)
    .map((at) => passages[at]?.text ?? "")
    .join("\n");
  // Nothing bore on the questions: say so with the start of the focus, which
  // lets a "not on this page" answer rest on something.
  return { text: text || whole.slice(0, leafChars), mode: "notes", requests: chunks.length };
}

/** How much of the page an answer rests on, for Claude to weigh it. */
export interface Coverage {
  mode: "whole" | "focused" | "notes";
  regions_read: number;
  regions_total: number;
  chars_read: number;
  chars_total: number;
  rounds: number;
  requests: number;
  /** The page map hit its size cap: some of the page was never read. */
  truncated?: true;
}

export function coverageOf(graph: Graph, exp: Exploration | null, reading: Reading): Coverage {
  const count = (n: GNode): number => 1 + n.children.reduce((a, c) => a + count(c), 0);
  const focus = exp?.focus ?? [graph.root];
  const whole = focus.length === 1 && focus[0] === graph.root;
  return {
    mode: reading.mode === "notes" ? "notes" : whole ? "whole" : "focused",
    regions_read: focus.reduce((a, n) => a + count(n), 0),
    regions_total: graph.nodes.size,
    chars_read: whole && reading.mode === "whole" ? graph.root.chars : focus.reduce((a, n) => a + n.chars, 0),
    chars_total: graph.root.chars,
    rounds: exp?.rounds ?? 0,
    requests: (exp?.requests ?? 0) + reading.requests,
    ...(graph.truncated ? { truncated: true as const } : {}),
  };
}

/** The exploration settings from the config, with the defaults filled in. */
export function exploreSettings(
  cfg: Partial<Pick<JevConfig, "exploreBeam" | "exploreMaxRounds" | "exploreLeafChars">>,
): {
  beam: number;
  maxRounds: number;
  leafChars: number;
} {
  return {
    beam: cfg.exploreBeam ?? 4,
    maxRounds: cfg.exploreMaxRounds ?? 3,
    leafChars: cfg.exploreLeafChars ?? 24_000,
  };
}

export interface PageReading {
  text: string;
  coverage: Coverage;
  exploration: Exploration | null;
  reading: Reading;
}

/**
 * Read a page for Claude's questions: whole when it fits one request (or when
 * exploring is off), else explored and read as focus or notes.
 */
export async function readForQuestions(
  decide: Decide,
  graph: Graph,
  opts: {
    questions?: readonly ClaudeQuestion[] | null | undefined;
    intent: string;
    context?: string | undefined;
    mode: "auto" | "always" | "never";
    beam: number;
    maxRounds: number;
    leafChars: number;
  },
): Promise<PageReading> {
  const { mode, leafChars } = opts;
  if (mode === "never" || (mode === "auto" && graph.root.chars <= leafChars)) {
    const text = nodeText(graph.root).slice(0, leafChars);
    const reading: Reading = { text, mode: "whole", requests: 0 };
    return { text, coverage: coverageOf(graph, null, reading), exploration: null, reading };
  }
  // "always" explores even a page that would fit, by treating it as too big.
  const exploration = await explore(decide, graph, {
    intent: opts.intent,
    context: opts.context,
    mode: "read",
    beam: opts.beam,
    maxRounds: opts.maxRounds,
    leafChars: mode === "always" ? Math.min(leafChars, Math.max(1, graph.root.chars - 1)) : leafChars,
  });
  const reading = await readFocus(decide, exploration.focus, opts);
  return { text: reading.text, coverage: coverageOf(graph, exploration, reading), exploration, reading };
}

/** The same reading, with the next-best regions added. Null when there are none. */
export async function rethink(
  decide: Decide,
  graph: Graph,
  prev: PageReading,
  opts: Parameters<typeof readForQuestions>[2],
): Promise<PageReading | null> {
  if (!prev.exploration) return null;
  const exploration = widen(prev.exploration, opts.beam);
  if (!exploration) return null;
  const reading = await readFocus(decide, exploration.focus, opts);
  return { text: reading.text, coverage: coverageOf(graph, exploration, reading), exploration, reading };
}

/**
 * The regions a step should act in: explored against the goal, their controls
 * (on screen or not: acting on a ref scrolls it into view) and a short excerpt
 * of their text, which replaces the top-of-screen excerpt for that decision.
 */
export async function exploreForAction(
  decide: Decide,
  graph: Graph,
  opts: { intent: string; beam: number; maxRounds: number; leafChars: number },
): Promise<{ exploration: Exploration; rows: Row[]; excerpt: string }> {
  const exploration = await explore(decide, graph, { ...opts, mode: "act" });
  const inFocus = new Set<Row>();
  for (const n of exploration.focus) for (const r of subtreeRows(n)) inFocus.add(r);
  // Controls sitting straight on the page, outside every region, stay reachable.
  for (const r of graph.root.rows) inFocus.add(r);
  const rows = [...graph.nodes.values()].flatMap((n) => n.rows).filter((r) => inFocus.has(r));
  const excerpt = exploration.focus
    .filter((n) => n !== graph.root)
    .map((n) => `${label(n)}: ${nodeText(n).slice(0, 200)}`)
    .join(" | ")
    .slice(0, 600);
  return { exploration, rows, excerpt };
}

/** A compact record of an exploration, for the run trace. */
export function traceOf(
  r: PageReading | { exploration: Exploration; coverage?: Coverage; text?: string },
): Record<string, unknown> {
  return {
    ...(r.coverage ? { coverage: r.coverage } : {}),
    focus: r.exploration?.focus.map((n) => `${n.id} ${label(n)}`) ?? [],
    visits: r.exploration?.visits ?? [],
    ...(r.text !== undefined ? { text_sent: r.text } : {}),
  };
}
