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

import { navigate, domainAllowed, hostOf } from "./navigator.js";
import { isToolError, resultText } from "./observe.js";
import { BudgetExceeded } from "./client.js";
import { buildQuestions, questionsError, compactAnswer } from "./questions.js";

// Re-exported: callers and tests reached these through this module first.
export { buildQuestions, questionsError, compactAnswer };

export const MAX_ITEMS = 50;
const TEXT_CONCURRENCY = 4;

/** Totals per question across items, so the table can be read top-down. */
export function summarize(rows, questions) {
  const ok = rows.filter((r) => r.answers);
  const out = {};
  for (const q of questions) {
    const vals = ok.map((r) => r.answers[q.key]).filter(Boolean);
    if (q.type === "yes_no") {
      out[q.key] = { yes: vals.filter((v) => v.yes > 0.5).length, no: vals.filter((v) => v.yes <= 0.5).length, unsure: vals.filter((v) => Math.abs(v.yes - 0.5) < 0.2).length };
    } else if (q.type === "choice") {
      const counts = {};
      for (const v of vals) counts[v.choice] = (counts[v.choice] ?? 0) + 1;
      out[q.key] = counts;
    } else if (q.type === "score") {
      out[q.key] = { mean: vals.length ? Number((vals.reduce((s, v) => s + v.score, 0) / vals.length).toFixed(2)) : null };
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
export function collapseRepeats(text) {
  return text.replace(/(?<=^| )(\S.{4,150}?)(?: \1)+(?= |$)/g, "$1");
}

/**
 * The page's readable text, from the element Claude named (or <main>, or the
 * body). Read through javascript_tool so a client-rendered page (a leboncoin
 * profile renders its rating after load) is read as the user sees it; the
 * selector is Claude's, never Jev's.
 */
async function readPage(callTool, tabId, selector, maxChars) {
  const sel = JSON.stringify(selector || "");
  const expr = `(() => {
    const el = (${sel} && document.querySelector(${sel})) || document.querySelector('main') || document.body;
    return { url: location.href, title: document.title, text: (el ? el.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, ${Number(maxChars) * 3}) };
  })()`;
  // A page that renders after load answers with an empty element at first;
  // three short retries cover it without a fixed sleep on every page.
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await callTool("javascript_tool", { action: "javascript_exec", text: expr, tabId });
    if (isToolError(res)) return { error: resultText(res) };
    let page;
    try {
      page = JSON.parse(resultText(res));
    } catch {
      return { error: `Could not read the page: ${resultText(res).slice(0, 200)}` };
    }
    // Read three times the budget so text freed by collapsing repeats is
    // filled with more of the page, then cut to the budget.
    if (page.text) page.text = collapseRepeats(page.text).slice(0, maxChars);
    if (page.text || attempt === 2) return page;
    await callTool("jev_settle", { tabId, expect: "wait", timeoutMs: 500 });
  }
}

/** Run `fn` over `items` with at most `n` in flight, keeping order. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

/**
 * Items built by Claude's script on the page: the extraction that used to be
 * its own round trip ("list the ads, then judge them") runs inside this call.
 */
async function scriptItems(callTool, tabId, code, timeoutMs) {
  const res = await callTool("javascript_tool", {
    action: "javascript_exec", text: code, tabId,
    ...(timeoutMs ? { timeout_ms: timeoutMs } : {})
  });
  const raw = resultText(res);
  if (isToolError(res)) return { error: `items_script failed: ${raw.slice(0, 300)}` };
  let value;
  try {
    value = JSON.parse(raw);
    // A script that ends in JSON.stringify(...) returns a string of JSON.
    if (typeof value === "string") value = JSON.parse(value);
  } catch {
    return { error: `items_script must end in an array of items; got: ${raw.slice(0, 200)}` };
  }
  if (!Array.isArray(value)) return { error: `items_script must end in an array of items; got ${typeof value}.` };
  const bad = value.findIndex((it) => !it || typeof it !== "object");
  if (bad >= 0) return { error: `items_script item ${bad + 1} is not an object.` };
  return { items: value };
}

/** Backs the jev_assess tool. */
export async function assess(callTool, client, cfg, args) {
  const {
    tabId, questions, context = "", selector,
    max_chars: maxChars = 4000, return_chars: returnChars = 300,
    allow_sensitive: allowSensitive = false
  } = args;
  const startedAt = Date.now();
  const deadline = startedAt + (args.max_ms ?? Math.max(cfg.maxMs, 180000));

  const qErr = questionsError(questions);
  if (qErr) return { status: "error", reason: qErr };
  let items = args.items ?? [];
  if (args.items_script) {
    if (typeof tabId !== "number") return { status: "error", reason: "items_script needs a tabId to run in." };
    const built = await scriptItems(callTool, tabId, args.items_script, args.items_script_timeout_ms);
    if (built.error) return { status: "error", reason: built.error };
    items = [...items, ...built.items];
  }
  if (!items.length) return { status: "error", reason: "No items to assess." };
  if (items.length > MAX_ITEMS) return { status: "error", reason: `At most ${MAX_ITEMS} items per call; got ${items.length}.` };
  const bare = items.findIndex((it) => !it.url && !it.goal && it.text == null);
  if (bare >= 0) return { status: "error", reason: `Item ${bare + 1} has no url, goal or text to assess.` };
  if (items.some((it) => (it.url || it.goal) && typeof tabId !== "number")) {
    return { status: "error", reason: "Items with a url or goal need a tabId to browse in." };
  }

  const jevQuestions = buildQuestions(questions);
  let stopped = null;

  const judge = async (item, page) => {
    const state = {
      context,
      item: {
        label: item.label ?? null,
        ...(item.context ? { context: item.context } : {}),
        ...(page.url ? { url: page.url } : {}),
        ...(page.title ? { title: page.title } : {}),
        text: page.text
      }
    };
    const { answers } = await client.decide(state, jevQuestions);
    const compact = {};
    for (const q of questions) compact[q.key] = compactAnswer(answers[q.key]);
    return compact;
  };

  const assessOne = async (item, i) => {
    const row = { i: i + 1, label: item.label ?? null, url: item.url ?? null };
    if (stopped) return { ...row, status: "skipped", reason: stopped };
    if (Date.now() > deadline) {
      stopped = "time limit reached";
      return { ...row, status: "skipped", reason: stopped };
    }
    try {
      let page;
      if (item.text != null && !item.url && !item.goal) {
        page = { text: String(item.text).slice(0, maxChars) };
      } else {
        // Only Claude's URLs are ever opened, and the domain rules apply
        // before anything is fetched or sent.
        if (item.url && !domainAllowed(item.url, cfg)) {
          return { ...row, status: "blocked", reason: `${hostOf(item.url)} is outside jev.allowed_domains / in jev.blocked_domains.` };
        }
        if (item.goal) {
          const nav = await navigate(callTool, client, cfg, {
            tabId, goal: item.goal, success_criteria: item.success_criteria ?? item.goal,
            values: item.values, start_url: item.url, allow_sensitive: allowSensitive,
            max_steps: item.max_steps, max_ms: Math.max(1000, deadline - Date.now())
          });
          row.navigation = { status: nav.status, steps: nav.steps.length, ...(nav.reason ? { reason: nav.reason } : {}) };
        } else {
          const res = await callTool("navigate", { url: item.url, tabId });
          if (isToolError(res)) return { ...row, status: "error", reason: resultText(res) };
          await callTool("jev_settle", { tabId, expect: "quiet" });
        }
        page = await readPage(callTool, tabId, item.selector ?? selector, maxChars);
        if (page.error) return { ...row, status: "error", reason: page.error };
        if (!domainAllowed(page.url, cfg)) {
          return { ...row, status: "blocked", reason: `Landed on ${hostOf(page.url)}, which the domain rules exclude; nothing was sent.` };
        }
        if (page.url !== item.url) row.final_url = page.url;
        if (page.title) row.title = page.title;
      }
      if (!page.text) return { ...row, status: "error", reason: "The page had no readable text." };
      const answers = await judge(item, page);
      return {
        ...row, status: "ok", answers,
        ...(returnChars > 0 ? { excerpt: page.text.slice(0, returnChars) } : {})
      };
    } catch (err) {
      if (err instanceof BudgetExceeded) stopped = err.message;
      return { ...row, status: "error", reason: err?.message ?? String(err) };
    }
  };

  // Text items do not touch the browser, so they run in parallel. Anything
  // that opens a page shares the one tab and runs in order.
  const browsing = items.map((it) => Boolean(it.url || it.goal));
  const rows = new Array(items.length);
  const textIdx = items.map((_, i) => i).filter((i) => !browsing[i]);
  const pageIdx = items.map((_, i) => i).filter((i) => browsing[i]);
  const textRows = await pool(textIdx, TEXT_CONCURRENCY, (i) => assessOne(items[i], i));
  textIdx.forEach((i, k) => (rows[i] = textRows[k]));
  for (const i of pageIdx) rows[i] = await assessOne(items[i], i);

  const done = rows.filter((r) => r.status === "ok").length;
  return {
    status: done === rows.length ? "done" : done === 0 ? "failed" : "partial",
    ...(stopped ? { reason: stopped } : {}),
    summary: summarize(rows, questions),
    items: rows,
    usage: { ...client.totals, wall_ms: Date.now() - startedAt }
  };
}
