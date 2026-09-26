// Claude's own questions, as jev_assess and jev_navigate both accept them.
//
// Claude writes a question once ("is the toggle off?", "is this a good
// deal?") and Jev answers it with a probability over options Claude defined —
// it never writes text. These helpers turn the tool's question list into the
// Decisions API's shape, refuse a malformed list before any browsing, and
// compact an answer for Claude to read.

import type { Answer, ClaudeQuestion, CompactAnswer, JevQuestions } from "./types.ts";

const RESERVED_KEYS = new Set(["model", "usage", "id"]);

/** Claude's question spec, as the Decisions API wants it. */
export function buildQuestions(questions: readonly ClaudeQuestion[]): JevQuestions {
  const out: JevQuestions = {};
  for (const q of questions) {
    const instructions = q.question;
    if (q.type === "yes_no") {
      out[q.key] = {
        type: "noul",
        instructions,
        criteria: { true: q.yes || "Yes", false: q.no || "No" },
      };
    } else if (q.type === "choice") {
      out[q.key] = { type: "choice", instructions, criteria: q.options ?? {} };
    } else if (q.type === "score") {
      out[q.key] = { type: "score", instructions, criteria: q.scale ?? [] };
    }
  }
  return out;
}

/** Why the question list cannot be sent, or null. Checked before any browsing. */
export function questionsError(questions: unknown): string | null {
  if (!Array.isArray(questions) || questions.length === 0) return "At least one question is required.";
  const keys = new Set<string>();
  // Checked field by field below: this list comes straight off the wire.
  for (const q of questions as Partial<ClaudeQuestion>[]) {
    if (!q.key || !/^[A-Za-z_][\w-]{0,40}$/.test(q.key)) return `Question key "${q.key}" must be a short identifier.`;
    if (keys.has(q.key)) return `Question key "${q.key}" is used twice.`;
    // The client reads a bare response's own fields under these names.
    if (RESERVED_KEYS.has(q.key)) return `Question key "${q.key}" is reserved; use another name.`;
    // Evidence rides along as a companion question under this suffix.
    if (q.key.endsWith("__evidence"))
      return `Question key "${q.key}" ends in "__evidence", which is reserved; use another name.`;
    keys.add(q.key);
    if (!q.question) return `Question "${q.key}" has no text.`;
    if (q.type === "choice" && (!q.options || Object.keys(q.options).length < 2)) {
      return `Choice question "${q.key}" needs at least two options.`;
    }
    if (q.type === "score" && (!Array.isArray(q.scale) || q.scale.length < 2)) {
      return `Score question "${q.key}" needs a scale of at least two labels.`;
    }
    if (!["yes_no", "choice", "score"].includes(q.type ?? "")) return `Question "${q.key}" has unknown type ${q.type}.`;
  }
  return null;
}

/**
 * One answer, compacted for Claude to read in a table.
 *
 * The full distributions stay out: across 30 items they are most of the
 * payload and almost all zeros. What is kept is what a decision needs — the
 * answer, how sure, and the runner-up when it was close.
 */
export function compactAnswer(a: Answer | null | undefined): CompactAnswer | null {
  if (!a) return null;
  const r3 = (x: unknown) => Number(Number(x).toFixed(3));
  if (a.type === "noul") return { yes: r3(a.noul) };
  if (a.type === "choice") {
    const ranked = Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1]);
    const out: CompactAnswer = {
      choice: a.choice,
      p: r3((a.choice !== undefined ? a.probabilities?.[a.choice] : undefined) ?? a.confidence ?? 0),
    };
    const second = ranked[1];
    if (second && second[1] >= 0.15) out.runner_up = { choice: second[0], p: r3(second[1]) };
    return out;
  }
  if (a.type === "score") {
    const label = a.legend?.[Math.round(a.score ?? 0)];
    return { score: r3(a.score), ...(label ? { label } : {}), confidence: r3(a.confidence ?? 0) };
  }
  return null;
}
