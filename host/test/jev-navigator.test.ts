#!/usr/bin/env node
//
// The navigator loop and its gate.
//
// Two halves. `validate()` is tested directly, because it is the deterministic
// check that stands between a model's answer and a click in someone's real,
// logged-in browser, and every one of its refusals should be legible on its own.
// Then the loop is driven end to end against a fake browser and a fake Jev, to
// pin the terminal states and the three ways it gives up: no progress, the same
// action over and over, and the caps.
//
// Run: node host/test/jev-navigator.test.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  validate,
  buildRequest,
  navigate,
  decideOnce,
  normalizeSubgoals,
  navigatesAway,
  urlContradicts,
  valueFitsField,
} from "../jev/navigator.ts";
import { isCompatible } from "../jev/actions.ts";
import { resolveConfig } from "../jev/config.ts";
import { errorMessage } from "../errors.ts";
import { textOf } from "../text.ts";
import type {
  Answer,
  Answers,
  ClaudeQuestion,
  DecideResult,
  JevClient,
  JevQuestion,
  JevQuestions,
  Row,
  ScrollState,
  ToolArgs,
} from "../jev/types.ts";

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
const choice = (c: string, conf: number, probs?: Record<string, number>): Answer => ({
  type: "choice",
  choice: c,
  confidence: conf,
  probabilities: probs ?? { [c]: conf },
});
const noul = (p: number): Answer => ({ type: "noul", noul: p, confidence: Math.abs(p - 0.5) * 2 });
/** A choice question's options. */
const crit = (q: JevQuestion | undefined): Record<string, string> => (q?.criteria ?? {}) as Record<string, string>;
// Every step now carries a `satisfied` noul in the same request; this is the
// "not finished yet" answer that most steps give.
const notYet = noul(0.02);

// --- validate(): the gate, on its own ---------------------------------------

await check("validate passes a confident, compatible, harmless action", async () => {
  const map = new Map([["e1", row({ ref: "ref_3", role: "button", name: "Search" })]]);
  const v = validate(
    { operation: choice("CLICK", 0.9), click_target: choice("e1", 0.85), sensitive: noul(0.02), satisfied: notYet },
    map,
    CFG,
    { allowSensitive: false, values: {} },
  );
  assert(v.ok, `should pass: ${v.reason}`);
  eq(v.row?.ref, "ref_3", "resolved to the real ref");
});

await check("validate rejects a ref Jev was never offered", async () => {
  // The whole containment argument rests on this: eN is a key into a set we
  // just built, so anything else is not a stale ref, it is not a ref at all.
  const map = new Map([["e1", row({ role: "button", name: "Search" })]]);
  const v = validate(
    { operation: choice("CLICK", 0.9), click_target: choice("e99", 0.9), sensitive: noul(0), satisfied: notYet },
    map,
    CFG,
    { allowSensitive: false, values: {} },
  );
  eq(v.status, "needs_help", "status");
  assert(v.reason?.includes("e99"), "names what it rejected");
});

await check("validate rejects an operation the element cannot take", async () => {
  const map = new Map([["e1", row({ role: "link", name: "Docs", href: "https://x.test" })]]);
  const v = validate(
    {
      operation: choice("TYPE_TEXT", 0.95),
      text_target: choice("e1", 0.95),
      sensitive: noul(0),
      value_key: choice("q", 1),
    },
    map,
    CFG,
    { allowSensitive: false, values: { q: "hi" } },
  );
  eq(v.status, "needs_help", "status");
  assert(v.reason?.includes("TYPE_TEXT"), "names the operation");
});

await check("confidence is the weaker of operation and target, not the operation alone", async () => {
  // A confident CLICK aimed at a coin-flip element is not a confident action.
  // Both candidates are legal for CLICK, so the split is real doubt about where
  // to go — which is the case this gate exists for.
  const map = new Map([
    ["e1", row({ ref: "ref_1", role: "button", name: "Go" })],
    ["e2", row({ ref: "ref_2", role: "button", name: "Go somewhere else" })],
  ]);
  const answers = {
    operation: choice("CLICK", 0.99),
    click_target: { type: "choice", choice: "e1", confidence: 0.3, probabilities: { e1: 0.3, e2: 0.7 } },
    sensitive: noul(0),
    satisfied: notYet,
  };
  const v = validate(answers, map, CFG, { allowSensitive: false, values: {} });
  eq(v.status, "needs_help", "should fall below the 0.6 gate");
  assert(v.reason?.includes("0.30"), `reports the combined figure: ${v.reason}`);
});

await check("a head only offers targets its operation can act on", async () => {
  // Real case from Wikipedia: PRESS_ENTER split 0.58 on the search field and
  // 0.41 on the Search button, which PRESS_ENTER cannot act on. Now the button
  // is not an option in the text head at all, so it cannot absorb any mass.
  const rows = [
    row({ ref: "ref_4", role: "searchbox", name: "Search", type: "search" }),
    row({ ref: "ref_5", role: "button", name: "Search" }),
    row({ ref: "ref_6", role: "link", name: "Home", href: "https://x.test" }),
  ];
  const { questions } = buildRequest({ url: "", title: "", excerpt: "", rows }, rows, {
    goal: "g",
    successCriteria: "s",
    values: {},
  });
  eq(Object.keys(questions.text_target.criteria).join(), "e1", "only the field can be typed into");
  assert(crit(questions.click_target).e2 && crit(questions.click_target).e3, "button and link are clickable");
  assert(!questions.select_target, "no head without a legal option");
});

await check("validate reads the head that belongs to the chosen operation", async () => {
  const map = new Map([
    ["e1", row({ ref: "ref_4", role: "searchbox", name: "Search", type: "search" })],
    ["e2", row({ ref: "ref_5", role: "button", name: "Search" })],
  ]);
  const answers = {
    operation: choice("PRESS_ENTER", 0.9),
    click_target: choice("e2", 0.97),
    text_target: { type: "choice", choice: "e1", confidence: 0.95, probabilities: { e1: 0.97 } },
    sensitive: noul(0.02),
  };
  const v = validate(answers, map, CFG, { allowSensitive: false, values: {} });
  assert(v.ok, `should pass: ${v.reason}`);
  eq(v.row?.ref, "ref_4", "the text head's field, not the click head's button");
  assert(v.confidence > 0.85, `confidence: ${v.confidence}`);
});

await check("splitting between two genuinely legal targets still counts as doubt", async () => {
  // The conditioning must not become a blanket pass: two equally plausible
  // links are real uncertainty about where to go.
  const map = new Map([
    ["e1", row({ ref: "ref_1", role: "link", name: "Invoices", href: "https://x.test/a" })],
    ["e2", row({ ref: "ref_2", role: "link", name: "Invoice archive", href: "https://x.test/b" })],
  ]);
  const answers = {
    operation: choice("CLICK", 0.95),
    click_target: { type: "choice", choice: "e1", confidence: 0.52, probabilities: { e1: 0.52, e2: 0.48 } },
    sensitive: noul(0.02),
  };
  const v = validate(answers, map, CFG, { allowSensitive: false, values: {} });
  eq(v.status, "needs_help", "should still escalate");
});

await check("a sensitive label is refused even when the model calls it safe", async () => {
  const map = new Map([["e1", row({ role: "button", name: "Delete account" })]]);
  const v = validate(
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0.01), satisfied: notYet },
    map,
    CFG,
    { allowSensitive: false, values: {} },
  );
  eq(v.status, "needs_help", "status");
  assert(v.reason?.includes("sensitive keyword"), "says which gate tripped");
});

await check("a sensitive model answer is refused even when the label looks innocent", async () => {
  const map = new Map([["e1", row({ role: "button", name: "Proceed" })]]);
  const v = validate(
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0.9), satisfied: notYet },
    map,
    CFG,
    { allowSensitive: false, values: {} },
  );
  eq(v.status, "needs_help", "status");
});

await check("allow_sensitive lets a deliberate destructive action through", async () => {
  const map = new Map([["e1", row({ role: "button", name: "Delete account" })]]);
  const v = validate(
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0.9), satisfied: notYet },
    map,
    CFG,
    { allowSensitive: true, values: {} },
  );
  assert(v.ok, `should pass when explicitly allowed: ${v.reason}`);
  eq(v.sensitive, true, "still flagged for the trace");
});

await check("needs_value names the field, so Claude knows what to supply", async () => {
  const map = new Map([["e1", row({ role: "textbox", name: "Coupon code", type: "text" })]]);
  const v = validate(
    {
      operation: choice("TYPE_TEXT", 0.95),
      text_target: choice("e1", 0.95),
      sensitive: noul(0),
      value_key: choice("NONE", 0.9),
    },
    map,
    CFG,
    { allowSensitive: false, values: { other: "x" } },
  );
  eq(v.status, "needs_value", "status");
  assert(v.reason?.includes("Coupon code"), "names the field");
  assert(v.reason?.includes("textbox"), "names the role");
});

await check("BLOCKED from Jev is a clean stop, not an error", async () => {
  const v = validate({ operation: choice("BLOCKED", 0.8), sensitive: noul(0), satisfied: notYet }, new Map(), CFG, {
    allowSensitive: false,
    values: {},
  });
  eq(v.status, "blocked", "status");
});

