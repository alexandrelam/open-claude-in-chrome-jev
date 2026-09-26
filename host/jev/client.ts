// The only place in this repo that talks to a Jev provider.
//
// Everything about the wire format lives behind decide(state, questions), so
// when the /alpha/ Decisions endpoint changes shape — it is alpha, it will —
// there is exactly one file to fix and one contract test to re-record.
//
// Wire format (verified 2026-09-25):
//   POST {baseUrl}/decisions
//   { model, state, questions: { <key>: { type, instructions, criteria } } }
// Answers come back keyed by the same question keys:
//   noul   -> { type: "noul", noul: 0.98 }
//   choice -> { type: "choice", choice, probabilities: {...}, confidence }
//   score  -> { type: "score", score, legend, probabilities, confidence }
// Questions in one request are evaluated in parallel, so a step asks all four
// of its questions in a single round trip. Output tokens are free; only input
// is billed, and usage.cost gives the exact figure in USD.

import type { Answer, Answers, ClientTotals, Decide, JevClient, JevConfig, JevQuestions, JevUsage } from "./types.ts";

export class JevError extends Error {
  status: number | null;
  retryable: boolean;

  constructor(
    message: string,
    { status = null, retryable = false }: { status?: number | null; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "JevError";
    this.status = status;
    this.retryable = retryable;
  }
}

export class BudgetExceeded extends JevError {
  spent: number;
  budget: number;

  constructor(spent: number, budget: number) {
    super(`Jev budget exhausted: spent $${spent.toFixed(4)} of $${budget.toFixed(4)}.`);
    this.name = "BudgetExceeded";
    this.spent = spent;
    this.budget = budget;
  }
}

const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

// Page content reaches OpenRouter and TypeSafe. Say so once per process, on
// stderr where it lands in the MCP client's server log rather than in a tool
// result the model would have to reason about.
let warnedPrivacy = false;
export function resetPrivacyWarning(): void {
  warnedPrivacy = false;
}
function warnPrivacyOnce(cfg: Pick<JevConfig, "provider">): void {
  if (warnedPrivacy) return;
  warnedPrivacy = true;
  process.stderr.write(
    `[jev] Page content (URL, title, element labels, text excerpt) is being sent to ` +
      `${cfg.provider} for each decision. Restrict this with jev.allowed_domains / ` +
      `jev.blocked_domains in ~/.config/open-claude-in-chrome/config.json.\n`,
  );
}

function maxProb(probabilities: unknown): number | null {
  if (!probabilities || typeof probabilities !== "object") return null;
  const vals = Object.values(probabilities).filter((v): v is number => typeof v === "number");
  return vals.length ? Math.max(...vals) : null;
}

/**
 * Put a single comparable `confidence` on every answer type.
 *
 * The API returns `confidence` (how peaked the distribution is) for choice and
 * score, but not for noul, where the probability itself carries the certainty:
 * 0.98 and 0.02 are both confident, 0.5 means "can't tell". Mapping noul onto
 * the same 0..1 scale with |p-0.5|*2 lets one min_confidence threshold govern
 * every gate in the loop.
 */
export function normalizeAnswer(value: unknown): Answer | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as RawAnswer;
  const out: Answer = { type: typeof raw.type === "string" ? raw.type : "", raw };
  if (raw.type === "noul" || typeof raw.noul === "number") {
    out.type = "noul";
    out.noul = Number(raw.noul);
    out.confidence = Math.abs(out.noul - 0.5) * 2;
    return out;
  }
  if (raw.type === "choice" || typeof raw.choice === "string") {
    out.type = "choice";
    out.choice = String(raw.choice);
    out.probabilities = raw.probabilities || {};
    out.confidence = typeof raw.confidence === "number" ? raw.confidence : (maxProb(raw.probabilities) ?? 0);
    return out;
  }
  if (raw.type === "score" || typeof raw.score === "number") {
    out.type = "score";
    out.score = Number(raw.score);
    out.legend = raw.legend || {};
    out.probabilities = raw.probabilities || {};
    out.confidence = typeof raw.confidence === "number" ? raw.confidence : (maxProb(raw.probabilities) ?? 0);
    return out;
  }
  return out;
}

