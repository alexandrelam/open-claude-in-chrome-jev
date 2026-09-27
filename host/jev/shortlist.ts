// Fitting a large page into Jev's 32k-token context.
//
// The PRD framed this as a row count ("more than about 120 rows"). Row count is
// a poor proxy — one row carrying a 100-char name and a long href costs several
// times what a bare `button "OK"` does — so the real gate is an estimate of the
// serialized state against the context window, with the row count kept as a
// cheap secondary cap on how many options a single Choice question should carry.
//
// Approach follows vlad-terin/jev-browser's split/shortlist/reduce shape,
// reimplemented rather than copied (its licence is not ours to assume).

import { prefilter } from "./relevance.ts";
import type { Decide, JevQuestions, Row } from "./types.ts";

export const JEV_CONTEXT_TOKENS = 32_000;

// Leave the question criteria, instructions and the answer room. The state is
// the part that scales with the page; everything else is roughly fixed.
export const STATE_TOKEN_BUDGET = 20_000;

/** Rough but stable: ~4 characters per token for this kind of text. */
export function estimateTokens(value: unknown): number {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(s.length / 4);
}

/** The one-line form of a row that Jev sees, as both state and criteria. */
export function renderRow(row: Row, id: string): string {
  const bits = [id, row.role || "element"];
  if (row.name) bits.push(row.name);
  // The owning section goes in the main run of fields, not the trailing extras:
  // on a repeated-card form it is the only thing distinguishing one row from
  // sixteen others, so it has to be as prominent as the label itself.
  if (row.section) bits.push(`in ${row.section}`);
  const line = bits.join(" | ");
  const extra = [];
  if (row.value) extra.push(`value="${row.value}"`);
  if (row.type) extra.push(`type=${row.type}`);
  for (const key of ["checked", "expanded", "selected"]) {
    const flag = row[key as "checked" | "expanded" | "selected"];
    if (flag !== undefined && flag !== "") extra.push(`${key}=${flag}`);
  }
  if (row.required) extra.push("required");
  // Said outright, not left to inference: a disabled Save is usually the
  // reason a form leg is stuck, and Jev can only report that if it sees it.
  if (row.disabled) extra.push("disabled");
  if (row.options?.length)
    extra.push(
      `options=${row.options
        .slice(0, 8)
        .map((o) => o.label)
        .join("/")}`,
    );
  return extra.length ? `${line} | ${extra.join(" ")}` : line;
}

/**
 * Cut the row list into contiguous sections.
 *
 * Contiguity is the point: read_page emits rows in document order, so a run of
 * adjacent rows is a run of adjacent controls — a nav bar, a table, a form.
 * Indentation is used only as a hint for where to prefer a boundary, never as
 * structure, because the renderer only indents for ancestors that were
 * themselves shown and visible (extension/content.ts L236).
 */
export function splitSections(rows: Row[], target = 20): Row[][] {
  const sections: Row[][] = [];
  let cur: Row[] = [];
  for (const row of rows) {
    if (cur.length >= target && row.indent <= (cur[0]?.indent ?? 0)) {
      sections.push(cur);
      cur = [];
    }
    cur.push(row);
    if (cur.length >= target * 2) {
      sections.push(cur);
      cur = [];
    }
  }
  if (cur.length) sections.push(cur);
  return sections;
}

const SCALE = ["Irrelevant", "Possibly relevant", "Directly relevant"];

/**
 * Reduce rows to what fits, scoring sections for relevance when needed.
 *
 * Returns { rows, cut, sections, scored } — `cut` feeds the step log, because a
 * row that was cut cannot be chosen, and that is the first thing to check when
 * a step comes back BLOCKED on a page that plainly had the right button.
 */
export interface ShortlistOptions {
  goal?: string | undefined;
  successCriteria?: string | undefined;
  values?: Record<string, string> | undefined;
  maxRows: number;
  /** Scores sections when the page does not fit. Without it, the head of the page is kept. */
  decide?: Decide | null | undefined;
  pageUrl?: string | undefined;
}

export interface Shortlist {
  rows: Row[];
  cut: number;
  scored: boolean;
  sections: number;
  noise?: number;
  offscreen?: number;
}

export async function shortlistRows(
  rows: Row[],
  { goal, successCriteria, values, maxRows, decide, pageUrl }: ShortlistOptions,
): Promise<Shortlist> {
  // Deterministic narrowing first. It costs nothing, and on a dense page it
  // usually gets under the cap on its own — which is the whole point, because
  // the scoring pass below is a second Jev round trip on every step.
  const pre = prefilter(rows, { goal, successCriteria, values, limit: maxRows, pageUrl });
  const narrowed = pre.rows;

  const fits =
    narrowed.length <= maxRows &&
    estimateTokens(narrowed.map((r, i) => renderRow(r, `e${i + 1}`)).join("\n")) <= STATE_TOKEN_BUDGET;
  if (fits) {
    return {
      rows: narrowed,
      cut: rows.length - narrowed.length,
      noise: pre.noise,
      offscreen: pre.offscreen,
      scored: false,
      sections: 1,
    };
  }

  rows = narrowed;
  const sections = splitSections(rows);

  // No scorer available (jev_decide's advisory path, or a client-less test):
  // keep the head of the page deterministically rather than guessing.
  if (typeof decide !== "function" || sections.length < 2) {
    const kept = rows.slice(0, maxRows);
    return { rows: kept, cut: rows.length - kept.length, scored: false, sections: sections.length };
  }

  const state = {
    goal,
    success_criteria: successCriteria,
    sections: sections.map((sec, i) => ({
      id: `s${i + 1}`,
      elements: sec.map((r, j) => renderRow(r, `e${j + 1}`)),
    })),
  };
  const questions: JevQuestions = {};
  sections.forEach((_, i) => {
    questions[`s${i + 1}`] = {
      type: "score",
      instructions: `How relevant is section s${i + 1} to the goal? Consider only whether the next action is likely to be found there.`,
      criteria: SCALE,
    };
  });

  // All sections are scored in one request: questions in a Decisions call are
  // evaluated in parallel, so this costs one round trip regardless of count.
  const { answers } = await decide(state, questions);

  const ranked = sections
    .map((sec, i) => ({ sec, score: answers[`s${i + 1}`]?.score ?? 0, index: i }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const kept: Row[] = [];
  for (const { sec } of ranked) {
    if (kept.length + sec.length > maxRows && kept.length > 0) continue;
    kept.push(...sec);
    if (kept.length >= maxRows) break;
  }
  // Put survivors back in document order — Jev reads them as a page, and
  // relevance order would scramble the reading.
  const keptSet = new Set(kept);
  const ordered = rows.filter((r) => keptSet.has(r));

  return {
    rows: ordered.slice(0, maxRows),
    cut: rows.length - Math.min(ordered.length, maxRows),
    scored: true,
    sections: sections.length,
  };
}