await check("buildRequest never puts a ref in front of Jev", async () => {
  const obs = { url: "https://x.test", title: "T", excerpt: "e", rows: [] };
  const rows = [row({ ref: "ref_77", role: "button", name: "Go" })];
  const { state, questions, idMap } = buildRequest(obs, rows, { goal: "g", successCriteria: "s", values: {} });
  const sent = JSON.stringify({ state, questions });
  assert(!sent.includes("ref_77"), "a real ref leaked into the request");
  assert(sent.includes("e1"), "rows are addressed as eN");
  eq(idMap.get("e1")?.ref, "ref_77", "the mapping back is held locally");
});

await check("buildRequest omits the target question when there is nothing to target", async () => {
  // A Choice with no options is a malformed request; on an empty page the only
  // sensible answers are the targetless ones anyway.
  const { questions } = buildRequest({ url: "", title: "", excerpt: "", rows: [] }, [], {
    goal: "g",
    successCriteria: "s",
    values: {},
  });
  assert(!questions.click_target && !questions.text_target && !questions.select_target, "no target question");
  assert(questions.operation && questions.sensitive, "the rest still asked");
});

// --- the loop, end to end ----------------------------------------------------

function renderPage(rows: Row[]): string {
  return rows
    .map(
      (r) =>
        `${r.role}${r.name ? ` "${r.name}"` : ""} [${r.ref}]${r.href ? ` href="${r.href}"` : ""}${r.type ? ` type="${r.type}"` : ""}`,
    )
    .join("\n");
}

/**
 * A fake browser: enough of the observation tools to drive the loop.
 *
 * Serves jev_snapshot like a current extension; `legacy: true` makes it answer
 * like one that predates it, so the three-call fallback is driven instead.
 */
/** What the fake page holds; tests reach in and change it between steps. */
interface PageState {
  url: string;
  title: string;
  rows: Row[];
  truncated?: boolean;
  scroll?: ScrollState;
  staleRefs?: Set<unknown>;
  coveredRefs?: Set<unknown>;
  [key: string]: unknown;
}

/** A fake tool call: always a text result, so a test can edit it in place. */
type FakeCallTool = (name: string, args: ToolArgs) => Promise<{ content: Array<{ type: string; text?: string }> }>;

interface FakeBrowser {
  callTool: FakeCallTool;
  calls: Array<{ name: string; args: ToolArgs }>;
  state: PageState;
}

function fakeBrowser({
  url = "https://app.test/a",
  title = "A",
  rows = [],
  onClick,
  legacy = false,
}: {
  url?: string;
  title?: string;
  rows?: Row[];
  onClick?: (state: PageState, args: ToolArgs) => void;
  legacy?: boolean;
} = {}): FakeBrowser {
  const state: PageState = { url, title, rows };
  const calls: FakeBrowser["calls"] = [];
  const text = (t: string) => ({ content: [{ type: "text", text: t }] });
  const callTool: FakeCallTool = async (name, args) => {
    calls.push({ name, args });
    switch (name) {
      case "jev_snapshot":
        if (legacy) return text("Error: Unknown tool: jev_snapshot");
        return text(
          JSON.stringify({
            url: state.url,
            title: state.title,
            text: "page body text",
            truncated: Boolean(state.truncated),
            scroll: state.scroll ?? { y: 0, height: 800, viewport: 800 },
            rows: state.rows.map((r) => ({ inView: true, ...r })),
          }),
        );
      case "read_page":
        return text(renderPage(state.rows));
      case "get_page_text":
        return text("page body text");
      case "tabs_context_mcp":
        return text(
          JSON.stringify({ availableTabs: [{ tabId: 1, title: state.title, url: state.url }], tabGroupId: 1 }) +
            "\n\nprose\n",
        );
      case "jev_act":
        if (legacy) return text("Error: Unknown tool: jev_act");
        if (state.staleRefs?.has(args["ref"]))
          return text(`Error: stale: ${String(args["ref"])} is no longer on the page`);
        if (state.coveredRefs?.has(args["ref"]))
          return text(`Error: covered: ${String(args["ref"])} is covered by <div.menu>, and Escape did not clear it`);
        if (onClick) onClick(state, args);
        return text("ok");
      case "computer":
      case "form_input":
        if (onClick) onClick(state, args);
        return text("ok");
      case "navigate":
        state.url = String(args["url"]);
        return text("ok");
      default:
        return text("ok");
    }
  };
  return { callTool, calls, state };
}

/** A fake Jev: a scripted list of answer sets, with the last one repeating. */
/** The state a decision was asked about, as far as these tests read it. */
interface SeenState {
  history?: Array<{ operation: string; target: string; page_changed: boolean; value?: string }>;
  elements?: string[];
  defaults?: string;
  [key: string]: unknown;
}

type Scripted = Answers | ((state: SeenState, questions: JevQuestions) => Answers);

interface FakeClient extends JevClient {
  seen: Array<{ state: SeenState; questions: JevQuestions }>;
}

function fakeClient(script: Scripted[]): FakeClient {
  let i = 0;
  const seen: FakeClient["seen"] = [];
  return {
    decide: async (rawState, questions): Promise<DecideResult> => {
      const state = rawState as SeenState;
      seen.push({ state, questions });
      const answers = script[Math.min(i++, script.length - 1)] ?? {};
      return {
        answers: typeof answers === "function" ? answers(state, questions) : answers,
        ms: 5,
        usage: { cost: 0.00005 },
        model: null,
        raw: null,
      };
    },
    seen,
    totals: { requests: 0, cost_usd: 0, input_tokens: 0, budget_usd: 1, resolved_model: "typesafe/jev-1.13" },
  };
}

await check("a click then a confirmed DONE returns done with the steps taken", async () => {
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "link", name: "Invoices", href: "https://app.test/inv" })],
    onClick: (s) => {
      s.url = "https://app.test/inv/9";
      s.title = "Invoice 9";
      s.rows = [row({ ref: "ref_1", role: "button", name: "Download" })];
    },
  });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0.01), satisfied: notYet },
    { operation: choice("DONE", 0.95), sensitive: noul(0.01) },
    { satisfied: noul(0.95) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "open the latest invoice",
    success_criteria: "an invoice detail page is shown",
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(out.steps![0].operation, "CLICK", "first step");
  eq(out.steps![0].target_ref, "ref_1", "target recorded");
  eq(out.final_url, "https://app.test/inv/9", "final url");
  assert(
    (out.page_excerpt?.interactive?.length ?? 0) > 0,
    "an excerpt of the final page is returned so Claude need not re-read it",
  );
  assert(out.run_id, "a run id is returned");
});

await check("a trace lands on disk for the run", async () => {
  const before = fs.readdirSync(CFG.tracesDir).length;
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet }]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  const files = fs.readdirSync(CFG.tracesDir);
  eq(files.length, before + 1, "one new trace");
  const trace = JSON.parse(fs.readFileSync(path.join(CFG.tracesDir, `${out.run_id}.json`), "utf-8")) as {
    result: { status: string };
    steps: unknown[];
  };
  eq(trace.result.status, "blocked", "status recorded");
  assert(trace.steps.length >= 1, "the step that produced it is recorded");
});

await check("the sensitive gate stops BEFORE the browser is touched", async () => {
  // The important assertion is not the status, it is that no computer or
  // form_input call was ever made.
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Delete everything" })] });
  const client = fakeClient([
    { operation: choice("CLICK", 0.99), click_target: choice("e1", 0.99), sensitive: noul(0.99), satisfied: notYet },
  ]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "clean up", success_criteria: "done" });
  eq(out.status, "needs_help", "status");
  assert(
    !browser.calls.some((c) => ["computer", "form_input", "jev_act"].includes(c.name)),
    "an action was performed despite the gate",
  );
});

await check("needs_value stops without acting and says what is missing", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "textbox", name: "Search", type: "search" })] });
  const client = fakeClient([
    {
      operation: choice("TYPE_TEXT", 0.95),
      text_target: choice("e1", 0.95),
      sensitive: noul(0),
      value_key: choice("NONE", 0.9),
    },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "search",
    success_criteria: "results",
    values: { unrelated: "x" },
  });
  eq(out.status, "needs_value", "status");
  assert(out.reason?.includes("Search"), "names the field");
  assert(!browser.calls.some((c) => c.name === "form_input" || c.name === "jev_act"), "nothing was typed");
});

await check("a blocked domain sends nothing to the provider at all", async () => {
  // Domain gating has to happen before the decision, not after: the point is
  // that the page never reaches OpenRouter, not that we ignore the answer.
  const browser = fakeBrowser({
    url: "https://bank.test/x",
    rows: [row({ ref: "ref_1", role: "button", name: "Go" })],
  });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
  ]);
  const cfg = { ...CFG, blockedDomains: ["bank.test"] };
  const out = await navigate(browser.callTool, client, cfg, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "blocked", "status");
  eq(client.seen.length, 0, "no Jev request was made");
});

