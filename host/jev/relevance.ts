// Deterministic narrowing of the action space, before any Jev call.
//
// Why this exists: a Wikipedia article yields 602 usable rows against a
// 255-option provider ceiling, which forced a Jev *scoring* request on every
// single step — doubling the round trips on exactly the pages that are already
// slowest. It also split probability mass across hundreds of options, which
// deflated confidence and escalated runs that were going fine.
//
// Measured composition of those 602 rows:
//
//     320  article links (body prose)
//     139  other links
//     115  citation markers — "[1]", "[2]", ...
//      14  controls (buttons and inputs)
//      11  no accessible name at all
//
// A purely lexical filter is NOT safe here: the goal "open the page's edit
// history" has zero word overlap with the link that does it, "Past revisions of
// this page". So lexical matching only ever ADDS rows here, never removes them.
// What removes rows is noise detection and, as a last resort, document order.

import type { Row } from "./types.ts";
import { textOf } from "../text.ts";

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "this",
  "that",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "it",
  "its",
  "at",
  "by",
  "from",
  "as",
  "page",
  "open",
  "click",
  "go",
  "show",
  "shown",
  "find",
  "get",
]);

export function termsFrom(...sources: unknown[]): Set<string> {
  const out = new Set<string>();
  for (const src of sources) {
    for (const word of textOf(src)
      .toLowerCase()
      .split(/[^a-z0-9]+/)) {
      if (word.length >= 3 && !STOPWORDS.has(word)) out.add(word);
    }
  }
  return out;
}

/**
 * Rows that carry no decision value on any page.
 *
 * Kept deliberately narrow — every pattern here must be one that cannot be the
 * thing the user asked for. A citation marker is never a navigation target; a
 * row with neither a name nor a destination cannot be described to Jev at all.
 */
/** The fields relevance reads. Partial, so a row being built can be scored too. */
type Scorable = Partial<Row>;

export function isNoise(row: Scorable): boolean {
  const name = (row.name || "").trim();
  if (!name && !row.href && !row.type && !row.section) return true;
  if (/^\[?\d{1,4}\]?$/.test(name)) return true; // [1], [12], 3
  if (/^\[(edit|citation needed|note \d+)\]$/i.test(name)) return true;
  return false;
}

/** A control is always worth offering: it is what actions are made of. */
export function isControl(row: Scorable): boolean {
  const role = (row.role || "").toLowerCase();
  return (
    Boolean(row.type) ||
    Array.isArray(row.options) ||
    [
      "button",
      "textbox",
      "searchbox",
      "combobox",
      "listbox",
      "checkbox",
      "radio",
      "switch",
      "select",
      "textarea",
      "spinbutton",
      "menuitem",
      "tab",
    ].includes(role)
  );
}

export function lexicalScore(row: Scorable, terms: ReadonlySet<string>): number {
  if (!terms.size) return 0;
  // The section is included so a goal naming a card ("set Social history to
  // Paragraph") pulls that card's controls into the always-keep tier, wherever
  // they sit in document order.
  const hay = `${row.name || ""} ${row.section || ""} ${row.href || ""} ${row.role || ""}`.toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return hits;
}

// Off-screen rows only earn a place by matching the goal, and a common goal
// word can match hundreds of them. Keep the strongest of those, not all.
export const OFFSCREEN_MATCH_CAP = 60;

/**
 * Goal words that say nothing about THIS page's rows: the site's own name.
 * "Search Wikipedia for Nautilus" put "wikipedia" in the terms, and every href
 * on Wikipedia contains it, so every link on the page counted as a goal match
 * and the tier meant to narrow the page kept all of it.
 */
function withoutSiteTerms(terms: Set<string>, pageUrl: string | undefined): Set<string> {
  let host = "";
  try {
    host = new URL(pageUrl ?? "").hostname.toLowerCase();
  } catch {
    return terms;
  }
  const out = new Set<string>();
  for (const t of terms) if (!host.includes(t)) out.add(t);
  return out;
}

