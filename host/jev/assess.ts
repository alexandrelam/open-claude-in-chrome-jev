// jev_assess: Claude's own questions, answered by Jev over many items at once.
//
// jev_navigate hands Jev the clicking; this hands it the judging. Claude writes
// the questions once ("is this a good deal?", "does the ad promise an
// invoice?"), supplies the facts a page cannot know (today's new price, what
// counts as a deal), and names the items: pages to open, or text it already
// holds. Jev answers every question for every item and Claude reads one table
// at the end instead of making a round trip per page.
//
// Jev still never writes. Every answer is a probability over options Claude
// defined, so the table is as trustworthy as the questions: the judgement Claude
// used to make per item is now a rule it states once, in `context`.

import { navigate, domainAllowed, hostOf } from "./navigator.ts";
import { isToolError, resultText } from "./observe.ts";
import { BudgetExceeded } from "./client.ts";
import { buildQuestions, questionsError, compactAnswer } from "./questions.ts";
import { EVIDENCE_SUFFIX, splitPassages, numberedText, evidenceQuestions, pickEvidence } from "./evidence.ts";
import { pool } from "./pool.ts";
import { buildGraph, exploreSettings, graphFromText, readForQuestions, rethink } from "./explore.ts";
import type { Coverage, Graph, PageReading } from "./explore.ts";
import { errorMessage } from "../errors.ts";
import type { AssessArgs, AssessItem, WhereCondition } from "./tools.ts";
import type { CallTool, ClaudeQuestion, CompactAnswer, JevClient, JevConfig, PageRegion } from "./types.ts";

/** One item to judge. Items from items_script may carry a per-item step cap. */
type Item = AssessItem & { max_steps?: number | undefined };

/** One row of the result table. */
export interface AssessRow {
  i: number;
  label: string | null;
  url: string | null;
  status: string;
  reason?: string;
  answers?: Record<string, CompactAnswer | null>;
  /** Set when the page was too long to read whole: how much of it the answers rest on. */
  coverage?: Coverage;
  excerpt?: string;
  final_url?: string;
  title?: string;
  navigation?: { status: string; steps: number; stopped_as?: string; reason?: string };
}

/** Per-question totals: yes/no/unsure counts, counts per choice, or a mean score. */
export interface QuestionSummary {
  yes?: number;
  no?: number;
  unsure?: number;
  mean?: number | null;
  [choice: string]: number | null | undefined;
}

/** What jev_assess returns. */
export interface AssessResult {
  status: string;
  reason?: string;
  summary?: Record<string, QuestionSummary>;
  items?: AssessRow[];
  filtered_out?: { count: number; labels: string[] };
  usage?: Record<string, unknown>;
}

/** A page as read for judging. */
interface Page {
  url?: string;
  title?: string;
  text: string;
}

// Re-exported: callers and tests reached these through this module first.
export { buildQuestions, questionsError, compactAnswer };

// No cap on the number of items: max_ms and the Jev budget already bound the
// work, and `where` bounds what comes back to Claude.
const TEXT_CONCURRENCY = 4;

/** Totals per question across items, so the table can be read top-down. */
export function summarize(
  rows: readonly Partial<AssessRow>[],
  questions: readonly Pick<ClaudeQuestion, "key" | "type">[],
): Record<string, QuestionSummary> {
  const ok = rows.filter((r) => r.answers);
  const out: Record<string, QuestionSummary> = {};
  for (const q of questions) {
    const vals = ok.map((r) => r.answers?.[q.key]).filter((v): v is CompactAnswer => Boolean(v));
    if (q.type === "yes_no") {
      const yes = vals.map((v) => v.yes ?? 0);
      out[q.key] = {
        yes: yes.filter((p) => p > 0.5).length,
        no: yes.filter((p) => p <= 0.5).length,
        unsure: yes.filter((p) => Math.abs(p - 0.5) < 0.2).length,
      };
    } else if (q.type === "choice") {
      const counts: Record<string, number> = {};
      for (const v of vals) counts[String(v.choice)] = (counts[String(v.choice)] ?? 0) + 1;
      out[q.key] = counts;
    } else if (q.type === "score") {
      out[q.key] = {
        mean: vals.length ? Number((vals.reduce((s, v) => s + (v.score ?? 0), 0) / vals.length).toFixed(2)) : null,
      };
    }
  }
  return out;
}