await check("an allowlist permits its own subdomains and refuses everything else", async () => {
  const cfg = { ...CFG, allowedDomains: ["app.test"] };
  const ok = fakeBrowser({ url: "https://sub.app.test/x", rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const okClient = fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet }]);
  eq(
    (await navigate(ok.callTool, okClient, cfg, { tabId: 1, goal: "g", success_criteria: "s" })).status,
    "blocked",
    "reached the decision (BLOCKED came from Jev)",
  );
  eq(okClient.seen.length, 1, "subdomain was allowed through");

  const no = fakeBrowser({ url: "https://other.test/x", rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const noClient = fakeClient([
    { operation: choice("CLICK", 0.9), click_target: choice("e1", 0.9), sensitive: noul(0), satisfied: notYet },
  ]);
  await navigate(no.callTool, noClient, cfg, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(noClient.seen.length, 0, "an off-list domain never reached the provider");
});

await check("navigatesAway distinguishes a real navigation from an anchor", async () => {
  const here = "https://x.test/wiki/Cephalopod";
  assert(navigatesAway("https://x.test/wiki/Nautilus", here), "different path");
  assert(navigatesAway("https://other.test/a", here), "different origin");
  assert(navigatesAway("/wiki/Nautilus", here), "relative path");
  assert(!navigatesAway("#References", here), "same-page fragment does not navigate");
  assert(!navigatesAway("", here), "no href");
});

await check("a link click waits for its navigation, not for the dropdown closing", async () => {
  // The bug: clicking a link inside a dropdown closes the dropdown, which
  // changes the signature at once while the navigation is still in flight. The
  // loop then decided on a page that was about to be replaced — twice in one
  // audited run — and the next action could have landed on the incoming page.
  let pending = 0;
  const browser = fakeBrowser({
    url: "https://app.test/talk",
    rows: [
      row({ ref: "ref_1", role: "button", name: "Tools" }),
      row({ ref: "ref_2", role: "link", name: "What links here", href: "https://app.test/whatlinkshere" }),
    ],
    onClick: (st) => {
      // The dropdown closes immediately; the navigation takes a couple of reads.
      st.rows = [row({ ref: "ref_1", role: "button", name: "Tools" })];
      pending = 2;
    },
  });
  const inner = browser.callTool;
  const callTool: FakeCallTool = async (name, args) => {
    if (name === "jev_snapshot" && pending > 0 && --pending === 0) {
      browser.state.url = "https://app.test/whatlinkshere";
      browser.state.title = "What links here";
    }
    return inner(name, args);
  };
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e2", 0.95), sensitive: noul(0), satisfied: notYet },
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  const out = await navigate(callTool, client, CFG, {
    tabId: 1,
    goal: "open what links here",
    success_criteria: "the page is open",
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(out.final_url, "https://app.test/whatlinkshere", "waited for the navigation");
  eq(out.steps!.length, 1, "no wasted decision on the outgoing page");
});

await check("a truncated observation is named when the run does not finish", async () => {
  // read_page has its own character cap, and an Octopus article blows past it
  // at 1,412 rows. Rows lost there never reach the prefilter, so "nothing here
  // can help" is the wrong conclusion and has to say why it might be wrong.
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })], legacy: true });
  const inner = browser.callTool;
  const callTool: FakeCallTool = async (name, args) => {
    const r = await inner(name, args);
    if (name === "read_page") r.content[0].text += "\n... (truncated)";
    return r;
  };
  const client = fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet }]);
  const out = await navigate(callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "blocked", "status");
  assert(out.reason?.includes("too large to read in full"), `reason should name truncation: ${out.reason}`);
});

await check("a truncated snapshot is named too", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  browser.state.truncated = true;
  const client = fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet }]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  assert(out.reason?.includes("too large to read in full"), `reason should name truncation: ${out.reason}`);
});

await check("one snapshot call per observation, and none of the old three", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet }]);
  await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  const names = browser.calls.map((c) => c.name);
  eq(names.filter((n) => n === "jev_snapshot").length, 1, "one snapshot");
  assert(
    !names.some((n) => ["read_page", "get_page_text", "tabs_context_mcp"].includes(n)),
    `old tools called: ${names.join(",")}`,
  );
});

await check("an extension without jev_snapshot falls back once, then stops asking", async () => {
  // An unreloaded extension answers Unknown tool. The loop must still work,
  // and must not spend a failed round trip on every observation after that.
  let clicks = 0;
  const browser = fakeBrowser({
    legacy: true,
    rows: [row({ ref: "ref_1", role: "link", name: "Go", href: "https://app.test/next" })],
    onClick: (s) => {
      clicks++;
      s.url = `https://app.test/${clicks}`;
    },
  });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
    { operation: choice("DONE", 0.95), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(browser.calls.filter((c) => c.name === "jev_snapshot").length, 1, "asked once");
  assert(browser.calls.filter((c) => c.name === "read_page").length >= 2, "then used the old path");
});

await check("each action waits on its own event, once, without sleeping", async () => {
  // A button click that changes the page needs two frames, not a 300 ms poll.
  const browser = fakeBrowser({
    rows: [
      row({ ref: "ref_1", role: "button", name: "Open panel" }),
      row({ ref: "ref_2", role: "link", name: "Next page", href: "https://app.test/next" }),
    ],
    onClick: (s, args) => {
      if (args.ref === "ref_1") s.rows = [...s.rows, row({ ref: "ref_3", role: "button", name: "Panel item" })];
      else s.url = "https://app.test/next";
    },
  });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
    { operation: choice("CLICK", 0.95), click_target: choice("e2", 0.95), sensitive: noul(0), satisfied: notYet },
    { operation: choice("DONE", 0.95), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "done", `reason: ${out.reason}`);
  const settles = browser.calls.filter((c) => c.name === "jev_settle").map((c) => c.args.expect);
  eq(settles.join(), "dom,navigation", "a frame settle for the button, a URL wait for the link");
  eq(
    browser.calls.find((c) => c.name === "jev_settle" && c.args.expect === "navigation")?.args.fromUrl,
    "https://app.test/a",
    "from the page it left",
  );
  assert((out.usage!.settle_ms ?? Infinity) < 100, `no real sleeping on the happy path: ${out.usage!.settle_ms} ms`);
});

await check("typing into a combobox waits for its suggestions", async () => {
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_7", role: "combobox", name: "Tag filter", type: "text" })],
    onClick: (s, args) => {
      if (args.value) s.rows = [{ ...s.rows[0], value: textOf(args.value) }];
    },
  });
  const client = fakeClient([
    {
      operation: choice("TYPE_TEXT", 0.95),
      text_target: choice("e1", 0.95),
      value_key: choice("tag", 0.95),
      sensitive: noul(0),
      satisfied: notYet,
    },
    { operation: choice("DONE", 0.95), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "g",
    success_criteria: "s",
    values: { tag: "mobile edit" },
  });
  const settle = browser.calls.find((c) => c.name === "jev_settle");
  eq(settle?.args.expect, "combobox", "expect");
  eq(settle?.args.ref, "ref_7", "for that field");
});

await check("WAIT waits for the page to change, or the old second on an old extension", async () => {
  for (const legacy of [false, true]) {
    const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })], legacy });
    const client = fakeClient([
      { operation: choice("WAIT", 0.95), sensitive: noul(0), satisfied: notYet },
      { operation: choice("DONE", 0.95), sensitive: noul(0), satisfied: noul(0.95) },
    ]);
    await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
    const waits = browser.calls.filter(
      (c) =>
        (c.name === "jev_settle" && c.args.expect === "change") || (c.name === "computer" && c.args.action === "wait"),
    );
    if (legacy) eq(waits[0]?.name, "computer", "old extension: computer wait");
    else
      eq(
        `${waits[0]?.name}:${JSON.stringify(waits[0]?.args.timeoutMs)}`,
        "jev_settle:5000",
        "current extension: jev_settle until the page changes, up to 5 s",
      );
  }
});

await check("a target that went stale is re-found by role and name, then acted on", async () => {
  // jev_act refuses a ref that no longer names what Jev chose. The loop
  // re-observes and retries once on the row that now carries that label.
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "button", name: "Apply" })],
    onClick: (s) => {
      s.url = "https://app.test/applied";
    },
  });
  browser.state.staleRefs = new Set(["ref_1"]);
  const inner = browser.callTool;
  let acts = 0;
  const callTool: FakeCallTool = async (name, args) => {
    // The first refusal re-renders the page with a fresh ref for the button.
    if (name === "jev_act" && ++acts === 2)
      assert(args.ref === "ref_9", `retried on the new ref, got ${JSON.stringify(args.ref)}`);
    const r = await inner(name, args);
    if (name === "jev_act" && acts === 1) browser.state.rows = [row({ ref: "ref_9", role: "button", name: "Apply" })];
    return r;
  };
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
    { operation: choice("DONE", 0.95), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  const out = await navigate(callTool, client, CFG, { tabId: 1, goal: "apply", success_criteria: "applied" });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(acts, 2, "refused once, then done");
});

await check("a stale target whose name only lost its access-key hint is still re-found", async () => {
  // MediaWiki rewrites "[t]" to "[ctrl-option-t]" after load. The retry used
  // to match names exactly, so the renamed link was never found again.
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "link", name: "Discuss improvements [t]" })],
    onClick: (s) => {
      s.url = "https://app.test/talk";
    },
  });
  browser.state.staleRefs = new Set(["ref_1"]);
  const inner = browser.callTool;
  let acts = 0;
  const callTool: FakeCallTool = async (name, args) => {
    if (name === "jev_act") acts++;
    const r = await inner(name, args);
    if (name === "jev_act" && acts === 1)
      browser.state.rows = [row({ ref: "ref_9", role: "link", name: "Discuss improvements [ctrl-option-t]" })];
    return r;
  };
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
    { operation: choice("DONE", 0.95), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  const out = await navigate(callTool, client, CFG, { tabId: 1, goal: "open talk", success_criteria: "talk page" });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(acts, 2, "refused once, then retried on the renamed link");
});

