// Evidence: the passage of the page each answer rests on, quoted verbatim.
//
// Without it, Claude got a probability and an excerpt cut from the top of the
// page. On a 123loger ad the "Lave-linge" line sits in the equipment list,
// past the excerpt, so a correct "washing machine: yes" could not be checked
// and every doubtful row cost a second visit to the page. Station names were
// out of reach entirely: a choice question can say "line 14", not "Olympiades".
//
// Jev still never writes. The page is cut into numbered passages, and each of
// Claude's questions gets a companion choice question, "which passage supports
// your answer?", whose options are those numbers. The server then returns the
// chosen passage as it stands on the page: a selection, not a paraphrase.

import { MAX_CHOICES } from "./config.ts";
import type { Answer, ClaudeQuestion, JevQuestions } from "./types.ts";
import { textOf } from "../text.ts";

export const EVIDENCE_SUFFIX = "__evidence";
const NONE = "none";

// Long enough to hold a sentence or an equipment list, short enough that the
// quote points at one fact.
const MAX_PASSAGE = 280;
// Fragments under this ("Voir plus", a lone price) join their neighbour.
const MIN_PASSAGE = 40;
// A runner-up passage is quoted too when it is this likely: answers often
// rest on two places, e.g. a description and the equipment list.
const SECOND_P = 0.25;

/** Cut a long run of text at word boundaries into pieces of at most `max`. */
function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * The page text as passages, in order. Sentences and bullets first, then
 * short fragments merged forward and long runs cut, and finally neighbours
 * paired until the count fits a choice question (one option is kept for
 * "none").
 */
export function splitPassages(
  text: unknown,
  {
    max = MAX_PASSAGE,
    min = MIN_PASSAGE,
    limit = MAX_CHOICES - 1,
  }: { max?: number; min?: number; limit?: number } = {},
): string[] {
  const raw = textOf(text)
    .split(/(?<=[.!?…])\s+(?=\S)|\s+(?=[•·▪◦–-]\s)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => hardSplit(s, max));
  const merged: string[] = [];
  for (const s of raw) {
    const last = merged[merged.length - 1];
    if (last != null && (last.length < min || s.length < min) && last.length + s.length + 1 <= max) {
      merged[merged.length - 1] = `${last} ${s}`;
    } else {
      merged.push(s);
    }
  }
  let out = merged;
  while (out.length > limit) {
    const paired: string[] = [];
    for (let i = 0; i < out.length; i += 2) {
      const [a = "", b] = [out[i], out[i + 1]];
      paired.push(b != null ? `${a} ${b}` : a);
    }
    out = paired;
  }
  return out;
}

/** The text Jev reads: every passage behind its number. */
export function numberedText(passages: readonly string[]): string {
  return passages.map((p, i) => `[${i + 1}] ${p}`).join("\n");
}

/** One companion question per question of Claude's, in the Decisions API's shape. */
export function evidenceQuestions(
  questions: readonly Pick<ClaudeQuestion, "key" | "question">[],
  count: number,
): JevQuestions {
  const criteria: Record<string, string> = {};
  for (let i = 1; i <= count; i++) criteria[`p${i}`] = `Passage [${i}]`;
  criteria[NONE] = "No passage bears on it";
  const out: JevQuestions = {};
  for (const q of questions) {
    out[q.key + EVIDENCE_SUFFIX] = {
      type: "choice",
      instructions:
        `The page is split into numbered passages [1], [2], … Which passage is the strongest evidence for the answer to this question: "${q.question}"? ` +
        `Pick the passage that states the fact, not one that merely repeats the topic. If nothing on the page bears on it, pick "${NONE}".`,
      criteria,
    };
  }
  return out;
}

/**
 * The quote for one answer, from its companion's normalized answer: the chosen
 * passage verbatim, plus a close runner-up. Null when Jev found nothing.
 */
export function pickEvidence(answer: Answer | null | undefined, passages: readonly string[]): string | null {
  if (!answer || answer.type !== "choice" || !answer.choice || answer.choice === NONE) return null;
  const ranked = Object.entries(answer.probabilities || {})
    .filter(([k]) => k !== NONE)
    .sort((a, b) => b[1] - a[1]);
  const at = (k: string): string | undefined => passages[Number(k.slice(1)) - 1];
  const first = at(answer.choice);
  if (first == null) return null;
  const quotes = [first];
  const second = ranked.find(([k]) => k !== answer.choice);
  const secondQuote = second && second[1] >= SECOND_P ? at(second[0]) : undefined;
  if (secondQuote != null) quotes.push(secondQuote);
  return quotes.join(" … ");
}
