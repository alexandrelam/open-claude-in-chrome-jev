#!/usr/bin/env node
//
// jev_assess: Claude's questions over many items, answered in one call.
//
// Driven against a fake browser and a fake Jev. What matters: every item gets
// every question, text items never touch the browser, only Claude's URLs are
// opened, the domain rules hold before anything is sent, and one bad item does
// not sink the table.
//
// Run: node host/test/jev-assess.test.mjs

import { assess, buildQuestions, questionsError, compactAnswer, summarize, collapseRepeats } from "../jev/assess.js";
import { requestTimeoutMs } from "../tool-runtime.js";
import { resolveConfig } from "../jev/config.js";
import { BudgetExceeded } from "../jev/client.js";

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const CFG = { ...resolveConfig({ OPENROUTER_API_KEY: "k" }, {}), allowedDomains: null, blockedDomains: [] };

const QUESTIONS = [
  { key: "invoice", type: "yes_no", question: "Does the seller say the invoice is included?" },
  { key: "deal", type: "choice", question: "How good is the price?", options: { great: "20%+ below new", fair: "0-20% below", bad: "At or above new" } }
];

const text = (t) => ({ content: [{ type: "text", text: t }] });

/** A fake browser whose pages are a map of url -> text. */
function fakeBrowser(pages) {
  const calls = [];
  let current = null;
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === "navigate") {
      current = args.url;
      return text("ok");
    }
    if (name === "javascript_tool") {
      return text(JSON.stringify({ url: current, title: `T ${current}`, text: pages[current] ?? "" }));
    }
    return text("ok");
  };
  return { callTool, calls };
}

/** A fake Jev: answers from a function of the state, recording every request. */
function fakeClient(answerFor) {
  const seen = [];
  let spent = 0;
  return {
    decide: async (state, questions) => {
      seen.push({ state, questions });
      spent += 0.0001;
      return { answers: answerFor(state, questions), ms: 5, usage: { cost: 0.0001 } };
    },
    seen,
    get totals() {
      return { requests: seen.length, cost_usd: spent };
    }
  };
}

const answerByText = (state) => {
  const t = state.item.text;
  return {
    invoice: { type: "noul", noul: /facture/.test(t) ? 0.95 : 0.05 },
    deal: { type: "choice", choice: /400/.test(t) ? "great" : "bad", probabilities: /400/.test(t) ? { great: 0.8, fair: 0.2 } : { bad: 0.9, fair: 0.1 } }
  };
};

await check("questions map onto the three Jev types", async () => {
  const q = buildQuestions([
    ...QUESTIONS,
    { key: "cond", type: "score", question: "Condition?", scale: ["Poor", "Good", "Mint"] }
  ]);
  eq(q.invoice.type, "noul", "yes_no -> noul");
  eq(q.invoice.criteria.true, "Yes", "default yes");
  eq(q.deal.type, "choice", "choice");
  eq(Object.keys(q.deal.criteria).length, 3, "options carried");
  eq(q.cond.type, "score", "score");
  eq(q.cond.criteria[2], "Mint", "scale carried in order");
});

await check("malformed questions are refused before anything is browsed", async () => {
  assert(questionsError([]), "empty list");
  assert(questionsError([{ key: "a", type: "choice", question: "q", options: { x: "only one" } }]), "one-option choice");
  assert(questionsError([{ key: "a", type: "yes_no", question: "q" }, { key: "a", type: "yes_no", question: "q" }]), "duplicate key");
  assert(questionsError([{ key: "model", type: "yes_no", question: "q" }]), "reserved key");
  eq(questionsError(QUESTIONS), null, "a valid list passes");
  const browser = fakeBrowser({});
  const out = await assess(browser.callTool, fakeClient(answerByText), CFG, { tabId: 1, items: [{ url: "https://x.test/a" }], questions: [] });
  eq(out.status, "error", "status");
  eq(browser.calls.length, 0, "no browsing on a bad request");
});