await check("a covered target is handed back, not retried", async () => {
  // Re-finding a covered control by name returns the same covered control.
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Tools" })] });
  browser.state.coveredRefs = new Set(["ref_1"]);
  let acts = 0;
  const inner = browser.callTool;
  const callTool: FakeCallTool = async (name, args) => {
    if (name === "jev_act") acts++;
    return inner(name, args);
  };
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
  ]);
  const out = await navigate(callTool, client, CFG, { tabId: 1, goal: "open tools", success_criteria: "tools open" });
  eq(out.status, "needs_help", "status");
  assert(out.reason?.includes("covered"), `reason: ${out.reason}`);
  eq(acts, 1, "one attempt only");
});

await check("jev_decide returns a short distribution in one id space", async () => {
  // It used to return ~240 entries of almost entirely zero, keyed eN while
  // target_ref was ref_N — so the two halves of the same answer could not be
  // lined up.
  const rows = Array.from({ length: 12 }, (_, i) => row({ ref: `ref_${i}`, role: "button", name: `B${i}` }));
  const browser = fakeBrowser({ rows });
  const probs: Record<string, number> = {};
  rows.forEach((_, i) => {
    probs[`e${i + 1}`] = i === 0 ? 0.7 : 0.3 / 11;
  });
  const client = fakeClient([
    {
      operation: choice("CLICK", 0.9),
      click_target: { type: "choice", choice: "e1", confidence: 0.7, probabilities: probs },
      sensitive: noul(0.02),
      satisfied: notYet,
    },
  ]);
  const out = await decideOnce(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  assert(out.probabilities!.target.length <= 5, `top 5 only, got ${out.probabilities!.target.length}`);
  eq(out.probabilities!.target[0].ref, "ref_0", "keyed by ref, same space as target_ref");
  eq(out.probabilities!.target[0].ref, out.target_ref, "and it agrees with the chosen target");
  assert(out.probabilities!.target[0].label, "carries a readable label");
});

await check("a submit is judged on the URL, not on the text it just typed", async () => {
  // The bug this pins: TYPE_AND_SUBMIT changes the page signature the instant
  // the value lands, so a signature-based settle check reads "the page moved"
  // while the navigation is still in flight. The loop then decided from the old
  // page and re-typed forever. Judged on the URL, it waits for the real effect.
  let pending = 0;
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "searchbox", name: "Search", type: "search" })],
    onClick: (st) => {
      // The value lands at once; the navigation takes a couple of reads.
      st.rows = [row({ ref: "ref_1", role: "searchbox", name: "Search", type: "search", value: "blink" })];
      pending = 2;
    },
  });
  const realRead = browser.callTool;
  const callTool: FakeCallTool = async (name, args) => {
    if (name === "jev_snapshot" && pending > 0 && --pending === 0) {
      browser.state.url = "https://app.test/results";
      browser.state.title = "Results";
    }
    return realRead(name, args);
  };
  const client = fakeClient([
    {
      operation: choice("TYPE_AND_SUBMIT", 0.95),
      text_target: choice("e1", 0.95),
      value_key: choice("q", 1),
      sensitive: noul(0),
      satisfied: notYet,
    },
    {
      operation: choice("TYPE_AND_SUBMIT", 0.95),
      text_target: choice("e1", 0.95),
      value_key: choice("q", 1),
      sensitive: noul(0),
      satisfied: noul(0.95),
    },
  ]);
  const out = await navigate(callTool, client, CFG, {
    tabId: 1,
    goal: "search",
    success_criteria: "results are shown",
    values: { q: "blink" },
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(out.steps!.length, 1, "one step, not a retype loop");
  eq(out.final_url, "https://app.test/results", "waited for the navigation to land");
});

await check("two steps that change nothing hand back rather than grinding to the cap", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([
    { operation: choice("SCROLL_DOWN", 0.9), sensitive: noul(0), satisfied: notYet },
    { operation: choice("SCROLL_UP", 0.9), sensitive: noul(0), satisfied: notYet },
    { operation: choice("SCROLL_DOWN", 0.9), sensitive: noul(0), satisfied: notYet },
  ]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "needs_help", "status");
  assert(out.reason?.includes("unchanged"), `reason should name the cause: ${out.reason}`);
  assert(out.steps!.length < CFG.maxSteps, "bailed early");
});

await check("an oscillation is caught even though the page changes every step", async () => {
  // The case the no-progress check cannot see: clicking a toggle opens a
  // dropdown, clicking it again closes it. The page differs on every single
  // step, so no two consecutive observations match — but the run keeps
  // returning to the same state and is going nowhere.
  let open = false;
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "button", name: "Filter" })],
    onClick: (s) => {
      open = !open;
      s.title = open ? "Filter open" : "Filter closed";
      s.rows = open
        ? [
            row({ ref: "ref_1", role: "button", name: "Filter" }),
            row({ ref: "ref_2", role: "option", name: "Last 30 days" }),
          ]
        : [row({ ref: "ref_1", role: "button", name: "Filter" })];
    },
  });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
  ]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "needs_help", `status (reason: ${out.reason})`);
  assert(out.reason?.includes("three times"), `reason: ${out.reason}`);
  assert(out.steps!.length < CFG.maxSteps, "bailed before the cap");
});

await check("a repeated action that keeps working is not mistaken for a loop", async () => {
  // Paging through a list re-clicks "Next" at the same ref on every page,
  // because the renderer restarts refs at ref_1 on each load. The action key is
  // identical every time and the loop is working perfectly, so only repetition
  // that changes nothing may trip the guard.
  let n = 0;
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "button", name: "Next" })],
    onClick: (s) => {
      s.url = `https://app.test/page/${++n}`;
      s.title = `Page ${n}`;
    },
  });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "g",
    success_criteria: "s",
    max_steps: 5,
  });
  eq(out.status, "limit_reached", `should run to the cap, not bail: ${out.reason}`);
  eq(out.steps!.length, 5, "all five steps ran");
});

await check("max_steps is honoured and cannot be raised past the config cap", async () => {
  let n = 0;
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "button", name: "Next" })],
    onClick: (s) => {
      s.url = `https://app.test/${++n}`;
    },
  });
  const client = fakeClient([
    () => ({
      operation: choice("CLICK", 0.95),
      click_target: choice("e1", 0.95),
      sensitive: noul(0),
      satisfied: notYet,
    }),
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "g",
    success_criteria: "s",
    max_steps: 3,
  });
  eq(out.status, "limit_reached", "status");
  eq(out.steps!.length, 3, "exactly three steps");

  const out2 = await navigate(
    browser.callTool,
    fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet }]),
    { ...CFG, maxSteps: 2 },
    { tabId: 1, goal: "g", success_criteria: "s", max_steps: 999 },
  );
  assert(out2.status === "blocked", "the caller cannot raise the ceiling");
});

await check("a DONE the page does not support keeps going instead of being believed", async () => {
  // The case success_criteria exists for: the model claiming victory. DONE is
  // now only a signal — `satisfied`, asked in the same request, is the gate.
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([{ operation: choice("DONE", 0.95), sensitive: noul(0), satisfied: noul(0.05) }]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "g",
    success_criteria: "an invoice is shown",
  });
  eq(out.status, "needs_help", "status");
  assert(out.reason?.includes("DONE"), `reason: ${out.reason}`);
  assert(!browser.calls.some((c) => c.name === "computer"), "nothing was clicked on the strength of the claim");
});

await check("the success check ends the run in the same request that spots it", async () => {
  // Completion used to cost two extra round trips: a step where Jev chose DONE,
  // then a separate confirmation request. Both are gone — `satisfied` rides
  // along with the step's other questions, which are evaluated in parallel.
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "link", name: "Invoices", href: "https://app.test/inv" })],
    onClick: (s) => {
      s.url = "https://app.test/inv/9";
      s.title = "Invoice 9";
    },
  });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "open the invoice",
    success_criteria: "an invoice detail page is shown",
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(out.steps!.length, 1, "one real action, no DONE step");
  eq(client.seen.length, 2, "two Jev requests: the action and the one that saw completion");
});

await check("a goal already met on arrival finishes without touching the page", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([
    { operation: choice("CLICK", 0.9), click_target: choice("e1", 0.9), sensitive: noul(0), satisfied: noul(0.97) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "done", "status");
  eq(out.steps!.length, 0, "no steps taken");
  assert(!browser.calls.some((c) => c.name === "computer" || c.name === "form_input"), "nothing was done");
});

await check("one observation per step in the steady state", async () => {
  // The loop used to observe at the top of the step and again after acting,
  // discarding the second. The post-action observation is now carried forward.
  let n = 0;
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "button", name: "Next" })],
    onClick: (s) => {
      s.url = `https://app.test/${++n}`;
    },
  });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "g",
    success_criteria: "s",
    max_steps: 4,
  });
  eq(out.steps!.length, 4, "four steps");
  const reads = browser.calls.filter((c) => c.name === "jev_snapshot").length;
  // One to prime the first step, then one after each action.
  eq(reads, 5, `expected 5 snapshots for 4 steps, got ${reads}`);
});

