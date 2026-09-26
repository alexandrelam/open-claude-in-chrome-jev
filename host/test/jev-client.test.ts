#!/usr/bin/env node
//
// Contract test for the Jev provider client.
//
// The Decisions endpoint lives under /api/alpha/, so its shape is expected to
// move. This file is the tripwire: it pins the request we send and the four
// things we read back out of the response (choice, probabilities, confidence,
// usage.cost). When the provider changes, this fails first and names what
// changed, instead of the navigator quietly deciding at confidence 0.
//
// The fixtures are the shapes documented on OpenRouter as of 2026-09-25.
//
// Run: node host/test/jev-client.test.ts

import { createClient, normalizeAnswer, BudgetExceeded, JevError, resetPrivacyWarning } from "../jev/client.ts";
import type { ClientConfig, FetchLike } from "../jev/client.ts";
import type { JevQuestions } from "../jev/types.ts";
import { errorMessage } from "../errors.ts";

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
function close(a: number | undefined, b: number, msg: string, tol = 1e-9): void {
  if (a === undefined) throw new Error(`${msg}: expected ~${b}, got undefined`);
  if (Math.abs(a - b) > tol) throw new Error(`${msg}: expected ~${b}, got ${a}`);
}

const CFG: ClientConfig = {
  provider: "openrouter",
  apiKey: "sk-or-test",
  baseUrl: "https://openrouter.test/api/alpha",
  model: "~typesafe/jev-latest",
  budgetUsd: 0.01,
};

interface FakeResponse {
  status?: number;
  json?: unknown;
}

type FetchInit = Parameters<FetchLike>[1];
type FetchResult = Awaited<ReturnType<FetchLike>>;

/** The request body the client sends, as these tests read it. */
interface SentBody {
  model: string;
  state: unknown;
  questions: JevQuestions;
}

interface FakeFetch extends FetchLike {
  calls: Array<{ url: string; opts: FetchInit; body: SentBody }>;
}

function fakeFetch(responses: Array<FakeResponse | (() => Promise<FetchResult>)>): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  let i = 0;
  const fn: FetchLike = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) as SentBody });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (typeof r === "function") return r();
    if (!r) throw new Error("fakeFetch: no responses");
    return {
      ok: r.status === undefined || r.status < 400,
      status: r.status ?? 200,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json ?? ""),
    };
  };
  return Object.assign(fn, { calls });
}

const CHOICE_RESPONSE = {
  json: {
    model: "typesafe/jev-1.13",
    answers: {
      operation: {
        type: "choice",
        choice: "CLICK",
        probabilities: { CLICK: 0.87, SCROLL_DOWN: 0.1, DONE: 0.03 },
        confidence: 0.8,
      },
      sensitive: { type: "noul", noul: 0.02 },
    },
    usage: { input_tokens: 1200, cost: 0.00005 },
  },
};

await check("request shape: model, state and questions at the top level", async () => {
  resetPrivacyWarning();
  const f = fakeFetch([CHOICE_RESPONSE]);
  const client = createClient(CFG, { fetchImpl: f });
  await client.decide(
    { url: "https://x.test" },
    { operation: { type: "choice", instructions: "i", criteria: { CLICK: "c" } } },
  );

  const call = f.calls[0];
  eq(call.url, "https://openrouter.test/api/alpha/decisions", "endpoint");
  eq(call.opts.method, "POST", "method");
  eq(call.opts.headers.Authorization, "Bearer sk-or-test", "auth header");
  eq(call.body.model, "~typesafe/jev-latest", "model");
  assert(call.body.state && call.body.questions, "state and questions must both be present");
  eq(call.body.questions.operation.type, "choice", "question type survives");
});

await check("choice answer: choice, probabilities and confidence are read", async () => {
  const client = createClient(CFG, { fetchImpl: fakeFetch([CHOICE_RESPONSE]) });
  const { answers } = await client.decide({}, {});
  eq(answers.operation.choice, "CLICK", "choice");
  eq(answers.operation.confidence, 0.8, "confidence comes from the response field");
  eq(answers.operation.probabilities!.CLICK, 0.87, "probabilities");
});

await check("choice with no confidence field falls back to max(probabilities)", async () => {
  // The PRD assumed this was always the rule. It is the fallback, not the rule —
  // but it still has to work, because the field is not guaranteed.
  const a = normalizeAnswer({ type: "choice", choice: "CLICK", probabilities: { CLICK: 0.62, DONE: 0.38 } })!;
  close(a.confidence, 0.62, "fallback confidence");
});

await check("noul confidence maps onto the same 0..1 scale as choice", async () => {
  // For a noul the probability IS the certainty: 0.98 and 0.02 are both
  // confident answers and 0.5 means "can't tell". One threshold has to govern
  // every gate in the loop, so both ends map to high confidence.
  close(normalizeAnswer({ type: "noul", noul: 0.98 })?.confidence, 0.96, "confident yes");
  close(normalizeAnswer({ type: "noul", noul: 0.02 })?.confidence, 0.96, "confident no");
  close(normalizeAnswer({ type: "noul", noul: 0.5 })?.confidence, 0, "can't tell");
});

