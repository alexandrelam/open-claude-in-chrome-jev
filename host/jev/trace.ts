// Per-run traces, written to ~/.config/open-claude-in-chrome/jev-runs/<id>.json.
//
// Local only, and deliberately so: a trace holds page labels and the text the
// caller supplied, which is exactly the material the privacy warning is about.
// It never leaves the machine.
//
// Writing is best-effort throughout. A full disk or a read-only home should
// cost you the trace, not the browser action you were in the middle of.

import fs from "node:fs";
import path from "node:path";

import { errorMessage } from "../errors.ts";

/** One entry in a run's step log. Its fields vary with what the step did. */
export interface TraceStep {
  answers?: { operation?: { confidence?: number } } | Record<string, unknown> | null;
  satisfied?: number;
  rows_offered?: number;
  rows_cut?: number;
  [key: string]: unknown;
}

export interface TraceResult {
  status: string;
  reason: string | null;
  [key: string]: unknown;
}

export interface TraceUsage {
  requests?: number;
  cost_usd?: number;
  jev_ms?: number;
  browser_ms?: number;
  settle_ms?: number;
  wall_ms?: number;
  input_tokens?: number;
  resolved_model?: string | null;
  [key: string]: unknown;
}

export interface TraceData {
  run_id: string;
  started_at: string;
  finished_at?: string;
  goal?: string;
  subgoals?: unknown[];
  steps: TraceStep[];
  result: TraceResult | null;
  usage?: TraceUsage;
  [key: string]: unknown;
}

export interface Trace {
  runId: string;
  step(entry: TraceStep): void;
  finish(result: TraceResult, usage: TraceUsage): TraceData;
  readonly data: TraceData;
}

export function newRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * One line per run in summary.jsonl.
 *
 * The full traces are large and one file each, which is right for debugging a
 * single run and useless for the question that actually matters: how often does
 * this hand back to Claude, and at what confidence. The PRD sets a target of
 * under 30% escalation and nothing measured it. This is the cheapest thing that
 * makes the rate and the confidence spread computable from real usage, so
 * min_confidence can be tuned from data rather than from a guess.
 */
function appendSummary(dir: string, trace: TraceData): void {
  const confidences = trace.steps
    .map((s) => (s.answers as { operation?: { confidence?: unknown } } | null | undefined)?.operation?.confidence)
    .filter((c): c is number => typeof c === "number")
    .map((c) => Number(c.toFixed(3)));
  const line = {
    run_id: trace.run_id,
    at: trace.finished_at,
    goal: trace.goal,
    subgoals: (trace.subgoals || []).length || 1,
    status: trace.result?.status,
    // The single number the PRD's escalation target is about.
    escalated: trace.result?.status === "needs_help" || trace.result?.status === "needs_value",
    reason: trace.result?.reason ?? null,
    steps: trace.steps.length,
    confidences,
    satisfied_final: trace.steps.at(-1)?.satisfied ?? null,
    rows_offered_max: Math.max(0, ...trace.steps.map((s) => s.rows_offered ?? 0)),
    rows_cut_total: trace.steps.reduce((a, s) => a + (s.rows_cut ?? 0), 0),
    requests: trace.usage?.requests ?? null,
    cost_usd: trace.usage?.cost_usd ?? null,
    jev_ms: trace.usage?.jev_ms ?? null,
    browser_ms: trace.usage?.browser_ms ?? null,
    settle_ms: trace.usage?.settle_ms ?? null,
    wall_ms: trace.usage?.wall_ms ?? null,
    input_tokens: trace.usage?.input_tokens ?? null,
    model: trace.usage?.resolved_model ?? null,
  };
  fs.appendFileSync(path.join(dir, "summary.jsonl"), JSON.stringify(line) + "\n");
}

export function createTrace(dir: string, meta: Record<string, unknown>): Trace {
  const runId = newRunId();
  const trace: TraceData = {
    run_id: runId,
    started_at: new Date().toISOString(),
    ...meta,
    steps: [],
    result: null,
  };

  return {
    runId,
    step(entry) {
      trace.steps.push(entry);
    },
    finish(result, usage) {
      trace.result = result;
      trace.usage = usage;
      trace.finished_at = new Date().toISOString();
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify(trace, null, 2));
        appendSummary(dir, trace);
      } catch (err) {
        process.stderr.write(`[jev] could not write trace: ${errorMessage(err)}\n`);
      }
      return trace;
    },
    get data() {
      return trace;
    },
  };
}