// --- subgoal chaining -------------------------------------------------------

await check("normalizeSubgoals accepts either shape", async () => {
  eq(normalizeSubgoals({ goal: "g", success_criteria: "s" }).length, 1, "a bare goal is a list of one");
  const many = normalizeSubgoals({
    subgoals: [
      { goal: "a", success_criteria: "x" },
      { goal: "b", success_criteria: "y" },
    ],
  });
  eq(many.length, 2, "a list stays a list");
  eq(many[1].successCriteria, "y", "per-leg criteria");
});

await check("subgoals run in sequence and each starts where the last one left off", async () => {
  let clicks = 0;
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "link", name: "Go", href: "https://app.test/1" })],
    onClick: (s) => {
      clicks++;
      s.url = `https://app.test/${clicks}`;
      s.title = `Page ${clicks}`;
    },
  });
  // Each leg: act once, then report satisfied.
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: noul(0.95) },
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    subgoals: [
      { goal: "first leg", success_criteria: "page 1" },
      { goal: "second leg", success_criteria: "page 2" },
    ],
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(out.subgoals!.length, 2, "both legs reported");
  eq(out.subgoals![0].status, "done", "first leg");
  eq(out.subgoals![1].status, "done", "second leg");
  eq(out.steps!.length, 2, "flat step list spans both legs");
  eq(out.steps![1].i, 2, "step numbering is continuous across legs");
});

await check("a finished leg hands the next leg its first action, saving a request", async () => {
  // The audited chain spent 7 of 17 requests on nothing but noticing a leg had
  // finished. Now the request that notices also decides the next leg's first
  // action, on the same page.
  let clicks = 0;
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "link", name: "Go", href: "https://app.test/1" })],
    onClick: (s) => {
      clicks++;
      s.url = `https://app.test/${clicks}`;
      s.title = `Page ${clicks}`;
    },
  });
  const client = fakeClient([
    {
      operation: choice("CLICK", 0.95),
      click_target: choice("e1", 0.95),
      sensitive: noul(0),
      satisfied: notYet,
      next_operation: choice("CLICK", 0.2),
      next_click_target: choice("e1", 0.95),
      next_sensitive: noul(0),
      next_satisfied: notYet,
    },
    {
      operation: choice("DONE", 0.95),
      sensitive: noul(0),
      satisfied: noul(0.95),
      next_operation: choice("CLICK", 0.95),
      next_click_target: choice("e1", 0.95),
      next_sensitive: noul(0),
      next_satisfied: notYet,
    },
    { operation: choice("DONE", 0.95), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    subgoals: [
      { goal: "first leg", success_criteria: "page 1" },
      { goal: "second leg", success_criteria: "page 2" },
    ],
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(client.seen.length, 3, "3 requests, not 4");
  eq(clicks, 2, "both legs acted");
  eq(out.subgoals![1].steps.length, 1, "the carried action is the second leg's step");
  assert(!client.seen[0].questions.next_operation, "not before the leg has acted");
  assert(client.seen[1].questions.next_operation, "a non-final leg asks the next leg's questions once it has acted");
  assert(client.seen[1].questions.next_operation.instructions.includes("second leg"), "naming the next goal");
  assert(!client.seen[2].questions.next_operation, "the last leg has no next leg to ask about");
});

await check("a carried action that fails the gate is re-asked, never executed", async () => {
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "button", name: "Proceed" })],
    onClick: (s) => {
      s.url = "https://app.test/b";
    },
  });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
    {
      operation: choice("DONE", 0.95),
      sensitive: noul(0),
      satisfied: noul(0.95),
      next_operation: choice("CLICK", 0.99),
      next_click_target: choice("e1", 0.99),
      next_sensitive: noul(0.99),
      next_satisfied: notYet,
    },
    { operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    subgoals: [
      { goal: "a", success_criteria: "x" },
      { goal: "b", success_criteria: "y" },
    ],
  });
  eq(client.seen.length, 3, "the second leg decided afresh");
  eq(out.status, "blocked", "and its own answer stands");
  eq(
    browser.calls.filter((c) => c.name === "jev_act").length,
    1,
    "only the first leg's click ran; the refused carried click never did",
  );
});

await check("a next leg already satisfied on arrival finishes without a request", async () => {
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "button", name: "Go" })],
    onClick: (s) => {
      s.url = "https://app.test/b";
    },
  });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
    {
      operation: choice("DONE", 0.95),
      sensitive: noul(0),
      satisfied: noul(0.95),
      next_operation: choice("DONE", 0.95),
      next_sensitive: noul(0),
      next_satisfied: noul(0.97),
    },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    subgoals: [
      { goal: "a", success_criteria: "x" },
      { goal: "b", success_criteria: "y" },
    ],
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(client.seen.length, 2, "the request that finished leg one also finished leg two");
});

await check("a failing leg stops the run and names itself, and later legs never run", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Delete everything" })] });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: noul(0.95) },
    { operation: choice("CLICK", 0.99), click_target: choice("e1", 0.99), sensitive: noul(0.99), satisfied: notYet },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    subgoals: [
      { goal: "harmless first", success_criteria: "a" },
      { goal: "dangerous second", success_criteria: "b" },
      { goal: "never reached", success_criteria: "c" },
    ],
  });
  eq(out.status, "needs_help", "status comes from the leg that stopped");
  eq(out.subgoals!.length, 2, "the third leg never ran");
  assert(out.reason?.includes("Subgoal 2 of 3"), `reason should locate the failure: ${out.reason}`);
  assert(out.reason?.includes("dangerous second"), "and name it");
});

await check("max_steps bounds each subgoal, not the whole call", async () => {
  let n = 0;
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "button", name: "Next" })],
    onClick: (s) => {
      s.url = `https://app.test/${++n}`;
    },
  });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    max_steps: 2,
    subgoals: [
      { goal: "a", success_criteria: "x" },
      { goal: "b", success_criteria: "y" },
    ],
  });
  // The first leg exhausts its own 2 steps and stops the run there.
  eq(out.subgoals![0].status, "limit_reached", "first leg hit its own cap");
  eq(out.subgoals![0].steps.length, 2, "two steps in that leg");
  eq(out.subgoals!.length, 1, "the run stops at the first leg that does not finish");
});

await check("final_check catches a setting a later step undid", async () => {
  // The failure a per-step check structurally cannot see: every leg was true
  // when it ran, and a later leg quietly reset an earlier one. The audited app
  // does exactly this — turning on "Group by week" resets the chart style.
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Toggle" })] });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: noul(0.95) },
    { verified: noul(0.05) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "set the style",
    success_criteria: "the style is Paragraph",
    final_check: "every section still has the style it was given",
  });
  eq(out.status, "needs_help", "the run must not report done");
  assert(out.reason?.includes("final check"), `reason: ${out.reason}`);
  assert(out.reason?.includes("undone"), "and it should say what probably happened");
});

await check("final_check holding leaves the run done, and costs one request", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Toggle" })] });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: noul(0.95) },
    { verified: noul(0.96) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "g",
    success_criteria: "s",
    final_check: "everything is in place",
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(client.seen.length, 2, "the step, plus one verification");
});

await check("no final_check means no extra request", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Toggle" })] });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "done", "status");
  eq(client.seen.length, 1, "opt-in, so nothing extra is spent");
});

await check("usage splits Jev time from browser time", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet }]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  assert(typeof out.usage!.jev_ms === "number", "jev_ms present");
  assert(typeof out.usage!.browser_ms === "number", "browser_ms present");
});

await check("start_url navigates before the first decision, and only Claude can", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet }]);
  await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "g",
    success_criteria: "s",
    start_url: "https://app.test/start",
  });
  const navs = browser.calls.filter((c) => c.name === "navigate");
  eq(navs.length, 1, "exactly one navigation");
  eq(navs[0].args.url, "https://app.test/start", "to the requested url");
  assert(browser.calls.indexOf(navs[0]) === 0, "before any observation");
});

await check("a browser error stops the run instead of deciding on a blank page", async () => {
  const callTool: FakeCallTool = async (name) =>
    name === "read_page"
      ? { content: [{ type: "text", text: "Error: no browser bridge" }] }
      : { content: [{ type: "text", text: "{}" }] };
  const client = fakeClient([{ operation: choice("CLICK", 0.9), sensitive: noul(0), satisfied: notYet }]);
  const out = await navigate(callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "blocked", "status");
  eq(client.seen.length, 0, "no decision was attempted");
});

await check("jev_decide proposes without acting", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Search" })] });
  const client = fakeClient([
    { operation: choice("CLICK", 0.9), click_target: choice("e1", 0.88), sensitive: noul(0.02), satisfied: notYet },
  ]);
  const out = await decideOnce(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "proposed", "status");
  eq(out.operation, "CLICK", "operation");
  eq(out.target_ref, "ref_1", "target");
  assert(out.probabilities!.operation, "the distribution is returned for inspection");
  assert(!browser.calls.some((c) => c.name === "computer" || c.name === "form_input"), "nothing was executed");
});

// --- staying with Jev: demotion, recovery, skipping ---------------------------