/** An answer as the provider sends it, before normalizeAnswer. */
interface RawAnswer {
  type?: unknown;
  noul?: unknown;
  choice?: unknown;
  score?: unknown;
  confidence?: unknown;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

/** A Decisions response: answers keyed by question, wrapped or bare. */
interface DecisionsResponse {
  answers?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  model?: string;
  [key: string]: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A budget-scoped Jev client. One per jev_navigate run, so `spentUsd` is the
 * run's spend and the cap in cfg.budgetUsd bounds a single tool call rather
 * than the lifetime of the server.
 */
/** The part of fetch() the client uses, so a test can stand in for it. */
export type FetchLike = (
  url: string,
  init: { method: string; signal: AbortSignal | null; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export type ClientConfig = Pick<JevConfig, "provider" | "apiKey" | "baseUrl" | "model" | "budgetUsd">;

export function createClient(
  cfg: ClientConfig,
  { fetchImpl = globalThis.fetch }: { fetchImpl?: FetchLike } = {},
): JevClient {
  const state = { spentUsd: 0, requests: 0, inputTokens: 0, resolvedModel: null as string | null };

  async function post(body: unknown, signal: AbortSignal | undefined): Promise<DecisionsResponse | null> {
    const url = `${cfg.baseUrl.replace(/\/+$/, "")}/decisions`;
    const res = await fetchImpl(url, {
      method: "POST",
      signal: signal ?? null,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        // Ranking metadata only; harmless and helps OpenRouter attribute usage.
        "HTTP-Referer": "https://github.com/alexandrelam/open-claude-in-chrome",
        "X-Title": "open-claude-in-chrome (jev)",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new JevError(`Jev provider returned ${res.status}: ${text.slice(0, 400)}`, {
        status: res.status,
        retryable: RETRY_STATUSES.has(res.status),
      });
    }
    return (await res.json()) as DecisionsResponse | null;
  }

  /**
   * Ask Jev one set of typed questions about one state.
   *
   * @param {string|object|Array} state  What Jev reasons over.
   * @param {Record<string, {type, instructions, criteria}>} questions
   * @returns {{answers, usage, model, ms, raw}}
   */
  const decide: Decide = async (stateArg: unknown, questions: JevQuestions, { signal } = {}) => {
    warnPrivacyOnce(cfg);
    if (cfg.budgetUsd > 0 && state.spentUsd >= cfg.budgetUsd) {
      throw new BudgetExceeded(state.spentUsd, cfg.budgetUsd);
    }

    const body = { model: cfg.model, state: stateArg, questions };
    const started = Date.now();

    let json: DecisionsResponse | null;
    try {
      json = await post(body, signal);
    } catch (err) {
      // One retry, jittered. A 4xx that isn't rate limiting is a request we
      // built wrong — retrying it just spends the budget twice.
      if (!(err instanceof JevError) || !err.retryable) throw err;
      await sleep(400 + Math.random() * 400);
      json = await post(body, signal);
    }

    const ms = Date.now() - started;
    const answers: Answers = {};
    // Tolerate both {answers:{...}} and a bare answers object at the top level:
    // the endpoint is alpha, and this is the one shape change cheap to absorb.
    const wrapped = Boolean(json && typeof json.answers === "object" && json.answers);
    const rawAnswers = wrapped ? json?.answers : json;
    for (const [key, val] of Object.entries(rawAnswers || {})) {
      // Only the bare shape mixes answers with the response's own fields. In
      // the wrapped shape every key is a question, and skipping these there
      // silently dropped a jev_assess question Claude had keyed "model".
      if (!wrapped && (key === "usage" || key === "model" || key === "id")) continue;
      const norm = normalizeAnswer(val);
      if (norm) answers[key] = norm;
    }

    const usage = json?.usage || {};
    const cost = typeof usage["cost"] === "number" ? usage["cost"] : 0;
    state.spentUsd += cost;
    state.requests += 1;
    state.inputTokens += Number(usage["input_tokens"] ?? usage["prompt_tokens"] ?? 0) || 0;
    state.resolvedModel = json?.model || cfg.model;

    const fullUsage: JevUsage = { ...usage, cost };
    return { answers, usage: fullUsage, model: state.resolvedModel, ms, raw: json };
  };

  return {
    decide,
    get totals(): ClientTotals {
      return {
        requests: state.requests,
        input_tokens: state.inputTokens,
        cost_usd: Number(state.spentUsd.toFixed(6)),
        budget_usd: cfg.budgetUsd,
        resolved_model: state.resolvedModel,
      };
    },
  };
}