/**
 * Collapse a phrase repeated back to back into one copy. Listing cards often
 * carry their title two or three times (link text, heading, visually hidden
 * label), so innerText of a leboncoin profile reads "IPhone 16 IPhone 16
 * IPhone 16 500 €" for one ad, and Jev took one ad for three of the same phone.
 */
export function collapseRepeats(text: string): string {
  return text.replace(/(?<=^| )(\S.{4,150}?)(?: \1)+(?= |$)/g, "$1");
}

/**
 * The page's text, from the element Claude named (or <main>, or the body).
 * Read through javascript_tool so a client-rendered page (a leboncoin profile
 * renders its rating after load) is read after it renders; the selector is
 * Claude's, never Jev's.
 *
 * Every text node is read, hidden ones included. innerText drops anything under
 * display:none, and ads keep their details in collapsed panels: 123loger lists
 * "Lave-linge" only in the closed "Voir toutes les caractéristiques" block, so
 * Jev answered "not mentioned" with full confidence. Script, style and other
 * non-text subtrees are skipped.
 */
export function readPageExpression(selector: string | null | undefined, maxChars: number): string {
  const sel = JSON.stringify(selector || "");
  return `(() => {
    const el = (${sel} && document.querySelector(${sel})) || document.querySelector('main') || document.body;
    let text = '';
    if (el) {
      const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'OBJECT']);
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => n.nodeType === 1
          ? (skip.has(n.tagName.toUpperCase()) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP)
          : NodeFilter.FILTER_ACCEPT
      });
      const parts = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.nodeValue);
      text = parts.join(' ').replace(/\\s+/g, ' ').trim().slice(0, ${maxChars * 3});
    }
    return { url: location.href, title: document.title, text };
  })()`;
}

async function readPage(
  callTool: CallTool,
  tabId: number,
  selector: string | undefined,
  maxChars: number,
): Promise<Page | { error: string }> {
  const expr = readPageExpression(selector, maxChars);
  // A page that renders after load answers with an empty element at first;
  // three short retries cover it without a fixed sleep on every page.
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await callTool("javascript_tool", { action: "javascript_exec", text: expr, tabId });
    if (isToolError(res)) return { error: resultText(res) };
    let page: Page;
    try {
      page = JSON.parse(resultText(res)) as Page;
    } catch {
      return { error: `Could not read the page: ${resultText(res).slice(0, 200)}` };
    }
    // Read three times the budget so text freed by collapsing repeats is
    // filled with more of the page, then cut to the budget.
    if (page.text) page.text = collapseRepeats(page.text).slice(0, maxChars);
    if (page.text || attempt === 2) return page;
    await callTool("jev_settle", { tabId, expect: "wait", timeoutMs: 500 });
  }
  // Unreachable: the last attempt always returns.
  return { error: "Could not read the page." };
}

/**
 * Items built by Claude's script on the page: the extraction that used to be
 * its own round trip ("list the ads, then judge them") runs inside this call.
 */
async function scriptItems(
  callTool: CallTool,
  tabId: number,
  code: string,
  timeoutMs: number | undefined,
): Promise<{ items: Item[]; error?: undefined } | { error: string }> {
  const res = await callTool("javascript_tool", {
    action: "javascript_exec",
    text: code,
    tabId,
    ...(timeoutMs ? { timeout_ms: timeoutMs } : {}),
  });
  const raw = resultText(res);
  if (isToolError(res)) return { error: `items_script failed: ${raw.slice(0, 300)}` };
  let value: unknown;
  try {
    value = JSON.parse(raw);
    // A script that ends in JSON.stringify(...) returns a string of JSON.
    if (typeof value === "string") value = JSON.parse(value) as unknown;
  } catch {
    return { error: `items_script must end in an array of items; got: ${raw.slice(0, 200)}` };
  }
  if (!Array.isArray(value)) return { error: `items_script must end in an array of items; got ${typeof value}.` };
  const bad = value.findIndex((it: unknown) => !it || typeof it !== "object");
  if (bad >= 0) return { error: `items_script item ${bad + 1} is not an object.` };
  // Objects, and read field by field below as an item may or may not carry them.
  return { items: value as Item[] };
}

/**
 * Does a judged row pass every `where` condition? Conditions are ANDed, and a
 * row missing the answer fails. Rows that were not judged (errors, skips,
 * blocks) are never filtered: Claude has to see what went wrong.
 */