await check("TYPE_AND_SUBMIT on a combobox is demoted to TYPE_TEXT, not handed back", async () => {
  // The audited 8-leg chain died on its last leg exactly here: typing into a
  // tag filter was right, the blind Enter was not.
  const map = new Map([["e1", row({ ref: "ref_4", role: "combobox", name: "Tag filter:" })]]);
  const answers = {
    operation: {
      type: "choice",
      choice: "TYPE_AND_SUBMIT",
      confidence: 0.5,
      probabilities: { TYPE_AND_SUBMIT: 0.5, TYPE_TEXT: 0.4, CLICK: 0.1 },
    },
    text_target: choice("e1", 0.95),
    value_key: choice("tag", 1),
    sensitive: noul(0),
    satisfied: notYet,
  };
  const v = validate(answers, map, CFG, { allowSensitive: false, values: { tag: "mobile edit" } });
  assert(v.ok, `should pass: ${v.reason}`);
  eq(v.operation, "TYPE_TEXT", "demoted operation");
  eq(v.demotedFrom, "TYPE_AND_SUBMIT", "records what Jev asked for");
  assert(Math.abs(v.confidence - 0.9) < 1e-9, `mass of both operations counts: ${v.confidence}`);
});

await check("an operation with no lesser form is still refused", async () => {
  const map = new Map([["e1", row({ role: "link", name: "Docs", href: "https://x.test" })]]);
  const v = validate(
    { operation: choice("PRESS_ENTER", 0.95), text_target: choice("e1", 0.95), sensitive: noul(0) },
    map,
    CFG,
    { allowSensitive: false, values: {} },
  );
  eq(v.status, "needs_help", "status");
});

await check("a failed action is re-decided on a fresh look, and the run carries on", async () => {
  const browser = fakeBrowser({
    rows: [
      row({ ref: "ref_1", role: "button", name: "Apply" }),
      row({ ref: "ref_2", role: "button", name: "Apply filters" }),
    ],
    onClick: (s) => {
      s.url = "https://app.test/applied";
    },
  });
  const inner = browser.callTool;
  const callTool: FakeCallTool = async (name, args) =>
    name === "jev_act" && args.ref === "ref_1"
      ? { content: [{ type: "text", text: "Error: element is disabled" }] }
      : inner(name, args);
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
    { operation: choice("CLICK", 0.95), click_target: choice("e2", 0.95), sensitive: noul(0), satisfied: notYet },
    { operation: choice("DONE", 0.95), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  const out = await navigate(callTool, client, CFG, { tabId: 1, goal: "apply", success_criteria: "applied" });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(out.steps!.length, 1, "only the action that worked is a step");
  eq(out.subgoals![0].recovered?.length, 1, "the recovery is reported");
});

await check("the same failed action chosen again hands back instead of retrying", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Apply" })] });
  let acts = 0;
  const inner = browser.callTool;
  const callTool: FakeCallTool = async (name, args) => {
    if (name === "jev_act") {
      acts++;
      return { content: [{ type: "text", text: "Error: element is disabled" }] };
    }
    return inner(name, args);
  };
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
  ]);
  const out = await navigate(callTool, client, CFG, { tabId: 1, goal: "apply", success_criteria: "applied" });
  eq(out.status, "needs_help", "status");
  assert(out.reason?.includes("disabled"), `names the original error: ${out.reason}`);
  eq(acts, 1, "tried once");
});

await check("recoveries are bounded per subgoal", async () => {
  // Every button fails; a fresh decision picks a new one each time.
  const rows = Array.from({ length: 6 }, (_, k) => row({ ref: `ref_${k + 1}`, role: "button", name: `B${k + 1}` }));
  const browser = fakeBrowser({ rows });
  let acts = 0;
  const inner = browser.callTool;
  const callTool: FakeCallTool = async (name, args) => {
    if (name === "jev_act") {
      acts++;
      return { content: [{ type: "text", text: "Error: element is disabled" }] };
    }
    return inner(name, args);
  };
  let k = 0;
  const client = fakeClient([
    () => ({
      operation: choice("CLICK", 0.95),
      click_target: choice(`e${++k}`, 0.95),
      sensitive: noul(0),
      satisfied: notYet,
    }),
  ]);
  const out = await navigate(callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "needs_help", "status");
  eq(acts, 3, "the first failure plus two recoveries");
});

await check("a slow page gets one long wait before it counts as no progress", async () => {
  // An SPA that updates after a fetch looks dead inside the normal window.
  let n = 0;
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Load more" })] });
  const inner = browser.callTool;
  const callTool: FakeCallTool = async (name, args) => {
    if (name === "jev_settle" && args.timeoutMs === 1500) browser.state.title = `Loaded ${++n}`;
    return inner(name, args);
  };
  const client = fakeClient([
    { operation: choice("SCROLL_DOWN", 0.9), sensitive: noul(0), satisfied: notYet },
    { operation: choice("SCROLL_UP", 0.9), sensitive: noul(0), satisfied: notYet },
    { operation: choice("SCROLL_DOWN", 0.9), sensitive: noul(0), satisfied: notYet },
    { operation: choice("WAIT", 0.9), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  const out = await navigate(callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(out.subgoals![0].recovered?.length, 1, "the long wait is reported");
});

await check("an optional leg that fails is skipped and the next leg runs", async () => {
  const browser = fakeBrowser({
    rows: [
      row({ ref: "ref_1", role: "button", name: "Delete everything" }),
      row({ ref: "ref_2", role: "link", name: "Next", href: "https://app.test/next" }),
    ],
  });
  const client = fakeClient([
    { operation: choice("CLICK", 0.99), click_target: choice("e1", 0.99), sensitive: noul(0.99), satisfied: notYet },
    { operation: choice("DONE", 0.9), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    subgoals: [
      { goal: "dismiss the banner", success_criteria: "no banner", optional: true },
      { goal: "carry on", success_criteria: "b" },
    ],
  });
  eq(out.status, "partial", `reason: ${out.reason}`);
  eq(out.subgoals!.length, 2, "both legs ran");
  eq(out.subgoals![0].skipped, true, "the first is marked skipped");
  eq(out.subgoals![1].status, "done", "the second finished");
  assert(
    out.reason?.includes("1 of 2") && out.reason?.includes("dismiss the banner"),
    `reason lists what is owed: ${out.reason}`,
  );
});

await check("continue_on_failure makes every leg skippable, and final_check is not run on a partial", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([
    { operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet },
    { operation: choice("DONE", 0.9), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    continue_on_failure: true,
    final_check: "everything",
    subgoals: [
      { goal: "a", success_criteria: "x" },
      { goal: "b", success_criteria: "y" },
    ],
  });
  eq(out.status, "partial", `reason: ${out.reason}`);
  eq(client.seen.length, 2, "no final check request");
});

await check("a leg marked optional: false still stops a continue_on_failure run", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet }]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    continue_on_failure: true,
    subgoals: [
      { goal: "a", success_criteria: "x", optional: false },
      { goal: "b", success_criteria: "y" },
    ],
  });
  eq(out.status, "blocked", "status");
  eq(out.subgoals!.length, 1, "later legs never ran");
});

await check("running out of time is never skipped", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([{ operation: choice("DONE", 0.9), sensitive: noul(0), satisfied: noul(0.95) }]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    continue_on_failure: true,
    max_ms: -1,
    subgoals: [
      { goal: "a", success_criteria: "x" },
      { goal: "b", success_criteria: "y" },
    ],
  });
  eq(out.status, "limit_reached", "status");
  eq(out.subgoals!.length, 1, "stopped at the first leg");
});

await check("when every leg is skipped the run reports the first failure, not partial", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet }]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    continue_on_failure: true,
    subgoals: [
      { goal: "a", success_criteria: "x" },
      { goal: "b", success_criteria: "y" },
    ],
  });
  eq(out.status, "blocked", "status");
  assert(out.reason?.startsWith("No subgoal finished"), `reason: ${out.reason}`);
});

// --- the URL is checked, not read ------------------------------------------------

await check("urlContradicts checks key=value criteria against the real URL", async () => {
  const c = "The revision history is shown filtered with tagfilter=mobile edit in the URL";
  assert(
    urlContradicts(c, "https://w.test/index.php?title=N&action=history")?.includes("no tagfilter"),
    "missing param is a contradiction",
  );
  eq(
    urlContradicts(c, "https://w.test/index.php?title=N&tagfilter=mobile+edit&action=history"),
    null,
    "present param passes",
  );
  assert(
    urlContradicts("The URL contains action=info", "https://w.test/?action=history")?.includes("action=history"),
    "wrong value is a contradiction",
  );
  eq(urlContradicts("The revision history view is open", "https://w.test/"), null, "prose criteria are left to Jev");
  eq(
    urlContradicts("a=b is selected in the form", "https://w.test/"),
    null,
    "key=value that is not about the URL is left alone",
  );
});