await check("text items are judged without touching the browser", async () => {
  const browser = fakeBrowser({});
  const client = fakeClient(answerByText);
  const out = await assess(browser.callTool, client, CFG, {
    items: [{ text: "S25 400 € avec facture", label: "a" }, { text: "S25 550 € sans rien", label: "b" }],
    questions: QUESTIONS, context: "New price 527 €"
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(browser.calls.length, 0, "no browser calls");
  eq(out.items[0].answers.invoice.yes, 0.95, "first item invoice");
  eq(out.items[0].answers.deal.choice, "great", "first item deal");
  eq(out.items[1].answers.deal.choice, "bad", "second item deal");
  eq(client.seen[0].state.context, "New price 527 €", "shared context reaches Jev");
  eq(client.seen.length, 2, "one request per item, all questions together");
});

await check("url items are opened in order and read, then judged", async () => {
  const browser = fakeBrowser({ "https://x.test/1": "offre 400 facture", "https://x.test/2": "offre 600" });
  const out = await assess(browser.callTool, fakeClient(answerByText), CFG, {
    tabId: 1, items: [{ url: "https://x.test/1" }, { url: "https://x.test/2" }], questions: QUESTIONS
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  const navs = browser.calls.filter((c) => c.name === "navigate").map((c) => c.args.url);
  eq(navs.join(","), "https://x.test/1,https://x.test/2", "opened exactly Claude's URLs, in order");
  eq(out.items[0].answers.deal.choice, "great", "judged on the page text");
  eq(out.items[0].title, "T https://x.test/1", "title recorded");
  assert(out.items[0].excerpt.includes("offre"), "excerpt returned for Claude to check");
});

await check("a blocked domain is never opened and never sent", async () => {
  const browser = fakeBrowser({ "https://bank.test/x": "secret" });
  const client = fakeClient(answerByText);
  const out = await assess(browser.callTool, client, { ...CFG, blockedDomains: ["bank.test"] }, {
    tabId: 1, items: [{ url: "https://bank.test/x" }], questions: QUESTIONS
  });
  eq(out.items[0].status, "blocked", "status");
  eq(browser.calls.length, 0, "not opened");
  eq(client.seen.length, 0, "not sent");
});

await check("one failing item does not sink the table", async () => {
  const browser = fakeBrowser({ "https://x.test/1": "offre 400 facture", "https://x.test/2": "" });
  const out = await assess(browser.callTool, fakeClient(answerByText), CFG, {
    tabId: 1, items: [{ url: "https://x.test/1" }, { url: "https://x.test/2" }], questions: QUESTIONS
  });
  eq(out.status, "partial", "status");
  eq(out.items[0].status, "ok", "the good item");
  eq(out.items[1].status, "error", "the empty page");
});

await check("running out of budget skips the rest instead of failing each", async () => {
  const browser = fakeBrowser({});
  let n = 0;
  const client = {
    decide: async () => {
      if (++n > 1) throw new BudgetExceeded(0.5, 0.5);
      return { answers: answerByText({ item: { text: "400 facture" } }) };
    },
    totals: {}
  };
  const out = await assess(browser.callTool, client, CFG, {
    items: [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }, { text: "e" }, { text: "f" }],
    questions: QUESTIONS
  });
  assert(out.reason?.includes("budget"), `reason names the budget: ${out.reason}`);
  assert(out.items.some((r) => r.status === "skipped"), "later items are skipped, not attempted");
});

await check("answers are compacted, with a runner-up only when it was close", async () => {
  eq(compactAnswer({ type: "noul", noul: 0.8712 }).yes, 0.871, "noul");
  const close = compactAnswer({ type: "choice", choice: "fair", probabilities: { fair: 0.55, great: 0.4, bad: 0.05 } });
  eq(close.runner_up.choice, "great", "close runner-up kept");
  const clear = compactAnswer({ type: "choice", choice: "bad", probabilities: { bad: 0.95, fair: 0.05 } });
  eq(clear.runner_up, undefined, "clear answer has none");
  eq(compactAnswer({ type: "score", score: 1.9, legend: { 0: "Poor", 1: "Good", 2: "Mint" }, confidence: 0.7 }).label, "Mint", "score label");
});

await check("the summary counts answers per question", async () => {
  const s = summarize(
    [
      { answers: { invoice: { yes: 0.9 }, deal: { choice: "great" } } },
      { answers: { invoice: { yes: 0.1 }, deal: { choice: "great" } } },
      { status: "error" }
    ],
    QUESTIONS
  );
  eq(s.invoice.yes, 1, "yes count");
  eq(s.invoice.no, 1, "no count");
  eq(s.deal.great, 2, "choice count");
});

await check("an item with nothing to assess is refused up front", async () => {
  const out = await assess(fakeBrowser({}).callTool, fakeClient(answerByText), CFG, { items: [{ label: "empty" }], questions: QUESTIONS });
  eq(out.status, "error", "status");
});

await check("a title repeated back to back is read once", async () => {
  eq(collapseRepeats("IPhone 16 écran fissuré IPhone 16 écran fissuré IPhone 16 écran fissuré 400 €"), "IPhone 16 écran fissuré 400 €", "three copies");
  eq(collapseRepeats("Annonces (2) Iphone 16 Iphone 16 500 € Iphone 16 Iphone 16 480 €"), "Annonces (2) Iphone 16 500 € Iphone 16 480 €", "two ads stay two");
  eq(collapseRepeats("très très bon état"), "très très bon état", "short words are left alone");
  eq(collapseRepeats("fooPhone 1 Phone 1"), "fooPhone 1 Phone 1", "a repeat must start on a word");
});

await check("page text is de-duplicated before Jev sees it", async () => {
  const browser = fakeBrowser({ "https://x.test/p": "Iphone 16 Iphone 16 Iphone 16 500 €" });
  const client = fakeClient(answerByText);
  await assess(browser.callTool, client, CFG, { tabId: 1, items: [{ url: "https://x.test/p" }], questions: QUESTIONS });
  eq(client.seen[0].state.item.text, "Iphone 16 500 €", "Jev reads one copy");
});

await check("items_script items are appended and judged in the same call", async () => {
  const pages = { "https://x.test/a": "S25 400 € facture", "https://x.test/b": "S25 550 €" };
  const browser = fakeBrowser(pages);
  const inner = browser.callTool;
  let script = null;
  const callTool = async (name, args) => {
    if (name === "javascript_tool" && args.text === "BUILD") {
      script = args;
      return text(JSON.stringify([{ url: "https://x.test/a", label: "a" }, { url: "https://x.test/b", label: "b" }]));
    }
    return inner(name, args);
  };
  const out = await assess(callTool, fakeClient(answerByText), CFG, {
    tabId: 1, items: [{ text: "S25 400 € facture", label: "given" }], items_script: "BUILD", items_script_timeout_ms: 60000, questions: QUESTIONS
  });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(out.items.map((r) => r.label).join(","), "given,a,b", "given items first, then the script's");
  eq(out.items[1].answers.invoice.yes, 0.95, "script item judged");
  eq(script.timeout_ms, 60000, "timeout passed through");
});

await check("a script returning JSON.stringify output is accepted", async () => {
  const callTool = async (name, args) =>
    args.text === "BUILD" ? text(JSON.stringify(JSON.stringify([{ text: "400 facture" }]))) : text("ok");
  const out = await assess(callTool, fakeClient(answerByText), CFG, { tabId: 1, items_script: "BUILD", questions: QUESTIONS });
  eq(out.status, "done", `reason: ${out.reason}`);
});

await check("a failing or malformed items_script stops before any judging", async () => {
  for (const [reply, why] of [["Error: ReferenceError: x is not defined", "failed"], ['{"a":1}', "must end in an array"], ["[1]", "not an object"]]) {
    const client = fakeClient(answerByText);
    const out = await assess(async () => text(reply), client, CFG, { tabId: 1, items_script: "BUILD", questions: QUESTIONS });
    eq(out.status, "error", `status for ${reply}`);
    assert(out.reason.includes(why), `reason for ${reply}: ${out.reason}`);
    eq(client.seen.length, 0, "Jev not asked");
  }
  const out = await assess(async () => text("[]"), fakeClient(answerByText), CFG, { items_script: "BUILD", questions: QUESTIONS });
  assert(/tabId/.test(out.reason), "needs a tab");
});

await check("the host waits longer only for a javascript_tool that asks for it", async () => {
  eq(requestTimeoutMs("javascript_tool", {}), 60000, "default");
  eq(requestTimeoutMs("javascript_tool", { timeout_ms: 90000 }), 100000, "extended with slack");
  eq(requestTimeoutMs("javascript_tool", { timeout_ms: 999999 }), 130000, "capped");
  eq(requestTimeoutMs("navigate", { timeout_ms: 90000 }), 60000, "other tools untouched");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