export function rowMatches(
  row: Partial<Pick<AssessRow, "status" | "answers">>,
  where: readonly WhereCondition[] | null | undefined,
): boolean {
  if (!where?.length || row.status !== "ok") return true;
  return where.every((c) => {
    const a = row.answers?.[c.key];
    if (!a) return false;
    if (c.yes_above != null && !((a.yes ?? NaN) > c.yes_above)) return false;
    if (c.choice_in != null && !c.choice_in.includes(a.choice ?? "")) return false;
    if (c.score_at_least != null && !((a.score ?? NaN) >= c.score_at_least)) return false;
    return true;
  });
}

/** A `where` that names an unknown question or no test is refused up front. */
function whereError(where: unknown, questions: readonly Pick<ClaudeQuestion, "key">[]): string | null {
  if (where == null) return null;
  if (!Array.isArray(where)) return "`where` must be a list of conditions.";
  const keys = new Set(questions.map((q) => q.key));
  for (const c of where as Array<Partial<WhereCondition> | null>) {
    if (!c || !keys.has(c.key ?? "")) return `\`where\` names "${c?.key}", which is not one of the questions.`;
    if (c.yes_above == null && c.choice_in == null && c.score_at_least == null) {
      return `\`where\` on "${c.key}" needs yes_above, choice_in or score_at_least.`;
    }
  }
  return null;
}

// The most page text read for one item before exploring it. Past this the
// page is not read at all, and the coverage says so.
const MAX_READ_CHARS = 300_000;

/** Is this answer below the confidence Claude would act on? */
function unsure(a: CompactAnswer | null | undefined, min: number): boolean {
  if (!a) return true;
  const c = a.yes !== undefined ? Math.abs(a.yes - 0.5) * 2 : (a.p ?? a.confidence ?? 0);
  return c < min;
}

/** How sure a set of answers is, on average, to compare two readings. */
function sureness(answers: Record<string, CompactAnswer | null>, questions: readonly ClaudeQuestion[]): number {
  return (
    questions.reduce((a, q) => {
      const x = answers[q.key];
      return a + (!x ? 0 : x.yes !== undefined ? Math.abs(x.yes - 0.5) * 2 : (x.p ?? x.confidence ?? 0));
    }, 0) / Math.max(1, questions.length)
  );
}

/** The tab's page as regions, or null when the extension cannot map it. */
async function mapGraph(callTool: CallTool, tabId: number, title: string | undefined): Promise<Graph | null> {
  const res = await callTool("jev_snapshot", { tabId, map: true, max_rows: 1 });
  if (isToolError(res)) return null;
  try {
    const snap = JSON.parse(resultText(res)) as { regions?: PageRegion[]; map_truncated?: boolean; title?: string };
    if (!Array.isArray(snap.regions)) return null;
    return buildGraph(snap.regions, [], { title: snap.title ?? title ?? "", truncated: Boolean(snap.map_truncated) });
  } catch {
    return null;
  }
}