await check("a satisfied answer the URL contradicts does not finish the leg", async () => {
  // Real case: Jev said the tag filter was applied on a URL with no tagfilter,
  // and the leg ended without clicking Show revisions.
  const browser = fakeBrowser({
    url: "https://w.test/index.php?title=N&action=history",
    rows: [row({ ref: "ref_1", role: "button", name: "Show revisions" })],
    onClick: (s) => {
      s.url = "https://w.test/index.php?title=N&tagfilter=mobile+edit&action=history";
    },
  });
  const client = fakeClient([
    { operation: choice("CLICK", 0.9), click_target: choice("e1", 0.9), sensitive: noul(0), satisfied: noul(0.95) },
    { operation: choice("DONE", 0.9), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "apply the filter",
    success_criteria: "tagfilter=mobile edit in the URL",
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(out.steps!.length, 1, "it clicked instead of believing the first answer");
  eq(out.final_url?.includes("tagfilter"), true, "and the filter landed");
});

await check("a carried 'next leg already satisfied' the URL contradicts is not trusted", async () => {
  const browser = fakeBrowser({
    url: "https://w.test/index.php?action=history",
    rows: [
      row({ ref: "ref_1", role: "button", name: "Expand" }),
      row({ ref: "ref_2", role: "button", name: "Show revisions" }),
    ],
    onClick: (s, a) => {
      if (a.ref === "ref_1") s.title = "expanded";
      if (a.ref === "ref_2") s.url = "https://w.test/index.php?tagfilter=mobile+edit&action=history";
    },
  });
  const client = fakeClient([
    { operation: choice("CLICK", 0.9), click_target: choice("e1", 0.9), sensitive: noul(0), satisfied: notYet },
    // Leg one is done, and the ride-along answers claim leg two is too —
    // while also naming the click that would actually do it.
    {
      operation: choice("DONE", 0.9),
      sensitive: noul(0),
      satisfied: noul(0.95),
      next_operation: choice("CLICK", 0.9),
      next_click_target: choice("e2", 0.9),
      next_sensitive: noul(0),
      next_satisfied: noul(0.95),
    },
    { operation: choice("DONE", 0.9), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    subgoals: [
      { goal: "expand the panel", success_criteria: "the panel is expanded" },
      { goal: "show revisions", success_criteria: "tagfilter=mobile edit in the URL" },
    ],
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(out.subgoals![1].steps.length, 1, "the second leg clicked rather than finishing on arrival");
});

// --- hand-backs Claude can act on, defaults, questions, history -------------

// An audited admin form: Save stays disabled until Category and Format are
// chosen, and the plan Claude wrote did not know that.
const productForm = () => [
  row({ ref: "ref_1", role: "button", name: "New product" }),
  row({ ref: "ref_2", role: "textbox", name: "Name", type: "text", value: "Test product" }),
  row({ ref: "ref_3", role: "combobox", name: "Category", required: true }),
  row({ ref: "ref_4", role: "combobox", name: "Format", value: "Select a format" }),
  row({ ref: "ref_5", role: "button", name: "Save", disabled: true }),
];

await check("a disabled Save is shown to Jev but never offered as a target", async () => {
  const browser = fakeBrowser({ rows: productForm() });
  const client = fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet }]);
  await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "Click Save",
    success_criteria: "the product is saved",
  });
  const { state, questions } = client.seen[0];
  assert(
    state.elements?.some((e) => e.includes("Save") && e.includes("disabled")),
    `Save missing from state: ${JSON.stringify(state.elements)}`,
  );
  assert(
    !Object.values(questions.click_target.criteria).some((c) => c.includes("Save")),
    "Save was offered as a click target",
  );
});

await check("a stuck leg names the disabled control and the empty fields, and echoes the remaining legs", async () => {
  const browser = fakeBrowser({ rows: productForm() });
  const client = fakeClient([
    { operation: choice("DONE", 0.9), sensitive: noul(0), satisfied: noul(0.95) },
    { operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet },
  ]);
  const later = { goal: "Open Settings", success_criteria: "settings page is open" };
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    subgoals: [
      { goal: "Open a new product", success_criteria: "the form is open" },
      { goal: "Click the Save button", success_criteria: "the product is saved" },
      later,
    ],
  });
  eq(out.status, "blocked", `reason: ${out.reason}`);
  eq(out.blockers?.disabled?.[0]?.name, "Save", "the disabled control");
  const empty = (out.blockers?.empty ?? []).map((r) => r.name);
  assert(empty.includes("Category") && empty.includes("Format"), `empty fields: ${empty.join(",")}`);
  assert(!empty.includes("Name"), "a filled field is not reported empty");
  eq(empty[0], "Category", "required fields first");
  assert(out.reason?.includes('"Save" is disabled') && out.reason?.includes("Category"), `reason: ${out.reason}`);
  eq(JSON.stringify(out.remaining_subgoals), JSON.stringify([later]), "the untouched legs, verbatim");
  const rows = out.page_excerpt!.interactive;
  assert(
    rows.some((l) => l.startsWith("ref_5 |") && l.includes("disabled")),
    `rows by ref, disabled marked: ${rows.join(",")}`,
  );
});

await check("no blockers when nothing the goal names is disabled", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet }]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "open the report",
    success_criteria: "report shown",
  });
  eq(out.blockers, undefined, "nothing to report");
  eq(out.remaining_subgoals, undefined, "single goal, nothing remaining");
});

const formatSelect = () =>
  row({
    ref: "ref_1",
    role: "combobox",
    name: "Format",
    options: [
      { value: "", label: "Select…", selected: true },
      { value: "soap", label: "SOAP", selected: false },
    ],
  });

await check("fill_defaults picks the first real option for a select given no value", async () => {
  const browser = fakeBrowser({ rows: [formatSelect()] });
  const client = fakeClient([
    { operation: choice("SELECT", 0.95), select_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
    { operation: choice("DONE", 0.9), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "choose a format",
    success_criteria: "a format is chosen",
    fill_defaults: true,
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  const act = browser.calls.find((c) => c.name === "jev_act");
  eq(act?.args.value, "soap", "the first real option, not the placeholder");
  eq(out.steps![0].defaulted_value, "soap", "the step says the value was a default");
  assert(client.seen[0].state.defaults, "Jev is told any option will do");
});

await check("without fill_defaults the same select still needs a value", async () => {
  const browser = fakeBrowser({ rows: [formatSelect()] });
  const client = fakeClient([
    { operation: choice("SELECT", 0.95), select_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "choose a format",
    success_criteria: "a format is chosen",
  });
  eq(out.status, "needs_value", "status");
});

await check("fill_defaults never makes up text", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "textbox", name: "Name", type: "text" })] });
  const client = fakeClient([
    { operation: choice("TYPE_TEXT", 0.95), text_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "name it",
    success_criteria: "named",
    fill_defaults: true,
  });
  eq(out.status, "needs_value", "status");
  assert(!browser.calls.some((c) => c.name === "jev_act"), "nothing was typed");
});

await check("questions are answered with final_check in one extra request", async () => {
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "switch", name: "Enable this product", checked: false })],
  });
  const client = fakeClient([
    { operation: choice("DONE", 0.9), sensitive: noul(0), satisfied: noul(0.95) },
    { verified: noul(0.9), disabled: noul(0.93) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "open the product",
    success_criteria: "its page is open",
    final_check: "the product page is open",
    questions: [{ key: "disabled", type: "yes_no", question: "Is 'Enable this product' switched off?" }],
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(client.seen.length, 2, "one step, one closing request");
  const closing = client.seen[1].questions;
  assert(closing.verified && closing.disabled, `both asked together: ${Object.keys(closing).join(",")}`);
  eq(out.answers?.disabled?.yes, 0.93, "the compacted answer");
  assert(
    client.seen[1].state.elements?.some((e) => e.includes("checked=false")),
    "the switch state is in front of Jev",
  );
});

await check("questions are still answered when a leg stopped the run, and marked", async () => {
  // Withholding them cost a second call, "stay on this page; do nothing", only
  // to ask them.
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([
    { operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet },
    { ok: noul(0.9) },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "g",
    success_criteria: "s",
    questions: [{ key: "ok", type: "yes_no", question: "Is it ok?" }],
  });
  eq(out.status, "blocked", "status unchanged");
  eq(client.seen.length, 2, "one closing request");
  eq(out.answers?.ok?.yes, 0.9, "answered");
  assert(out.answers_note?.includes("stopped"), `says which page: ${out.answers_note}`);
});

await check("malformed questions are refused before the browser is touched", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet }]);
  for (const questions of [
    [{ key: "verified", type: "yes_no", question: "clashes with final_check" }],
    [{ key: "pick", type: "choice", question: "one option only", options: { a: "A" } }],
  ] as ClaudeQuestion[][]) {
    const out = await navigate(browser.callTool, client, CFG, {
      tabId: 1,
      goal: "g",
      success_criteria: "s",
      start_url: "https://app.test/x",
      questions,
    });
    eq(out.status, "error", `refused: ${JSON.stringify(questions)}`);
  }
  eq(browser.calls.length, 0, "no navigate, no snapshot");
  eq(client.seen.length, 0, "no Jev request");
});

await check("Jev sees what it already did in this leg", async () => {
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "button", name: "New product" })],
    onClick: (s) => {
      s.url = "https://app.test/a?new=true";
      s.rows = [
        row({ ref: "ref_1", role: "button", name: "New product" }),
        row({ ref: "ref_2", role: "textbox", name: "Name", type: "text" }),
      ];
    },
  });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), click_target: choice("e1", 0.95), sensitive: noul(0), satisfied: notYet },
    { operation: choice("DONE", 0.9), sensitive: noul(0), satisfied: noul(0.95) },
  ]);
  await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    goal: "open a new product",
    success_criteria: "the form is open",
  });
  eq(client.seen[0].state.history, undefined, "nothing on the first decision");
  const h = client.seen[1].state.history;
  eq(h?.[0]?.operation, "CLICK", "the click is remembered");
  assert(h?.[0]?.target.includes("New product"), `target: ${h?.[0]?.target}`);
  eq(h?.[0]?.page_changed, true, "and that it changed the page");
});