/**
 * Narrow `rows` to at most `limit`, without asking Jev anything.
 *
 * When rows say whether they are on screen (a jev_snapshot observation), the
 * action space is what the user can see plus whatever the goal names:
 *   1. rows matching the goal's own words, anywhere on the page (off-screen
 *      ones capped at OFFSCREEN_MATCH_CAP, strongest first)
 *   2. on-screen controls, then other on-screen rows
 *   everything else off screen is dropped — SCROLL reaches it if it matters
 * This follows jev-ultrafast, which offers only visible controls. The goal
 * tier is our addition, so a named target deep in the page is still one
 * CLICK away rather than a run of scrolls.
 *
 * Without on-screen information (the old read_page observation) the tiers are
 * the original three:
 *   1. rows matching the goal's own words, strongest match first
 *   2. controls, which are what actions are made of
 *   3. everything else, in document order, until the budget runs out
 *
 * Noise is dropped outright and never competes for the budget.
 *
 * Document order is the tie-breaker rather than a judgement: read_page emits in
 * document order, and actionable page chrome (nav, toolbars, tabs) sits near the
 * top while body prose runs long. Measured: the target was row 21 on the article
 * page and row 4 on the search page.
 *
 * Returns the surviving rows in document order — Jev reads them as a page.
 */
export interface PrefilterOptions {
  goal?: string | undefined;
  successCriteria?: string | undefined;
  values?: Record<string, string> | undefined;
  /** Most rows to keep. Unbounded when absent. */
  limit?: number | undefined;
  pageUrl?: string | undefined;
}

export interface PrefilterResult {
  rows: Row[];
  noise: number;
  offscreen: number;
  overflow: number;
  signal: number;
  matched: number;
}

export function prefilter(
  rows: Row[],
  { goal, successCriteria, values, limit = Infinity, pageUrl }: PrefilterOptions = {},
): PrefilterResult {
  const terms = withoutSiteTerms(
    termsFrom(goal, successCriteria, ...Object.keys(values || {}), ...Object.values(values || {})),
    pageUrl,
  );
  const knowsView = rows.some((r) => typeof r.inView === "boolean");

  const kept = new Set<Row>();
  const matched: Array<{ row: Row; score: number; order: number }> = [];
  const controls: Row[] = [];
  const rest: Row[] = [];
  let noise = 0;
  let offscreen = 0;

  rows.forEach((row, order) => {
    if (isNoise(row)) {
      noise++;
      return;
    }
    const score = lexicalScore(row, terms);
    if (score > 0) matched.push({ row, score, order });
    else if (knowsView && !row.inView) offscreen++;
    else if (isControl(row)) controls.push(row);
    else rest.push(row);
  });

  // Goal matches outrank plain controls, and a stronger match outranks a weaker
  // one. On a page that is ALL controls — a form of repeated cards is exactly
  // that — treating "is a control" as the top tier means document order fills
  // the budget before reaching the card the goal actually named.
  matched.sort((a, b) => b.score - a.score || a.order - b.order);

  let offscreenMatches = 0;
  for (const { row } of matched) {
    if (kept.size >= limit) break;
    if (knowsView && !row.inView) {
      if (offscreenMatches >= OFFSCREEN_MATCH_CAP) {
        offscreen++;
        continue;
      }
      offscreenMatches++;
    }
    kept.add(row);
  }
  for (const row of controls) {
    if (kept.size >= limit) break;
    kept.add(row);
  }
  for (const row of rest) {
    if (kept.size >= limit) break;
    kept.add(row);
  }

  const out = rows.filter((r) => kept.has(r));
  return {
    rows: out,
    noise,
    offscreen,
    overflow: rows.length - noise - offscreen - out.length,
    signal: matched.length + controls.length,
    matched: matched.length,
  };
}