await check("a question keyed like a response field is kept in the wrapped shape", async () => {
  // jev_assess let Claude key a question "model"; the client dropped its answer
  // as though it were the response's own model field.
  const client = createClient(CFG, {
    fetchImpl: fakeFetch([
      {
        json: {
          model: "typesafe/jev-1.13",
          answers: { model: { type: "choice", choice: "s25", probabilities: { s25: 0.9 } } },
        },
      },
    ]),
  });
  const { answers } = await client.decide({}, {});
  eq(answers.model?.choice, "s25", "answer keyed model survives");
});

await check("score answer keeps score, legend and distribution", async () => {
  const a = normalizeAnswer({
    type: "score",
    score: 1.05,
    legend: { 0: "Calm", 1: "Frustrated", 2: "Very angry" },
    probabilities: { 0: 0, 1: 0.95, 2: 0.05 },
    confidence: 0.92,
  })!;
  eq(a.type, "score", "type");
  close(a.score, 1.05, "score");
  eq(a.confidence, 0.92, "confidence");
  eq(a.legend![1], "Frustrated", "legend");
});

await check("usage.cost is accumulated in USD, not estimated from tokens", async () => {
  const client = createClient(CFG, { fetchImpl: fakeFetch([CHOICE_RESPONSE]) });
  await client.decide({}, {});
  await client.decide({}, {});
  close(client.totals.cost_usd, 0.0001, "two calls at $0.00005");
  eq(client.totals.requests, 2, "request count");
  eq(client.totals.input_tokens, 2400, "input tokens");
});

await check("the resolved model is captured, so a moving -latest alias is visible", async () => {
  const client = createClient(CFG, { fetchImpl: fakeFetch([CHOICE_RESPONSE]) });
  await client.decide({}, {});
  eq(client.totals.resolved_model, "typesafe/jev-1.13", "resolved model, not the alias we asked for");
});

await check("a bare answers object at the top level still parses", async () => {
  // Cheap tolerance for the one alpha-era shape change that would otherwise
  // break everything: answers hoisted out of their wrapper.
  const flat = {
    json: {
      operation: { type: "choice", choice: "DONE", probabilities: { DONE: 1 }, confidence: 1 },
      usage: { cost: 0 },
    },
  };
  const client = createClient(CFG, { fetchImpl: fakeFetch([flat]) });
  const { answers } = await client.decide({}, {});
  eq(answers.operation.choice, "DONE", "choice");
});

await check("429 is retried once and then succeeds", async () => {
  const f = fakeFetch([{ status: 429, json: { error: "rate limited" } }, CHOICE_RESPONSE]);
  const client = createClient(CFG, { fetchImpl: f });
  const { answers } = await client.decide({}, {});
  eq(f.calls.length, 2, "one retry");
  eq(answers.operation.choice, "CLICK", "succeeded on the retry");
});

await check("400 is not retried — a malformed request would just cost twice", async () => {
  const f = fakeFetch([{ status: 400, json: { error: "bad questions" } }]);
  const client = createClient(CFG, { fetchImpl: f });
  let threw = null;
  try {
    await client.decide({}, {});
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof JevError, "should throw JevError");
  eq(threw.status, 400, "status");
  eq(f.calls.length, 1, "no retry");
});

await check("the 255-choice limit surfaces as a non-retryable error", async () => {
  // A real response from the live API on 2026-09-25, when a Choice was built
  // with 400 options. The limit is not in the published docs, so this fixture
  // is the record of it — and it must not be retried, since the same oversized
  // request would just fail again at full price.
  const f = fakeFetch([
    {
      status: 400,
      json: {
        error: { message: 'HTTP 400: {"detail":"Too many choices. Must have at most 255 choices."}', code: 400 },
      },
    },
  ]);
  const client = createClient(CFG, { fetchImpl: f });
  let threw = null;
  try {
    await client.decide({}, {});
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof JevError, "should throw JevError");
  eq(threw.retryable, false, "must not be retried");
  eq(f.calls.length, 1, "exactly one attempt");
  assert(threw.message.includes("255"), "the limit is legible in the message");
});

await check("the budget stops the next request rather than the last one", async () => {
  const pricey = { json: { answers: {}, usage: { cost: 0.02 } } };
  const client = createClient({ ...CFG, budgetUsd: 0.01 }, { fetchImpl: fakeFetch([pricey]) });
  await client.decide({}, {});
  let threw = null;
  try {
    await client.decide({}, {});
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof BudgetExceeded, `expected BudgetExceeded, got ${errorMessage(threw)}`);
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n",
);
process.exit(failed.length ? 1 : 0);