try {
  fs.rmSync(CFG.tracesDir, { recursive: true, force: true });
} catch {}

// --- waiting, stray typing, read-only fields, questions per leg ------------

await check("an unsure WAIT or DONE waits and looks again instead of handing back", async () => {
  // A real run stopped after 5 s of a 240 s budget, with WAIT at 0.62 against
  // DONE at 0.38 while a report was still being built.
  const map = new Map([["e1", row({ role: "button", name: "Go" })]]);
  for (const op of ["WAIT", "DONE"]) {
    const v = validate(
      {
        operation: choice(op, 0.54, { WAIT: 0.62, DONE: 0.38 }),
        click_target: choice("e1", 0.5),
        sensitive: noul(0),
        satisfied: noul(0.43),
      },
      map,
      CFG,
      { allowSensitive: false, values: {} },
    );
    assert(v.ok, `${op} should pass as a wait: ${v.reason}`);
    eq(v.operation, "WAIT", `${op} becomes WAIT`);
  }
  const scroll = validate({ operation: choice("SCROLL_DOWN", 0.4), sensitive: noul(0), satisfied: notYet }, map, CFG, {
    allowSensitive: false,
    values: {},
  });
  eq(scroll.status, "needs_help", "other doubt is still handed back");
  assert(scroll.reason?.endsWith("for SCROLL_DOWN."), `no dangling "on ." with no target: ${scroll.reason}`);
});

await check("waiting on slow content is not taken for a loop or for no progress", async () => {
  // Three WAITs on a page that does not move, then the results arrive.
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Search" })] });
  let waits = 0;
  const callTool: typeof browser.callTool = async (name, args) => {
    if (name === "jev_settle" && args.expect === "change" && ++waits === 3) {
      browser.state.rows = [...browser.state.rows, row({ ref: "ref_2", role: "link", name: "Blue running shoes" })];
    }
    return browser.callTool(name, args);
  };
  const client = fakeClient([
    (state) =>
      (state.elements?.length ?? 0) > 1
        ? { operation: choice("DONE", 0.95), sensitive: noul(0), satisfied: noul(0.95) }
        : { operation: choice("WAIT", 0.9), sensitive: noul(0), satisfied: notYet },
  ]);
  const out = await navigate(callTool, client, CFG, {
    tabId: 1,
    goal: "wait for the search results to load",
    success_criteria: "search results are listed",
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(waits, 3, "waited three times");
});

await check("a WAIT never runs past the call's time budget", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([{ operation: choice("WAIT", 0.9), sensitive: noul(0), satisfied: notYet }]);
  await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s", max_ms: 3000 });
  const wait = browser.calls.find((c) => c.name === "jev_settle" && c.args.expect === "change");
  assert(Number(wait?.args.timeoutMs) <= 2000, `bounded by what is left: ${JSON.stringify(wait?.args)}`);
});

await check("a value is not typed into a field whose name does not match, unless Jev is sure", async () => {
  // An optional leg asked to type into a comment box, on a page without one,
  // typed into an unrelated field at 0.65.
  const typeInto = (name: string, conf: number, key = "Add a comment") =>
    validate(
      {
        operation: choice("TYPE_TEXT", 0.9),
        text_target: choice("e1", conf),
        value_key: choice(key, 0.97),
        sensitive: noul(0),
        satisfied: notYet,
      },
      new Map([["e1", row({ ref: "ref_68", role: "textbox", name, type: "text" })]]),
      CFG,
      { allowSensitive: false, values: { [key]: "Please gift wrap it" } },
    );
  const wrong = typeInto("Shipping address", 0.65);
  eq(wrong.status, "needs_help", "mismatch at 0.65 is refused");
  assert(wrong.reason?.includes("may not be on this page"), `says why: ${wrong.reason}`);
  assert(typeInto("Shipping address", 0.9).ok, "a sure pick still goes through");
  assert(typeInto("Add a comment…", 0.65).ok, "a matching name passes at the ordinary gate");
  assert(typeInto("Shipping address", 0.65, "q").ok, "a key with no words to compare is not held to it");
  assert(valueFitsField("email", row({ name: "E-mail address" })), "punctuation does not break a match");
  assert(valueFitsField("order note", row({ name: "" })), "an unnamed field is not judged");
});

await check("a read-only field is offered to click, never to type or select", async () => {
  const field = row({ role: "textbox", name: "Order number", type: "text", readonly: true });
  assert(isCompatible("CLICK", field), "click");
  assert(!isCompatible("TYPE_TEXT", field), "no typing");
  assert(!isCompatible("TYPE_AND_SUBMIT", field), "no submitting");
});

await check("each leg's questions are answered on the page it ended on, with evidence", async () => {
  const browser = fakeBrowser({
    rows: [
      row({ ref: "ref_1", role: "radio", name: "Summary", checked: true }),
      row({ ref: "ref_2", role: "radio", name: "Details", checked: false }),
    ],
    onClick: (s, args) => {
      const on = args["ref"];
      s.rows = s.rows.map((r) => ({ ...r, checked: r.ref === on }));
    },
  });
  const onDetails = () => browser.state.rows.find((r) => r.name === "Details")?.checked === true;
  const client = fakeClient([
    (_state, questions) => {
      // A closing request for a leg carries that leg's questions and no step.
      if (questions["orders_listed"]) return { orders_listed: noul(0.97), orders_listed__evidence: choice("p1", 0.9) };
      if (questions["totals_shown"]) return { totals_shown: noul(0.95), totals_shown__evidence: choice("p1", 0.9) };
      const target = onDetails() ? "e1" : "e2";
      const done = String(_state["goal"]).includes("Details") ? onDetails() : !onDetails();
      return done
        ? { operation: choice("DONE", 0.95), sensitive: noul(0), satisfied: noul(0.95) }
        : {
            operation: choice("CLICK", 0.95),
            click_target: choice(target, 0.95),
            sensitive: noul(0),
            satisfied: notYet,
          };
    },
  ]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    subgoals: [
      {
        goal: "Click Details",
        success_criteria: "Details is selected",
        questions: [{ key: "orders_listed", type: "yes_no", question: "Is the list of orders shown?" }],
      },
      {
        goal: "Click Summary",
        success_criteria: "Summary is selected",
        questions: [{ key: "totals_shown", type: "yes_no", question: "Are the weekly totals shown?" }],
      },
    ],
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(out.subgoals?.[0]?.answers?.orders_listed?.yes, 0.97, "leg 1 answered");
  eq(out.subgoals?.[1]?.answers?.totals_shown?.yes, 0.95, "leg 2 answered");
  eq(out.subgoals?.[0]?.answers?.orders_listed?.evidence, "page body text", "quoted from the page");
  const asked = client.seen.find((x) => x.questions["orders_listed"]);
  assert(asked?.state["page_text"] === "[1] page body text", `numbered passages: ${String(asked?.state["page_text"])}`);
  const snap = browser.calls.find((c) => c.name === "jev_snapshot" && c.args.full_text === true);
  assert(snap, "the questions read the whole page, not only what is in view");
});

await check("a skipped leg's questions are not asked", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0), satisfied: notYet }]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    subgoals: [
      {
        goal: "type into the chat",
        success_criteria: "typed",
        optional: true,
        questions: [{ key: "typed", type: "yes_no", question: "Is the text in the box?" }],
      },
      { goal: "stay", success_criteria: "s" },
    ],
  });
  eq(out.subgoals?.[0]?.skipped, true, "skipped");
  eq(out.subgoals?.[0]?.answers, undefined, "not answered");
  assert(!client.seen.some((x) => x.questions["typed"]), "never asked");
});

await check("questions alone answer about the page as it is, in one request", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([{ shown: noul(0.9) }]);
  const out = await navigate(browser.callTool, client, CFG, {
    tabId: 1,
    questions: [{ key: "shown", type: "yes_no", question: "Is the banner shown?" }],
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(client.seen.length, 1, "no step decisions");
  eq(out.answers?.shown?.yes, 0.9, "answered");
  eq(out.answers_note, undefined, "no note on a run that did not stop");
  assert(!browser.calls.some((c) => c.name === "jev_act"), "nothing touched");
});

await check("a call with nothing to do is refused", async () => {
  const browser = fakeBrowser();
  const out = await navigate(browser.callTool, fakeClient([]), CFG, { tabId: 1 });
  eq(out.status, "error", "status");
  eq(browser.calls.length, 0, "browser untouched");
});

await check("a leg's malformed questions are refused before the browser is touched", async () => {
  const browser = fakeBrowser();
  const out = await navigate(browser.callTool, fakeClient([]), CFG, {
    tabId: 1,
    subgoals: [
      { goal: "g", success_criteria: "s" },
      {
        goal: "h",
        success_criteria: "t",
        questions: [{ key: "p", type: "choice", question: "one", options: { a: "A" } }],
      },
    ],
  });
  eq(out.status, "error", "status");
  assert(out.reason?.startsWith("Subgoal 2:"), `names the leg: ${out.reason}`);
  eq(browser.calls.length, 0, "browser untouched");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n",
);
process.exit(failed.length ? 1 : 0);
