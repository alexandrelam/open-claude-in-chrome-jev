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
import { EVIDENCE_SUFFIX, splitPassages, numberedText, evidenceQuestions, pickEvidence } from "./evidence.js";

// Re-exported: callers and tests reached these through this module first.
export { buildQuestions, questionsError, compactAnswer };

// No cap on the number of items: max_ms and the Jev budget already bound the
// work, and `where` bounds what comes back to Claude.
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
export function readPageExpression(selector, maxChars) {
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
      text = parts.join(' ').replace(/\\s+/g, ' ').trim().slice(0, ${Number(maxChars) * 3});
    }
    return { url: location.href, title: document.title, text };
  })()`;
}

async function readPage(callTool, tabId, selector, maxChars) {
  const expr = readPageExpression(selector, maxChars);
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

/**
 * Does a judged row pass every `where` condition? Conditions are ANDed, and a
 * row missing the answer fails. Rows that were not judged (errors, skips,
 * blocks) are never filtered: Claude has to see what went wrong.
 */
export function rowMatches(row, where) {
  if (!where?.length || row.status !== "ok") return true;
  return where.every((c) => {
    const a = row.answers?.[c.key];
    if (!a) return false;
    if (c.yes_above != null && !(a.yes > c.yes_above)) return false;
    if (c.choice_in != null && !c.choice_in.includes(a.choice)) return false;
    if (c.score_at_least != null && !(a.score >= c.score_at_least)) return false;
    return true;
  });
}

/** A `where` that names an unknown question or no test is refused up front. */
function whereError(where, questions) {
  if (where == null) return null;
  if (!Array.isArray(where)) return "`where` must be a list of conditions.";
  const keys = new Set(questions.map((q) => q.key));
  for (const c of where) {
    if (!keys.has(c?.key)) return `\`where\` names "${c?.key}", which is not one of the questions.`;
    if (c.yes_above == null && c.choice_in == null && c.score_at_least == null) {
      return `\`where\` on "${c.key}" needs yes_above, choice_in or score_at_least.`;
    }
  }
  return null;
}

/** Backs the jev_assess tool. */
export async function assess(callTool, client, cfg, args) {
  const {
    tabId, questions, context = "", selector,
    max_chars: maxChars = 4000, return_chars: returnChars = 300,
    allow_sensitive: allowSensitive = false, evidence: withEvidence = true
  } = args;
  const startedAt = Date.now();
  const deadline = startedAt + (args.max_ms ?? Math.max(cfg.maxMs, 180000));

  const qErr = questionsError(questions) ?? whereError(args.where, questions);
  if (qErr) return { status: "error", reason: qErr };
  let items = args.items ?? [];
  if (args.items_script) {
    if (typeof tabId !== "number") return { status: "error", reason: "items_script needs a tabId to run in." };
    // The script runs on its own page, not wherever a previous call left the
    // tab, and only once that page has rendered: a listing that draws its
    // cards after load otherwise hands the script an empty page.
    if (args.items_script_url) {
      if (!domainAllowed(args.items_script_url, cfg)) {
        return { status: "error", reason: `${hostOf(args.items_script_url)} is outside jev.allowed_domains / in jev.blocked_domains.` };
      }
      const res = await callTool("navigate", { url: args.items_script_url, tabId });
      if (isToolError(res)) return { status: "error", reason: `items_script_url: ${resultText(res)}` };
    }
    await callTool("jev_settle", { tabId, expect: "quiet" });
    const built = await scriptItems(callTool, tabId, args.items_script, args.items_script_timeout_ms);
    if (built.error) return { status: "error", reason: built.error };
    items = [...items, ...built.items];
  }
  if (!items.length) return { status: "error", reason: "No items to assess." };
  const bare = items.findIndex((it) => !it.url && !it.goal && it.text == null);
  if (bare >= 0) return { status: "error", reason: `Item ${bare + 1} has no url, goal or text to assess.` };
  if (items.some((it) => (it.url || it.goal) && typeof tabId !== "number")) {
    return { status: "error", reason: "Items with a url or goal need a tabId to browse in." };
  }

  const jevQuestions = buildQuestions(questions);
  let stopped = null;

  const judge = async (item, page) => {
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
        text: passages ? numberedText(passages) : page.text
      }
    };
    const asked = passages ? { ...jevQuestions, ...evidenceQuestions(questions, passages.length) } : jevQuestions;
    const { answers } = await client.decide(state, asked);
    const compact = {};
    for (const q of questions) {
      compact[q.key] = compactAnswer(answers[q.key]);
      if (passages && compact[q.key]) {
        const quote = pickEvidence(answers[q.key + EVIDENCE_SUFFIX], passages);
        if (quote) compact[q.key].evidence = quote;
      }
    }
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
          // The page is read whatever the loop's outcome. A loop that acted and
          // then stopped short (a click opened the panel, then a low-confidence
          // WAIT) is partial, not a failure: its page is usually the right one,
          // and the answers say so better than the loop's status.
          const status = nav.status === "done" ? "done" : nav.steps.length ? "partial" : "failed";
          row.navigation = {
            status, steps: nav.steps.length,
            ...(status !== "done" ? { stopped_as: nav.status } : {}),
            ...(nav.reason ? { reason: nav.reason } : {})
          };
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
  // The summary counts every item; `where` only trims the rows sent back, so a
  // big list costs Claude the matches rather than the whole table.
  const kept = rows.filter((r) => rowMatches(r, args.where));
  const dropped = rows.filter((r) => !rowMatches(r, args.where));
  return {
    status: done === rows.length ? "done" : done === 0 ? "failed" : "partial",
    ...(stopped ? { reason: stopped } : {}),
    summary: summarize(rows, questions),
    items: kept,
    ...(dropped.length ? { filtered_out: { count: dropped.length, labels: dropped.map((r) => r.label ?? r.url ?? `#${r.i}`) } } : {}),
    usage: { ...client.totals, wall_ms: Date.now() - startedAt }
  };
}
