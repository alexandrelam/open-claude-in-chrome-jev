#!/usr/bin/env node
//
// The page explorer (host/jev/explore.ts) and its wiring into jev_navigate's
// questions, its steps, and jev_assess.
//
// Jev is faked by rules rather than a script: a region is scored by what its
// card says, an evidence question picks the passage holding the fact, and a
// question is answered yes when the text it was sent holds the fact. So each
// test asserts what matters — that the fact reached Jev at all — and how many
// requests it cost to get there.
//
// Run: node host/test/jev-explore.test.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildGraph,
  explore,
  graphFromText,
  nodeText,
  readForQuestions,
  rethink,
  widen,
  type Graph,
} from "../jev/explore.ts";
import { navigate } from "../jev/navigator.ts";
import { assess } from "../jev/assess.ts";
import { resolveConfig } from "../jev/config.ts";
import { errorMessage } from "../errors.ts";
import { textOf } from "../text.ts";
import type { Answers, DecideResult, JevClient, JevQuestions, PageRegion, Row, ToolArgs } from "../jev/types.ts";

const results: Array<{ name: string; ok: boolean; err?: string }> = [];
async function check(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: errorMessage(err) });
    console.log(`  FAIL  ${name} — ${errorMessage(err)}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function eq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const CFG = {
  ...resolveConfig({ OPENROUTER_API_KEY: "k" }, {}),
  tracesDir: fs.mkdtempSync(path.join(os.tmpdir(), "jev-trace-")),
};
const SETTINGS = { beam: 4, maxRounds: 3, leafChars: 24_000 };

const row = (o: Partial<Row>): Row => ({
  ref: "ref_1",
  role: "",
  name: "",
  section: "",
  href: "",
  value: "",
  type: "",
  options: null,
  indent: 0,
  ...o,
});

/** Filler prose of about `n` characters, in sentences, with no fact in it. */
function filler(n: number, seed = "The weather was mild"): string {
  const s = `${seed} and nothing of note happened here. `;
  return s.repeat(Math.ceil(n / s.length)).slice(0, n);
}

interface Seen {
  state: Record<string, unknown>;
  questions: JevQuestions;
}

/**
 * A rule-following Jev. `scoreCard` scores a region card 0..2; evidence picks
 * the passage matching `fact`; a yes/no question is yes when the text it was
 * sent matches `fact`. `extra` answers anything else (a step's questions).
 */
function ruleJev({
  fact,
  scoreCard = () => 0,
  extra,
}: {
  fact: RegExp;
  scoreCard?: (card: string) => number;
  extra?: (state: Record<string, unknown>, questions: JevQuestions) => Answers;
}): JevClient & { seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    totals: { requests: 0, cost_usd: 0, input_tokens: 0, budget_usd: 1, resolved_model: "fake" },
    decide: async (raw, questions): Promise<DecideResult> => {
      const state = raw as Record<string, unknown>;
      seen.push({ state, questions });
      const answers: Answers = extra ? extra(state, questions) : {};
      const regions = (state["regions"] as string[] | undefined) ?? [];
      const item = state["item"] as { text?: string } | undefined;
      const text = textOf(state["page_text"]) || textOf(item?.text);
      const lines = text.split("\n");
      for (const [key, q] of Object.entries(questions)) {
        if (answers[key]) continue;
        if (q.type === "score") {
          const card = regions[Number(key.slice(1)) - 1] ?? "";
          answers[key] = { type: "score", score: scoreCard(card), confidence: 0.9 };
        } else if (key.endsWith("__evidence")) {
          const hit = lines.findIndex((l) => fact.test(l));
          const choice = hit >= 0 ? `p${hit + 1}` : "none";
          answers[key] = { type: "choice", choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 };
        } else if (q.type === "noul") {
          const yes = fact.test(text);
          answers[key] = { type: "noul", noul: yes ? 0.95 : 0.05, confidence: 0.9 };
        }
      }
      return { answers, ms: 1, usage: { cost: 0 }, model: null };
    },
  };
}

/** A listing: header, a list of `n` ads, a footer. Ad `hit` mentions an invoice. */
function listing(n: number, hit: number, adChars = 800): PageRegion[] {
  const regions: PageRegion[] = [
    { id: "r0", parent: null, kind: "page", name: "Annonces", text: "" },
    { id: "r1", parent: "r0", kind: "landmark", name: "Header", text: "Search Sell Messages Favourites Account" },
    { id: "r2", parent: "r0", kind: "landmark", name: "Results", text: "" },
    { id: "r3", parent: "r2", kind: "list", name: "Annonces iPhone 15", text: "" },
  ];
  for (let i = 1; i <= n; i++) {
    const fact = i === hit ? " Vendu avec facture d'achat Fnac." : "";
    regions.push({
      id: `r${100 + i}`,
      parent: "r3",
      kind: "item",
      name: `iPhone 15 ad ${i}`,
      text: `iPhone 15 128 Go, ${500 + i} €.${fact} ${filler(adChars, `Ad ${i} description`)}`,
    });
  }
  regions.push({ id: "r9", parent: "r0", kind: "landmark", name: "Footer", text: filler(300, "Legal notice") });
  return regions;
}

/** An article: five long sections, the fact deep in the fourth one's second subsection. */
function article(): PageRegion[] {
  const regions: PageRegion[] = [{ id: "r0", parent: null, kind: "page", name: "Octopus", text: "" }];
  const names = ["Etymology", "Anatomy", "Behaviour", "Lifecycle", "Culture"];
  names.forEach((name, i) => {
    const id = `r${i + 1}`;
    regions.push({ id, parent: "r0", kind: "section", name, text: filler(2000, name) });
    for (let k = 1; k <= 3; k++) {
      const fact = name === "Lifecycle" && k === 2 ? " Females die shortly after the eggs hatch." : "";
      regions.push({
        id: `${id}_${k}`,
        parent: id,
        kind: "section",
        name: `${name} part ${k}`,
        text: filler(3000, `${name} ${k}`) + fact,
      });
    }
  });
  return regions;
}

// ---------------------------------------------------------------------------
// The graph

await check("wrappers fold into their only part, which keeps the card's identity", () => {
  const g = buildGraph([
    { id: "r0", parent: null, kind: "page", name: "P", text: "" },
    { id: "r1", parent: "r0", kind: "item", name: "Studio 22 m²", text: "" },
    { id: "r2", parent: "r1", kind: "region", name: "", text: "" },
    { id: "r3", parent: "r2", kind: "section", name: "", text: filler(100) },
  ]);
  eq(g.root.children.length, 1, "one part");
  const card = g.root.children[0];
  eq(card?.id, "r3", "the innermost region survives");
  eq(card?.kind, "item", "still an item");
  eq(card?.name, "Studio 22 m²", "named after the card");
});

await check("a region's own text becomes its first part, and controls follow folded regions", () => {
  const g = buildGraph(
    [
      { id: "r0", parent: null, kind: "page", name: "P", text: "" },
      { id: "r1", parent: "r0", kind: "section", name: "Intro", text: filler(200) },
      { id: "r2", parent: "r1", kind: "region", name: "Card", text: "" },
      { id: "r3", parent: "r2", kind: "region", name: "Inner", text: filler(100) },
      { id: "r4", parent: "r1", kind: "region", name: "Other", text: filler(100) },
    ],
    [row({ ref: "ref_9", role: "button", name: "Buy", region: "r2" })],
  );
  const intro = g.nodes.get("r1");
  eq(intro?.children[0]?.kind, "text", "own text first");
  eq(intro?.own, "", "moved out of the region itself");
  eq(g.nodes.get("r3")?.rows[0]?.ref, "ref_9", "the control of folded r2 lands in r3");
  eq(g.root.controls, 1, "counted up the tree");
});

await check("[edit] links and hidden text are handled in names and text", () => {
  const g = buildGraph([
    { id: "r0", parent: null, kind: "page", name: "P", text: "" },
    { id: "r1", parent: "r0", kind: "section", name: "Biology[edit]", text: "Shown text.", hidden: "Lave-linge" },
  ]);
  eq(g.nodes.get("r1")?.name, "Biology", "name");
  assert(nodeText(g.root).includes("[collapsed on the page: Lave-linge]"), "hidden text kept, marked");
});

// ---------------------------------------------------------------------------
// Exploring and reading

await check("a page that fits is read whole, with no request", async () => {
  const jev = ruleJev({ fact: /facture/ });
  const g = buildGraph(listing(5, 3, 200));
  const r = await readForQuestions(jev.decide, g, { intent: "facture?", mode: "auto", ...SETTINGS });
  eq(jev.seen.length, 0, "no request");
  eq(r.coverage.mode, "whole", "mode");
  assert(r.text.includes("facture"), "the whole page is the text");
});

await check("a listing too long for one request is read as notes, and the 27th ad's fact is found", async () => {
  const jev = ruleJev({ fact: /facture/, scoreCard: (c) => (/list "Annonces/.test(c) ? 2 : 0) });
  const g = buildGraph(listing(40, 27));
  assert(g.root.chars > 24_000, `page is long: ${g.root.chars}`);
  const r = await readForQuestions(jev.decide, g, {
    questions: [{ key: "invoice", type: "yes_no", question: "Does an ad mention an invoice (facture)?" }],
    intent: "Does an ad mention an invoice (facture)?",
    mode: "auto",
    ...SETTINGS,
  });
  eq(r.coverage.mode, "notes", "mode");
  assert(
    r.text.includes("[iPhone 15 ad 27]") && r.text.includes("facture"),
    `notes quote ad 27: ${r.text.slice(0, 200)}`,
  );
  assert(!r.text.includes("Legal notice"), "the footer was passed over");
  // One scoring round over the page's three parts, then two map chunks.
  eq(r.coverage.rounds, 1, "rounds");
  eq(r.coverage.requests, 1 + r.reading.requests, "requests add up");
  assert(r.reading.requests >= 2, "the list was read in chunks");
});

await check("an article is opened section by section down to the part that holds the fact", async () => {
  const jev = ruleJev({ fact: /eggs hatch/, scoreCard: (c) => (/Lifecycle/.test(c) ? 2 : 0) });
  const g = buildGraph(article());
  const r = await readForQuestions(jev.decide, g, {
    intent: "What happens to females after the eggs hatch?",
    mode: "auto",
    ...SETTINGS,
  });
  eq(r.coverage.mode, "focused", "mode");
  assert(r.text.includes("eggs hatch"), "the fact is in the text");
  assert(!r.text.includes("Etymology"), "other sections were not read");
  assert(r.coverage.chars_read < r.coverage.chars_total / 3, "a fraction of the page");
});

await check("exploration is bounded by max rounds, however relevant everything looks", async () => {
  // Every region is "directly relevant" and too big: it would open forever.
  const regions: PageRegion[] = [{ id: "r0", parent: null, kind: "page", name: "P", text: "" }];
  let next = 1;
  const grow = (parent: string, depth: number): void => {
    for (let i = 0; i < 3; i++) {
      const id = `r${next++}`;
      regions.push({ id, parent, kind: "section", name: `S${id}`, text: depth === 0 ? filler(4000) : "" });
      if (depth > 0) grow(id, depth - 1);
    }
  };
  grow("r0", 4);
  const jev = ruleJev({ fact: /nothing/, scoreCard: () => 2 });
  const g = buildGraph(regions);
  const exp = await explore(jev.decide, g, { intent: "x", mode: "read", ...SETTINGS, maxRounds: 2 });
  eq(exp.rounds, 2, "stopped at the cap");
  assert(exp.focus.length > 0, "still has a focus");
  eq(exp.requests, jev.seen.length, "every request counted");
});

await check("nothing relevant: the two best regions are kept, not none", async () => {
  const jev = ruleJev({ fact: /zzz/ });
  const g = buildGraph(article());
  const exp = await explore(jev.decide, g, { intent: "x", mode: "read", ...SETTINGS });
  assert(exp.focus.length >= 1 && exp.focus.length <= 2, `focus: ${exp.focus.length}`);
});

await check("widening adds the next-best likely regions, and stops when none are left", async () => {
  // Sections are unfolded into their parts before scoring, so parts are scored.
  const scores: Record<string, number> = { "Anatomy part 1": 1, "Behaviour part 1": 0.6, "Lifecycle part 2": 2 };
  const jev = ruleJev({
    fact: /zzz/,
    scoreCard: (c) => Object.entries(scores).find(([k]) => c.includes(`"${k}"`))?.[1] ?? 0,
  });
  const g = buildGraph(article());
  const exp = await explore(jev.decide, g, { intent: "x", mode: "read", ...SETTINGS, beam: 0 });
  eq(exp.focus.map((n) => n.name).join(","), "Lifecycle part 2", "only the clear one at first");
  const wider = widen(exp, 1);
  assert(wider, "widened");
  eq(wider.focus.map((n) => n.name).join(","), "Anatomy part 1,Lifecycle part 2", "the next best, in page order");
  const widest = widen(wider, 4);
  eq(widest?.focus.length, 3, "then the last likely one");
  eq(widest && widen(widest, 4), null, "never regions scored irrelevant");
});

await check("rethink reads the widened focus", async () => {
  const jev = ruleJev({
    fact: /eggs hatch/,
    scoreCard: (c) => (c.includes('"Anatomy part 1"') ? 2 : c.includes('"Lifecycle part 2"') ? 1 : 0),
  });
  const g: Graph = buildGraph(article());
  const opts = { intent: "eggs", mode: "auto" as const, ...SETTINGS, beam: 0 };
  const first = await readForQuestions(jev.decide, g, opts);
  assert(!first.text.includes("eggs hatch"), "not in the first look");
  const second = await rethink(jev.decide, g, first, { ...opts, beam: 1 });
  assert(second?.text.includes("eggs hatch"), "found in the wider look");
});

await check("wrappers are unfolded without a request, so rounds go to real choices", async () => {
  // page > main > content > article: three wrappers around the sections.
  const [page, ...sections] = article().map((r) => (r.parent === "r0" ? { ...r, parent: "w3" } : r));
  assert(page, "page region");
  const regions: PageRegion[] = [
    page,
    { id: "w1", parent: "r0", kind: "landmark", name: "", text: filler(60, "Site") },
    { id: "w2", parent: "w1", kind: "region", name: "", text: filler(60, "Main") },
    { id: "w3", parent: "w2", kind: "region", name: "Octopus", text: filler(60, "Lead") },
    ...sections,
  ];
  const jev = ruleJev({ fact: /eggs hatch/, scoreCard: (c) => (/Lifecycle part 2/.test(c) ? 2 : 0) });
  const g = buildGraph(regions);
  const exp = await explore(jev.decide, g, { intent: "eggs", mode: "read", ...SETTINGS, beam: 0 });
  eq(exp.rounds, 1, "one round");
  eq(exp.focus.map((n) => n.name).join(","), "Lifecycle part 2", "straight to the part");
});

await check("text with no page behind it is cut into parts and explored the same way", async () => {
  const text = `${filler(30_000, "Intro")} Le lave-linge est inclus. ${filler(10_000, "Outro")}`;
  const g = graphFromText(text);
  assert(g.root.children.length > 10, "many parts");
  const jev = ruleJev({ fact: /lave-linge/, scoreCard: (c) => (/lave-linge/.test(c) ? 2 : 0) });
  const r = await readForQuestions(jev.decide, g, { intent: "washing machine?", mode: "auto", ...SETTINGS });
  assert(r.text.includes("lave-linge"), "found");
});

// ---------------------------------------------------------------------------
// Wiring

interface FakePage {
  url: string;
  title: string;
  rows: Row[];
  regions: PageRegion[];
}

function fakeBrowser(page: FakePage, onClick?: (p: FakePage, args: ToolArgs) => void) {
  const calls: Array<{ name: string; args: ToolArgs }> = [];
  const text = (t: string) => ({ content: [{ type: "text", text: t }] });
  const callTool = async (name: string, args: ToolArgs) => {
    calls.push({ name, args });
    if (name === "jev_snapshot") {
      return text(
        JSON.stringify({
          url: page.url,
          title: page.title,
          text: "top of the page",
          truncated: false,
          scroll: { y: 0, height: 5000, viewport: 800 },
          rows: page.rows,
          ...(args["map"] ? { regions: page.regions } : {}),
        }),
      );
    }
    if (name === "jev_act") {
      onClick?.(page, args);
      return text("ok");
    }
    if (name === "javascript_tool") {
      return text(
        JSON.stringify({ url: page.url, title: page.title, text: page.regions.map((r) => r.text).join(" ") }),
      );
    }
    return text("ok");
  };
  return { callTool, calls };
}

await check("jev_navigate questions reach a fact deep in a long page, with evidence and coverage", async () => {
  const browser = fakeBrowser({ url: "https://wiki.test/Octopus", title: "Octopus", rows: [], regions: article() });
  const jev = ruleJev({ fact: /eggs hatch/, scoreCard: (c) => (/Lifecycle/.test(c) ? 2 : 0) });
  const out = await navigate(browser.callTool, jev, CFG, {
    tabId: 1,
    questions: [{ key: "dies", type: "yes_no", question: "Do females die after the eggs hatch?" }],
  });
  eq(out.answers?.["dies"]?.yes, 0.95, `answer (${out.reason})`);
  assert(out.answers?.["dies"]?.evidence?.includes("eggs hatch"), `evidence quotes it: ${JSON.stringify(out.answers)}`);
  eq(out.coverage?.mode, "focused", "coverage says how it was read");
  assert(
    browser.calls.some((c) => c.name === "jev_snapshot" && c.args["map"]),
    "asked for the map",
  );
});

await check("explore: never keeps the old single read", async () => {
  const browser = fakeBrowser({ url: "https://wiki.test/Octopus", title: "Octopus", rows: [], regions: article() });
  const jev = ruleJev({ fact: /eggs hatch/ });
  const out = await navigate(browser.callTool, jev, CFG, {
    tabId: 1,
    explore: "never",
    questions: [{ key: "dies", type: "yes_no", question: "Do females die after the eggs hatch?" }],
  });
  eq(out.answers?.["dies"]?.yes, 0.05, "the fact is past the window");
  eq(out.coverage, undefined, "no coverage");
  assert(!browser.calls.some((c) => c.args["map"]), "no map");
});

await check("a step that sees nothing useful on screen explores, and clicks an off-screen control", async () => {
  const regions: PageRegion[] = [
    { id: "r0", parent: null, kind: "page", name: "Dashboard", text: "" },
    { id: "r1", parent: "r0", kind: "landmark", name: "Nav", text: "Home Settings Profile Help" },
    { id: "r2", parent: "r0", kind: "section", name: "Charts", text: filler(20_000, "Revenue chart") },
    { id: "r3", parent: "r0", kind: "section", name: "Reports", text: filler(9000, "Monthly report data") },
  ];
  const rows = [
    row({ ref: "ref_1", role: "link", name: "Home", href: "https://app.test/", inView: true, region: "r1" }),
    row({ ref: "ref_2", role: "button", name: "Download", inView: false, region: "r3" }),
  ];
  let clicked = "";
  const browser = fakeBrowser({ url: "https://app.test/dash", title: "Dashboard", rows, regions }, (p, args) => {
    clicked = String(args["ref"]);
    p.url = "https://app.test/dash?exported=1";
  });
  const jev = ruleJev({
    fact: /zzz/,
    scoreCard: (c) => (/Reports/.test(c) ? 2 : 0),
    extra: (state, questions) => {
      if (!questions["operation"]) return {};
      const elements = (state["elements"] as string[]) ?? [];
      const dl = elements.find((e) => e.includes("Download"));
      const done = String(state["url"]).includes("exported");
      if (done)
        return {
          operation: { type: "choice", choice: "DONE", confidence: 0.9 },
          satisfied: { type: "noul", noul: 0.95, confidence: 0.9 },
          sensitive: { type: "noul", noul: 0, confidence: 1 },
        };
      if (!dl)
        return {
          operation: { type: "choice", choice: "BLOCKED", confidence: 0.9 },
          satisfied: { type: "noul", noul: 0.02, confidence: 0.96 },
          sensitive: { type: "noul", noul: 0, confidence: 1 },
        };
      const id = dl.split(" | ")[0] ?? "";
      return {
        operation: { type: "choice", choice: "CLICK", confidence: 0.9, probabilities: { CLICK: 0.9 } },
        click_target: { type: "choice", choice: id, confidence: 0.9, probabilities: { [id]: 0.9 } },
        satisfied: { type: "noul", noul: 0.02, confidence: 0.96 },
        sensitive: { type: "noul", noul: 0, confidence: 1 },
      };
    },
  });
  const out = await navigate(browser.callTool, jev, CFG, {
    tabId: 1,
    goal: "export the monthly report",
    success_criteria: "exported=1 in the URL",
  });
  eq(clicked, "ref_2", `clicked the off-screen control (${out.status}: ${out.reason})`);
  eq(out.status, "done", "done");
});

await check("jev_assess explores a long text item instead of cutting it at max_chars", async () => {
  const jev = ruleJev({ fact: /facture/, scoreCard: (c) => (/facture/.test(c) ? 2 : 0) });
  const text = `${filler(40_000, "Description")} Vendu avec facture. ${filler(5000, "Contact")}`;
  const out = await assess(async () => ({ content: [] }), jev, CFG, {
    items: [{ text, label: "ad" }],
    questions: [{ key: "invoice", type: "yes_no", question: "Is it sold with an invoice (facture)?" }],
  });
  const item = out.items?.[0];
  eq(item?.answers?.["invoice"]?.yes, 0.95, `answer (${item?.reason})`);
  assert(item?.coverage && item.coverage.chars_total > 40_000, "coverage reported");
});

await check("jev_assess with explore: never still cuts at max_chars", async () => {
  const jev = ruleJev({ fact: /facture/ });
  const text = `${filler(40_000, "Description")} Vendu avec facture.`;
  const out = await assess(async () => ({ content: [] }), jev, CFG, {
    items: [{ text }],
    explore: "never",
    questions: [{ key: "invoice", type: "yes_no", question: "Invoice?" }],
  });
  eq(out.items?.[0]?.answers?.["invoice"]?.yes, 0.05, "not seen");
  eq(out.items?.[0]?.coverage, undefined, "no coverage");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n",
);
process.exit(failed.length ? 1 : 0);