/** Backs the jev_assess tool. */
export async function assess(
  callTool: CallTool,
  client: JevClient,
  cfg: JevConfig,
  args: AssessArgs,
): Promise<AssessResult> {
  const {
    tabId,
    questions,
    context = "",
    selector,
    max_chars: maxChars = 4000,
    return_chars: returnChars = 300,
    allow_sensitive: allowSensitive = false,
    evidence: withEvidence = true,
  } = args;
  const startedAt = Date.now();
  const deadline = startedAt + (args.max_ms ?? Math.max(cfg.maxMs, 180000));

  const qErr = questionsError(questions) ?? whereError(args.where, questions);
  if (qErr) return { status: "error", reason: qErr };
  let items: Item[] = args.items ?? [];
  if (args.items_script) {
    if (typeof tabId !== "number") return { status: "error", reason: "items_script needs a tabId to run in." };
    // The script runs on its own page, not wherever a previous call left the
    // tab, and only once that page has rendered: a listing that draws its
    // cards after load otherwise hands the script an empty page.
    if (args.items_script_url) {
      if (!domainAllowed(args.items_script_url, cfg)) {
        return {
          status: "error",
          reason: `${hostOf(args.items_script_url)} is outside jev.allowed_domains / in jev.blocked_domains.`,
        };
      }
      const res = await callTool("navigate", { url: args.items_script_url, tabId });
      if (isToolError(res)) return { status: "error", reason: `items_script_url: ${resultText(res)}` };
    }
    await callTool("jev_settle", { tabId, expect: "quiet" });
    const built = await scriptItems(callTool, tabId, args.items_script, args.items_script_timeout_ms);
    if ("error" in built && built.error !== undefined) return { status: "error", reason: built.error };
    if ("items" in built) items = [...items, ...built.items];
  }
  if (!items.length) return { status: "error", reason: "No items to assess." };
  const bare = items.findIndex((it) => !it.url && !it.goal && it.text == null);
  if (bare >= 0) return { status: "error", reason: `Item ${bare + 1} has no url, goal or text to assess.` };
  if (items.some((it) => (it.url || it.goal) && typeof tabId !== "number")) {
    return { status: "error", reason: "Items with a url or goal need a tabId to browse in." };
  }

  const jevQuestions = buildQuestions(questions);
  let stopped: string | null = null;
  // A page longer than one request is explored (explore.ts) rather than cut:
  // read whole up to the explorer's budget, else by region.
  const exploreMode = args.explore ?? "auto";
  const settings = exploreSettings(cfg);
  const leafChars = Math.max(maxChars, settings.leafChars);
  const readChars = exploreMode === "never" ? maxChars : MAX_READ_CHARS;
  const intent = [context, ...questions.map((q) => q.question)].filter(Boolean).join(" ");
  const decide = (state: unknown, qs: Parameters<JevClient["decide"]>[1]) => client.decide(state, qs);

  const judge = async (item: Item, page: Page): Promise<Record<string, CompactAnswer | null>> => {
    // With evidence on, Jev reads the page as numbered passages and names the
    // one behind each answer, which comes back verbatim.
    const passages = withEvidence ? splitPassages(page.text) : null;
    const state = {
      context,
      item: {
        label: item.label ?? null,
        ...(item.context ? { context: item.context } : {}),
        ...(page.url ? { url: page.url } : {}),
        ...(page.title ? { title: page.title } : {}),
        text: passages ? numberedText(passages) : page.text,
      },
    };
    const asked = passages ? { ...jevQuestions, ...evidenceQuestions(questions, passages.length) } : jevQuestions;
    const { answers } = await client.decide(state, asked);
    const compact: Record<string, CompactAnswer | null> = {};
    for (const q of questions) {
      const answer = compactAnswer(answers[q.key]);
      compact[q.key] = answer;
      if (passages && answer) {
        const quote = pickEvidence(answers[q.key + EVIDENCE_SUFFIX], passages);
        if (quote) answer.evidence = quote;
      }
    }
    return compact;
  };

  const assessOne = async (item: Item, i: number): Promise<AssessRow> => {
    const row: AssessRow = { i: i + 1, label: item.label ?? null, url: item.url ?? null, status: "" };
    if (stopped) return { ...row, status: "skipped", reason: stopped };
    if (Date.now() > deadline) {
      stopped = "time limit reached";
      return { ...row, status: "skipped", reason: stopped };
    }
    const browsed = Boolean(item.url || item.goal);
    try {
      let page: Page;
      if (item.text != null && !item.url && !item.goal) {
        page = { text: item.text.slice(0, readChars) };
      } else {
        // Only Claude's URLs are ever opened, and the domain rules apply
        // before anything is fetched or sent.
        if (item.url && !domainAllowed(item.url, cfg)) {
          return {
            ...row,
            status: "blocked",
            reason: `${hostOf(item.url)} is outside jev.allowed_domains / in jev.blocked_domains.`,
          };
        }
        if (item.goal) {
          const nav = await navigate(callTool, client, cfg, {
            tabId: tabId as number,
            goal: item.goal,
            success_criteria: item.success_criteria ?? item.goal,
            values: item.values,
            start_url: item.url,
            allow_sensitive: allowSensitive,
            max_steps: item.max_steps,
            max_ms: Math.max(1000, deadline - Date.now()),
          });
          // The page is read whatever the loop's outcome. A loop that acted and
          // then stopped short (a click opened the panel, then a low-confidence
          // WAIT) is partial, not a failure: its page is usually the right one,
          // and the answers say so better than the loop's status.
          const steps = nav.steps?.length ?? 0;
          const status = nav.status === "done" ? "done" : steps ? "partial" : "failed";
          row.navigation = {
            status,
            steps,
            ...(status !== "done" ? { stopped_as: nav.status } : {}),
            ...(nav.reason ? { reason: nav.reason } : {}),
          };
        } else {
          const res = await callTool("navigate", { url: item.url, tabId });
          if (isToolError(res)) return { ...row, status: "error", reason: resultText(res) };
          await callTool("jev_settle", { tabId, expect: "quiet" });
        }
        const read = await readPage(callTool, tabId as number, item.selector ?? selector, readChars);
        if ("error" in read) return { ...row, status: "error", reason: read.error };
        page = read;
        if (!domainAllowed(page.url, cfg)) {
          return {
            ...row,
            status: "blocked",
            reason: `Landed on ${hostOf(page.url)}, which the domain rules exclude; nothing was sent.`,
          };
        }
        if (page.url !== undefined && page.url !== item.url) row.final_url = page.url;
        if (page.title) row.title = page.title;
      }
      if (!page.text) return { ...row, status: "error", reason: "The page had no readable text." };
      let answers: Record<string, CompactAnswer | null>;
      let coverage: Coverage | null = null;
      if (exploreMode === "never" || (exploreMode === "auto" && page.text.length <= leafChars)) {
        answers = await judge(item, {
          ...page,
          text: page.text.slice(0, exploreMode === "never" ? maxChars : leafChars),
        });
      } else {
        // The page's own regions when it can be mapped (not for a selector,
        // which already names the part to read); else the text in parts.
        const graph =
          (browsed && !(item.selector ?? selector) ? await mapGraph(callTool, tabId as number, page.title) : null) ??
          graphFromText(page.text, { title: page.title ?? "" });
        const opts = { questions, intent, context, mode: exploreMode, ...settings, leafChars };
        let reading: PageReading = await readForQuestions(decide, graph, opts);
        answers = await judge(item, { ...page, text: collapseRepeats(reading.text) });
        // Still unsure: add the next-best regions and judge once more.
        if (questions.some((q) => unsure(answers[q.key], cfg.minConfidence))) {
          const wider = await rethink(decide, graph, reading, opts);
          if (wider) {
            const again = await judge(item, { ...page, text: collapseRepeats(wider.text) });
            if (sureness(again, questions) > sureness(answers, questions)) {
              answers = again;
              reading = wider;
            }
          }
        }
        coverage = reading.coverage;
      }
      return {
        ...row,
        status: "ok",
        answers,
        ...(coverage ? { coverage } : {}),
        ...(returnChars > 0 ? { excerpt: page.text.slice(0, returnChars) } : {}),
      };
    } catch (err) {
      if (err instanceof BudgetExceeded) stopped = err.message;
      return { ...row, status: "error", reason: errorMessage(err) };
    }
  };

  // Text items do not touch the browser, so they run in parallel. Anything
  // that opens a page shares the one tab and runs in order.
  const browsing = items.map((it) => Boolean(it.url || it.goal));
  const rows: AssessRow[] = Array.from({ length: items.length });
  const textIdx = items.map((_, i) => i).filter((i) => !browsing[i]);
  const pageIdx = items.map((_, i) => i).filter((i) => browsing[i]);
  const itemAt = (i: number): Item => items[i] as Item;
  const textRows = await pool(textIdx, TEXT_CONCURRENCY, (i) => assessOne(itemAt(i), i));
  textIdx.forEach((i, k) => (rows[i] = textRows[k] as AssessRow));
  for (const i of pageIdx) rows[i] = await assessOne(itemAt(i), i);

  const done = rows.filter((r) => r.status === "ok").length;
  // The summary counts every item; `where` only trims the rows sent back, so a
  // big list costs Claude the matches rather than the whole table.
  const kept = rows.filter((r) => rowMatches(r, args.where));
  const dropped = rows.filter((r) => !rowMatches(r, args.where));
  return {
    status: done === rows.length ? "done" : done === 0 ? "failed" : "partial",
    ...(stopped ? { reason: stopped } : {}),
    summary: summarize(rows, questions),
    items: kept,
    ...(dropped.length
      ? { filtered_out: { count: dropped.length, labels: dropped.map((r) => r.label ?? r.url ?? `#${r.i}`) } }
      : {}),
    usage: { ...client.totals, wall_ms: Date.now() - startedAt },
  };
}
