// The navigator: one Jev decision per browser step, with a deterministic gate
// between the decision and the action.
//
// The division of labour the PRD asks for: Claude plans and supplies text, Jev
// picks one operation and one target per step, this file checks the pick and
// carries it out through the ordinary tools, and the extension performs it in
// the real profile. Jev never sees a selector and never returns one.

import {
  observe,
  hasJevTools,
  observationSignature,
  type ObserveOptions,
  isToolError,
  resultText,
  usableRows,
} from "./observe.ts";
import {
  OPERATIONS,
  availableOperations,
  isCompatible,
  looksSensitive,
  planToolCalls,
  rowLabel,
  SUBMITTING_OPERATIONS,
  TARGET_HEADS,
  DEMOTIONS,
  targetHead,
  namesAgree,
  isOperation,
} from "./actions.ts";
import { shortlistRows, renderRow } from "./shortlist.ts";
import {
  buildGraph,
  exploreForAction,
  exploreSettings,
  readForQuestions,
  rethink,
  traceOf,
  type Coverage,
  type PageReading,
} from "./explore.ts";
import { termsFrom, lexicalScore, prefilter } from "./relevance.ts";
import { buildQuestions, questionsError, compactAnswer } from "./questions.ts";
import { EVIDENCE_SUFFIX, splitPassages, numberedText, evidenceQuestions, pickEvidence } from "./evidence.ts";
import { MAX_CHOICES } from "./config.ts";
import { createTrace } from "./trace.ts";
import { BudgetExceeded } from "./client.ts";
import { errorMessage } from "../errors.ts";
import type { Operation } from "./actions.ts";
import type { Shortlist } from "./shortlist.ts";
import type { Trace, TraceUsage } from "./trace.ts";
import type { DecideArgs, SubgoalArgs } from "./tools.ts";
import type {
  Answers,
  CallTool,
  ClaudeQuestion,
  CompactAnswer,
  Decide,
  ExploreMode,
  JevClient,
  JevConfig,
  JevQuestions,
  Observation,
  PlannedCall,
  Row,
  RowOption,
  ScrollState,
} from "./types.ts";

/** One leg of a run, normalized from either input shape. */
export interface Subgoal {
  goal: string | undefined;
  successCriteria: string | undefined;
  values: Record<string, string>;
  optional?: boolean | null;
  fillDefaults: boolean;
  /** Asked of the page this leg ends on, once it is done. */
  questions?: ClaudeQuestion[] | null;
}

/** A leg as a caller may write it: the tool's snake_case, or camelCase. */
export type SubgoalInput = Partial<SubgoalArgs> & { successCriteria?: string | undefined };

/**
 * What navigate() accepts: jev_navigate's arguments, plus the camelCase
 * spellings and the per-call step cap that internal callers pass.
 */
export interface NavigateInput {
  tabId: number;
  goal?: string | undefined;
  success_criteria?: string | undefined;
  successCriteria?: string | undefined;
  subgoals?: SubgoalInput[] | undefined;
  values?: Record<string, string> | undefined;
  fill_defaults?: boolean | undefined;
  continue_on_failure?: boolean | undefined;
  continueOnFailure?: boolean | undefined;
  questions?: ClaudeQuestion[] | undefined;
  start_url?: string | undefined;
  final_check?: string | undefined;
  finalCheck?: string | undefined;
  max_steps?: number | undefined;
  max_ms?: number | undefined;
  min_confidence?: number | undefined;
  allow_sensitive?: boolean | undefined;
  explore?: ExploreMode | undefined;
}

/** Why a step or run stopped short. */
interface Failure {
  status: string;
  reason: string;
}

/** The gate's verdict on one decision. */
export type Verdict =
  | {
      ok: true;
      operation: Operation;
      row: Row | null;
      value: string | undefined;
      confidence: number;
      sensitive: boolean;
      demotedFrom: Operation | null;
      defaulted?: boolean;
      status?: undefined;
      reason?: undefined;
    }
  | {
      ok: false;
      status: string;
      reason: string;
      operation?: string | undefined;
      row?: Row | null;
      confidence?: number;
      sensitive?: boolean;
      value?: undefined;
      demotedFrom?: undefined;
      defaulted?: undefined;
    };

/** One Jev request for one step, and how to map its answer back to rows. */
export interface StepRequest {
  state: Record<string, unknown>;
  questions: JevQuestions;
  idMap: Map<string, Row>;
}

/** What the loop remembers across the legs of one call. */
interface RunContext {
  obs: Observation | null;
  deadline: number;
  decisionNo: number;
  actionNo: number;
  browserMs: number;
  jevMs: number;
  settleMs: number;
  /** When a page too big for one request is explored region by region. */
  explore: ExploreMode;
}

/** The next leg's first decision, answered by this leg's last request. */
interface Carry {
  obs: Observation;
  short: Shortlist;
  request: StepRequest;
  answers: Answers;
  verdict: Verdict;
}

interface ActionStep {
  i: number;
  operation: string;
  target_ref: string | null;
  target_label: string;
  confidence: number | undefined;
  demoted_from?: Operation;
  defaulted_value?: string | undefined;
  ms: number;
}

interface BriefRow {
  ref: string;
  role: string;
  name: string;
  section?: string;
  required?: true;
}

interface Blockers {
  disabled: BriefRow[];
  empty: BriefRow[];
}

interface LegResult {
  status: string;
  reason: string | null;
  steps: ActionStep[];
  recovered: string[];
  fatal?: boolean;
  blockers?: Blockers;
  satisfied?: number;
  carry?: Carry | null;
}

interface LegSummary {
  i: number;
  goal: string | undefined;
  status: string;
  steps: ActionStep[];
  reason: string | null;
  blockers?: Blockers;
  recovered?: string[];
  skipped?: true;
  /** Answers to this leg's own questions, about the page it ended on. */
  answers?: Record<string, CompactAnswer | null>;
  /** Set when the answers describe a page the leg did not finish on. */
  answers_note?: string;
  /** How much of the page the answers rest on. */
  coverage?: Coverage;
}

/** What jev_navigate returns. */
export interface NavigateResult {
  status: string;
  reason: string | null;
  steps?: ActionStep[];
  subgoals?: LegSummary[];
  final_url?: string;
  final_title?: string;
  answers?: Record<string, CompactAnswer | null>;
  /** Set when `answers` describe the page where a leg stopped the run. */
  answers_note?: string;
  /** How much of the page `answers` rest on: all of it, the regions explored, or passages chosen from them. */
  coverage?: Coverage;
  blockers?: Blockers;
  remaining_subgoals?: SubgoalInput[];
  page_excerpt?: { url: string; title: string; text: string; interactive: string[] } | null;
  usage?: TraceUsage;
  run_id?: string;
}

/** What jev_decide returns: the proposal, and how sure Jev was of it. */
export interface DecideOnceResult {
  status: string;
  reason: string | null;
  operation?: string | undefined;
  target_ref?: string | null;
  target_label?: string;
  value?: string | undefined;
  confidence?: number | null;
  sensitive_probability?: number | null;
  probabilities?: {
    operation: Array<{ choice: string; p: number }>;
    target: Array<{ ref: string; label: string; p: number }>;
  };
  rows_offered?: number;
  rows_cut?: number;
  truncated?: boolean;
  url?: string;
  title?: string;
  jev_ms?: number;
  /** The proposal came from a second look over the regions the goal is about. */
  explored?: boolean;
  usage?: unknown;
}

type ObserveOutcome = { obs: Observation; failure: null } | { obs: Observation | null; failure: Failure };

const NONE = "NONE";

// How sure Jev must be to type a value into a field whose name shares no word
// with the value's label. An optional leg asked to type into a comment box, on
// a page without one, typed into an unrelated field at 0.65, which passed the
// ordinary gate.
const MISMATCH_CONFIDENCE = 0.85;

/**
 * Does the field look like the one the value's label names? True when a word
 * of the label appears in the field's name or section, or when there is
 * nothing to compare (a short key like "q", an unnamed field).
 */
export function valueFitsField(key: string, row: Row | null | undefined): boolean {
  const label = `${row?.name ?? ""} ${row?.section ?? ""}`;
  // Whole words, not substrings: "add" from "Add a comment" is not in
  // "Shipping address". Hyphens are also read joined, so "E-mail" is "email".
  const words = termsFrom(label, label.replace(/[-_.]/g, ""));
  const terms = [...termsFrom(key, key.replace(/[-_.]/g, ""))];
  if (!terms.length || !words.size) return true;
  // Or a shared five-letter stem, so "settings" meets "setting".
  const stem = (w: string) => (w.length >= 5 ? w.slice(0, 5) : w);
  const stems = new Set([...words].map(stem));
  return terms.some((t) => words.has(t) || (t.length >= 5 && stems.has(stem(t))));
}

// How many times one subgoal may recover from a failure on its own before it
// hands back. Each recovery is a fresh look at the page and a fresh decision,
// so this bounds the extra Jev requests a flaky page can cost.
const MAX_RECOVERIES = 2;

// The longest one WAIT holds for the page to change before Jev looks again.
const WAIT_MS = 5000;

/**
 * Will activating this href replace the document?
 *
 * A same-page fragment does not navigate; anything else does. Used to decide
 * what "the action landed" means for a CLICK — see the settle check below.
 */
export function navigatesAway(href: string | null | undefined, currentUrl: string): boolean {
  if (!href) return false;
  try {
    const target = new URL(href, currentUrl);
    const here = new URL(currentUrl);
    return target.origin !== here.origin || target.pathname !== here.pathname || target.search !== here.search;
  } catch {
    return false;
  }
}

/**
 * Does the page's URL contradict what the success criteria say it contains?
 *
 * `satisfied` is Jev's reading of the page, and the page it reads is controls
 * plus a short excerpt, not the address bar. Asked whether "tagfilter=mobile
 * edit in the URL" held, it said yes on a URL with no tagfilter at all, and
 * the leg finished without clicking. When the criteria spell out key=value in
 * the URL, that part can be checked exactly, so it is: a mismatch overrides
 * the model. Anything the criteria say in prose is still left to Jev.
 *
 * Returns the first mismatch as a sentence, or null when nothing contradicts.
 */
export function urlContradicts(criteria: string | null | undefined, url: string): string | null {
  if (!criteria || !/\burl\b/i.test(criteria)) return null;
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return null;
  }
  const loose = (v: string) => v.replace(/\+/g, " ").trim().toLowerCase();
  for (const [, key = "", raw = ""] of criteria.matchAll(/([A-Za-z_][\w.-]*)=("[^"]*"|'[^']*'|[^\s,;)]+)/g)) {
    const want = loose(raw.replace(/^["']|["']$/g, ""));
    const got = params.get(key);
    // A prefix is enough: "tagfilter=mobile edit" parses as tagfilter=mobile.
    if (got === null || !loose(got).startsWith(want)) {
      return `the success criteria require ${key}=${want} in the URL, and the URL has ${got === null ? `no ${key}` : `${key}=${loose(got)}`}`;
    }
  }
  return null;
}

export function hostOf(url: string | null | undefined): string {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}

export function domainAllowed(
  url: string | null | undefined,
  cfg: Pick<JevConfig, "allowedDomains" | "blockedDomains">,
): boolean {
  const host = hostOf(url);
  if (!host) return true;
  const matches = (d: string) => host === d || host.endsWith(`.${d}`);
  if (cfg.blockedDomains?.some(matches)) return false;
  // null means no allowlist at all. An empty array is an allowlist that permits
  // nothing, which is a legitimate way to switch the loop off for a session.
  if (cfg.allowedDomains === null || cfg.allowedDomains === undefined) return true;
  return cfg.allowedDomains.some(matches);
}

// An option that only asks to be replaced: "Select…", "-- choose --", "".
const PLACEHOLDER = /^(|select\b.*|choose\b.*|pick\b.*|--.*|none|n\/a)$/i;

/**
 * The option fill_defaults picks for a native select given no value: the
 * first one that is a real choice and is not already chosen. Undefined when
 * there is none, in which case the step still asks Claude for a value.
 */
export function defaultOption(row: Row | null | undefined): RowOption | undefined {
  return (row?.options ?? []).find(
    (o) => !o.selected && (o.value ?? "").trim() !== "" && !PLACEHOLDER.test((o.label ?? "").trim()),
  );
}

const DEFAULTS_NOTE =
  "Any valid option is acceptable for a choice field (select, combobox, radio, checkbox) that has no provided value. Free text still needs a provided value.";

/**
 * Build the Jev request for one step: the state it reasons over and the four
 * questions, which are answered in parallel inside a single round trip.
 *
 * Rows are addressed as e1..eN, not as ref_N. The mapping back to refs stays in
 * this process, so a ref Jev was not offered cannot come back out of it.
 */
export function buildRequest(
  obs: Pick<Observation, "url" | "title" | "excerpt"> & Partial<Observation>,
  rows: Row[],
  {
    goal,
    successCriteria,
    values,
    fillDefaults = false,
    history = [],
  }: {
    goal: string | undefined;
    successCriteria: string | undefined;
    values?: Record<string, string> | undefined;
    fillDefaults?: boolean;
    history?: unknown[];
  },
  next: Subgoal | null = null,
): StepRequest {
  const idMap = new Map<string, Row>();
  // Last line of defence against the provider's 255-option ceiling. The config
  // clamp normally keeps us well under it; this makes a malformed request
  // impossible to construct even from a caller that built its own cfg.
  const capped = rows.slice(0, MAX_CHOICES);
  const elements = capped.map((row, i) => {
    const id = `e${i + 1}`;
    idMap.set(id, row);
    return renderRow(row, id);
  });

  const valueKeys = Object.keys(values || {});

  // `elements` looks like a duplicate of the target question's criteria and is
  // not. Removing it to halve the payload was tried and reverted on 2026-09-25:
  // the criteria only describe the options for the TARGET question, so the
  // state listing is the only page context the OPERATION question ever sees.
  // Without it Jev picked TYPE_TEXT three times in a row on a field it had
  // already filled, and a task that had been finishing in four steps escalated.
  const state: Record<string, unknown> = {
    goal,
    success_criteria: successCriteria,
    url: obs.url,
    title: obs.title,
    page_excerpt: obs.excerpt,
    elements,
    values: valueKeys,
  };
  // What this leg already did. Without it every decision is made from scratch,
  // and on the audited admin page Jev clicked "New product" three times in a
  // row because each look at the open form still read as "not open yet".
  if (history.length) state.history = history;
  if (fillDefaults) state.defaults = DEFAULTS_NOTE;

  const questions = goalQuestions(idMap, obs.scroll, { successCriteria, values }, "", "");

  // Speculative questions for the NEXT subgoal, answered on this same page.
  //
  // A third of all decisions in the audited Wikipedia chain did nothing but
  // notice that a leg had finished; the next leg then observed the same page
  // and asked again. Questions in one request are evaluated in parallel, so
  // asking the next leg's questions here costs tokens, not time — and when
  // `satisfied` passes, the next leg's first action is already decided.
  // When it does not pass, the next_* answers are simply ignored.
  if (next) {
    const preamble =
      `Assume the current goal is already complete. The NEXT goal is: ${next.goal}. ` +
      `Its success criteria: ${next.successCriteria}. ` +
      (next.fillDefaults ? `${DEFAULTS_NOTE} ` : "") +
      `Answer for that NEXT goal. `;
    Object.assign(questions, goalQuestions(idMap, obs.scroll, next, "next_", preamble));
  }

  return { state, questions, idMap };
}

/**
 * The questions that decide one step toward one goal, keyed with `prefix`.
 * The current goal is carried by `state`; a prefixed goal carries its own
 * description in `preamble`, because state can only describe one.
 */
function goalQuestions(
  idMap: Map<string, Row>,
  scroll: ScrollState | null | undefined,
  { successCriteria, values }: { successCriteria: string | undefined; values?: Record<string, string> | undefined },
  prefix: string,
  preamble: string,
): JevQuestions {
  const ops = availableOperations([...idMap.values()], scroll);
  const valueKeys = Object.keys(values || {});

  const operationCriteria: Record<string, string> = {};
  for (const op of ops) operationCriteria[op] = OPERATIONS[op].description;

  const questions: JevQuestions = {
    [`${prefix}operation`]: {
      type: "choice",
      instructions: `${preamble}What single operation should the browser agent take next to advance the goal? Choose DONE only if the success criteria are already visibly met on this page.`,
      criteria: operationCriteria,
    },
  };

  // One head per kind of operation, each listing only the rows it can act on
  // (see TARGET_HEADS). A head with no legal rows is omitted: a Choice needs
  // something to choose between, and an empty criteria object is malformed.
  //
  // renderRow is the single row renderer, so what Jev chooses between carries
  // the same detail the state listing does (value, type, options).
  for (const [head, spec] of Object.entries(TARGET_HEADS)) {
    const criteria: Record<string, string> = {};
    for (const [id, row] of idMap) {
      if (isCompatible(spec.accepts, row)) criteria[id] = renderRow(row, id);
    }
    if (Object.keys(criteria).length === 0) continue;
    questions[`${prefix}${head}`] = {
      type: "choice",
      instructions: `${preamble}${spec.instructions}`,
      criteria,
    };
  }

  if (valueKeys.length > 0) {
    const valueCriteria: Record<string, string> = { [NONE]: "None of the provided values belongs in this field" };
    for (const k of valueKeys) valueCriteria[k] = `The value provided under "${k}"`;
    questions[`${prefix}value_key`] = {
      type: "choice",
      instructions: `${preamble}If the operation types or selects, which provided value belongs in the target field?`,
      criteria: valueCriteria,
    };
  }

  // Asked on every step, not only when Jev volunteers DONE.
  //
  // Questions in one Decisions request are evaluated in parallel, so this costs
  // essentially nothing — and it removes two round trips per task: the step Jev
  // used to spend choosing DONE, and the separate confirmation request that
  // followed it. On a 4-step task those were 2 of the 5 Jev requests.
  //
  // It also means completion is noticed the moment it happens, including when
  // the goal is already met on arrival.
  questions[`${prefix}satisfied`] = {
    type: "noul",
    instructions: `Judging only by what is on this page right now, are these success criteria met: ${successCriteria}`,
    criteria: {
      true: "The criteria are visibly satisfied by the current page",
      false: "They are not satisfied yet",
    },
  };

  questions[`${prefix}sensitive`] = {
    type: "noul",
    instructions: `${preamble}Would performing this action have a destructive, financial or otherwise irreversible effect?`,
    criteria: {
      true: "It pays, deletes, sends, publishes, submits or otherwise commits something that cannot simply be undone",
      false: "It only navigates, reads, filters or fills in a field, and is safe to undo",
    },
  };

  return questions;
}

/** The answers to one goal's questions, with `prefix` stripped off the keys. */
export function answersFor(answers: Answers, prefix: string): Answers {
  if (!prefix) return answers;
  const out: Answers = {};
  for (const [k, v] of Object.entries(answers || {})) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}

/**
 * Apply every deterministic check to Jev's answers.
 *
 * Never skipped, and deliberately ordered so the cheapest structural failures
 * (unknown operation, unknown ref) are caught before the judgement calls.
 */
export function validate(
  answers: Answers,
  idMap: Map<string, Row>,
  cfg: Pick<JevConfig, "minConfidence" | "sensitiveThreshold">,
  {
    allowSensitive,
    values,
    fillDefaults = false,
  }: { allowSensitive?: boolean | undefined; values?: Record<string, string> | undefined; fillDefaults?: boolean },
): Verdict {
  const opAns = answers["operation"];
  if (!opAns?.choice || !isOperation(opAns.choice)) {
    return { ok: false, status: "needs_help", reason: `Jev returned an unknown operation: ${opAns?.choice}` };
  }
  let operation: Operation = opAns.choice;
  let spec = OPERATIONS[operation];
  let demotedFrom: Operation | null = null;

  if (operation === "BLOCKED") {
    return {
      ok: false,
      status: "blocked",
      operation,
      reason: "Jev reports no offered operation can advance the goal from this page.",
    };
  }

  let row: Row | null = null;
  let confidence = opAns.confidence ?? 0;

  // Unsure whether the page is finished or still coming in: wait and look
  // again. Waiting touches nothing, so doubt about it is no reason to hand
  // back. The first real run stopped after 5 s of a 240 s budget, with WAIT
  // at 0.62 against DONE at 0.38, while a report was still being built.
  if ((operation === "WAIT" || operation === "DONE") && confidence < cfg.minConfidence) {
    return {
      ok: true,
      operation: "WAIT",
      row: null,
      value: undefined,
      confidence,
      sensitive: false,
      demotedFrom: operation === "DONE" ? "DONE" : null,
    };
  }

  if (spec.needsTarget) {
    const head = targetHead(operation);
    const targetAns = head ? answers[head] : undefined;
    row = (targetAns?.choice ? idMap.get(targetAns.choice) : null) ?? null;
    if (!targetAns || !row) {
      return {
        ok: false,
        status: "needs_help",
        operation,
        reason: `Jev chose target "${targetAns?.choice}", which is not in this observation.`,
      };
    }
    // Still checked: a head is shared by operations with different rules
    // (TYPE_AND_SUBMIT refuses a combobox that TYPE_TEXT accepts).
    if (!isCompatible(operation, row)) {
      const lesser = DEMOTIONS[operation];
      if (!lesser || !isCompatible(lesser, row)) {
        return {
          ok: false,
          status: "needs_help",
          operation,
          reason: `Operation ${operation} is not valid on ${rowLabel(row)}.`,
        };
      }
      // Both operations say "act on this field through this head"; they differ
      // only in the part the element refuses. So the mass Jev split between
      // them is all confidence in the part that survives.
      confidence = (opAns.probabilities?.[operation] ?? opAns.confidence ?? 0) + (opAns.probabilities?.[lesser] ?? 0);
      demotedFrom = operation;
      operation = lesser;
      spec = OPERATIONS[operation];
    }
    // Every option in the head is legal for its operation, so the chosen
    // option's probability already is the confidence in the target given the
    // operation. Nothing is left to renormalize.
    const targetConfidence =
      (targetAns.choice !== undefined ? targetAns.probabilities?.[targetAns.choice] : undefined) ??
      targetAns.confidence ??
      0;

    // The step is only as certain as its least certain half: a confident
    // operation aimed at a coin-flip target is not a confident action.
    confidence = Math.min(confidence, targetConfidence);
  }

  if (confidence < cfg.minConfidence) {
    return {
      ok: false,
      status: "needs_help",
      operation,
      row,
      confidence,
      reason: `Confidence ${confidence.toFixed(2)} is below the ${cfg.minConfidence} threshold for ${operation}${row ? ` on ${rowLabel(row)}` : ""}.`,
    };
  }

  const sensitiveByModel = (answers["sensitive"]?.noul ?? 0) > cfg.sensitiveThreshold;
  const sensitiveByLabel = looksSensitive(row);
  if ((sensitiveByModel || sensitiveByLabel) && !allowSensitive) {
    return {
      ok: false,
      status: "needs_help",
      operation,
      row,
      confidence,
      sensitive: true,
      reason: `Refusing a possibly irreversible action: ${operation} on ${rowLabel(row)} (model p=${(answers["sensitive"]?.noul ?? 0).toFixed(2)}${sensitiveByLabel ? ", label matched a sensitive keyword" : ""}). Re-run with allow_sensitive: true, or do this step yourself.`,
    };
  }

  let value: string | undefined;
  if (spec.needsValue) {
    const key = answers["value_key"]?.choice;
    const provided =
      key !== undefined && key !== NONE && values && Object.hasOwn(values, key) ? values[key] : undefined;
    const fits = provided !== undefined;
    // Choice fields only. A select's options are the page's own values, so
    // picking one invents nothing; a text field would need Jev to write text,
    // which it never does.
    const fallback = !fits && fillDefaults && operation === "SELECT" ? defaultOption(row) : undefined;
    if (fallback) {
      return {
        ok: true,
        operation,
        row,
        value: fallback.value,
        confidence,
        sensitive: sensitiveByModel || sensitiveByLabel,
        demotedFrom,
        defaulted: true,
      };
    }
    if (!fits) {
      return {
        ok: false,
        status: "needs_value",
        operation,
        row,
        confidence,
        reason: `${operation} needs a value for ${rowLabel(row)} (role ${row?.role || "unknown"}${row?.type ? `, type ${row.type}` : ""}), and none of the provided values fits. Supply one in \`values\` and call again.`,
      };
    }
    if (key !== undefined && !valueFitsField(key, row) && confidence < MISMATCH_CONFIDENCE) {
      return {
        ok: false,
        status: "needs_help",
        operation,
        row,
        confidence,
        reason: `The value for "${key}" does not look like it belongs in ${rowLabel(row)}, and Jev was only ${confidence.toFixed(2)} sure (${MISMATCH_CONFIDENCE} needed when the names do not match). The field "${key}" may not be on this page.`,
      };
    }
    value = provided;
  }

  return { ok: true, operation, row, value, confidence, sensitive: sensitiveByModel || sensitiveByLabel, demotedFrom };
}

async function observeOrFail(
  callTool: CallTool,
  tabId: number,
  cfg: Pick<JevConfig, "allowedDomains" | "blockedDomains">,
  opts: ObserveOptions = {},
): Promise<ObserveOutcome> {
  const obs = await observe(callTool, tabId, opts);
  if ("error" in obs) return { obs: null, failure: { status: "blocked", reason: obs.error } };
  if (!domainAllowed(obs.url, cfg)) {
    return {
      obs,
      failure: {
        status: "blocked",
        reason: `${hostOf(obs.url)} is outside the configured jev.allowed_domains / blocked in jev.blocked_domains, so no page content was sent and no action was taken.`,
      },
    };
  }
  return { obs, failure: null };
}

function topN(probabilities: Record<string, number> | undefined, n: number): Array<{ choice: string; p: number }> {
  return Object.entries(probabilities ?? {})
    .filter(([, p]) => p > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, p]) => ({ choice: k, p: Number(p.toFixed(3)) }));
}

function topTargets(
  probabilities: Record<string, number> | undefined,
  idMap: Map<string, Row>,
  n: number,
): Array<{ ref: string; label: string; p: number }> {
  return Object.entries(probabilities ?? {})
    .filter(([, p]) => p > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, p]) => {
      const row = idMap.get(id);
      return { ref: row?.ref ?? id, label: rowLabel(row), p: Number(p.toFixed(3)) };
    });
}

/** One observation + one decision, with no action. Backs the jev_decide tool. */
export async function decideOnce(
  callTool: CallTool,
  client: JevClient,
  cfg: JevConfig,
  args: DecideArgs & { fill_defaults?: boolean | undefined },
): Promise<DecideOnceResult> {
  const { tabId, goal, success_criteria: successCriteria, values, allow_sensitive } = args;
  const fillDefaults = Boolean(args.fill_defaults);
  const observed = await observeOrFail(callTool, tabId, cfg);
  if (observed.failure) return { status: observed.failure.status, reason: observed.failure.reason };
  let obs = observed.obs;

  let short = await shortlistRows(obs.rows, {
    goal,
    successCriteria,
    values,
    maxRows: cfg.maxRows,
    pageUrl: obs.url,
    decide: (s, q) => client.decide(s, q),
  });
  const first = buildRequest(obs, short.rows, { goal, successCriteria, values, fillDefaults });
  let idMap = first.idMap;
  const firstRes = await client.decide(first.state, first.questions);
  let { answers, ms } = firstRes;
  let verdict = validate(answers, idMap, cfg, { allowSensitive: allow_sensitive, values, fillDefaults });
  // The same second look the loop takes before handing back (decideExplored).
  let explored = false;
  if (
    !verdict.ok &&
    (verdict.status === "blocked" || (verdict.confidence ?? 1) < cfg.minConfidence) &&
    hasJevTools(callTool)
  ) {
    const ctx: RunContext = {
      obs,
      deadline: Date.now() + cfg.maxMs,
      decisionNo: 0,
      actionNo: 0,
      browserMs: 0,
      jevMs: 0,
      settleMs: 0,
      explore: "auto",
    };
    const sub: Subgoal = { goal, successCriteria, values: values ?? {}, fillDefaults };
    const deeper = await decideExplored(callTool, client, cfg, ctx, tabId, sub, {
      allowSensitive: Boolean(allow_sensitive),
      history: [],
    });
    ms += ctx.jevMs;
    if (deeper && (deeper.verdict.ok || (deeper.verdict.confidence ?? 0) > (verdict.confidence ?? 0))) {
      ({ obs, short, answers, verdict } = deeper);
      idMap = deeper.request.idMap;
      explored = true;
    }
  }

  return {
    status: verdict.ok ? "proposed" : verdict.status,
    operation: verdict.operation ?? answers.operation?.choice,
    target_ref: verdict.row?.ref ?? null,
    target_label: rowLabel(verdict.row),
    value: verdict.value,
    confidence: verdict.confidence ?? answers.operation?.confidence ?? null,
    sensitive_probability: answers.sensitive?.noul ?? null,
    reason: verdict.ok ? null : verdict.reason,
    // Top few only, and in refs — the same id space as target_ref above.
    // The full target distribution is ~240 entries of almost entirely zero
    // (about 6KB), keyed eN while target_ref is ref_N, so the two halves of the
    // same answer could not be lined up.
    probabilities: {
      operation: topN(answers.operation?.probabilities, 5),
      target: topTargets(answers[targetHead(answers.operation?.choice) ?? "click_target"]?.probabilities, idMap, 5),
    },
    rows_offered: short.rows.length,
    rows_cut: short.cut,
    truncated: obs.truncated,
    url: obs.url,
    title: obs.title,
    jev_ms: ms,
    ...(explored ? { explored: true } : {}),
    usage: firstRes.usage,
  };
}

/** Normalise the two input shapes into one list. A bare goal is a list of one. */
export function normalizeSubgoals(args: Omit<NavigateInput, "tabId">): Subgoal[] {
  if (Array.isArray(args.subgoals) && args.subgoals.length) {
    return args.subgoals.map((sg): Subgoal => ({
      goal: sg.goal,
      successCriteria: sg.success_criteria ?? sg.successCriteria,
      values: sg.values ?? args.values ?? {},
      optional: sg.optional ?? null,
      fillDefaults: sg.fill_defaults ?? args.fill_defaults ?? false,
      questions: Array.isArray(sg.questions) && sg.questions.length ? sg.questions : null,
    }));
  }
  return [
    {
      goal: args.goal,
      successCriteria: args.success_criteria ?? args.successCriteria,
      values: args.values ?? {},
      fillDefaults: args.fill_defaults ?? false,
    },
  ];
}

const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "listbox", "select", "spinbutton", "textarea"]);

function isField(row: Row): boolean {
  const role = (row.role || "").toLowerCase();
  if (["checkbox", "radio", "switch", "button", "submit", "reset", "hidden"].includes((row.type || "").toLowerCase()))
    return false;
  return FIELD_ROLES.has(role) || Array.isArray(row.options) || Boolean(row.type);
}

function looksEmpty(row: Row): boolean {
  const selected = row.options?.find((o) => o.selected);
  if (selected) return PLACEHOLDER.test((selected.label ?? "").trim()) || (selected.value ?? "") === "";
  return PLACEHOLDER.test((row.value ?? "").trim());
}

const brief = (r: Row): BriefRow => ({
  ref: r.ref,
  role: r.role,
  name: r.name,
  ...(r.section ? { section: r.section } : {}),
  ...(r.required ? { required: true } : {}),
});

/**
 * Why a leg is stuck, when the page shows it: the disabled controls its goal
 * names, and the empty fields around them.
 *
 * The audited run stopped with "Confidence 0.52 is below the 0.6 threshold for
 * CLICK on button New product" while the real story was on screen: Save was
 * disabled because Category and Format were empty. Claude had to take a
 * screenshot to learn that, then finished the form by hand. Said in the
 * reason, it is a one-call fix: add legs for the fields, then retry.
 *
 * Returns null when nothing on the page explains the stop.
 */
export function diagnoseStop(
  obs: (Pick<Observation, "rows"> & { allRows?: Row[] }) | null | undefined,
  sub: Pick<Subgoal, "goal" | "successCriteria"> | null | undefined,
): (Blockers & { summary: string }) | null {
  const rows = obs?.allRows ?? obs?.rows ?? [];
  const terms = termsFrom(sub?.goal, sub?.successCriteria);
  const disabled = rows
    .filter((r) => r.disabled && r.name && lexicalScore({ ...r, section: "", href: "" }, terms) > 0)
    .slice(0, 3);
  if (!disabled.length) return null;

  const sections = new Set(disabled.map((r) => r.section).filter(Boolean));
  const empty = rows
    .filter((r) => !r.disabled && isField(r) && looksEmpty(r))
    .map((r, i) => ({ r, rank: (r.required ? 0 : 2) + (sections.size && !sections.has(r.section) ? 1 : 0), i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, 8)
    .map(({ r }) => r);

  const names = (list: Row[]) => list.map((r) => `"${r.name || r.ref}" (${r.role || "field"}, ${r.ref})`).join(", ");
  const summary =
    `${disabled.map((r) => `"${r.name}"`).join(", ")} ${disabled.length > 1 ? "are" : "is"} disabled on this page.` +
    (empty.length
      ? ` Fields that look empty: ${names(empty)}. Add legs that fill them (or set fill_defaults for choice fields) before the leg that stopped, then call again.`
      : " Nothing on the page looks empty, so something else has to happen first.");
  return { disabled: disabled.map(brief), empty: empty.map(brief), summary };
}

/**
 * Run one subgoal to completion, escalation or a limit.
 *
 * `ctx` is shared across the subgoals of a call: it carries the observation
 * (so a subgoal starts from the page the previous one left), the wall-clock
 * deadline, the running step number and the browser/Jev time split.
 */
async function runSubgoal(
  callTool: CallTool,
  client: JevClient,
  cfg: JevConfig,
  sub: Subgoal,
  opts: {
    tabId: number;
    allowSensitive: boolean;
    maxSteps: number;
    trace: Trace;
    next: Subgoal | null;
    carry: Carry | null;
  },
  ctx: RunContext,
): Promise<LegResult> {
  const { tabId, allowSensitive, maxSteps, trace, next } = opts;
  let carry = opts.carry ?? null;
  const { goal, successCriteria, values, fillDefaults } = sub;

  const steps: ActionStep[] = [];
  // The last few actions, fed back to Jev on every decision (see buildRequest).
  const history: Array<Record<string, unknown>> = [];
  let lastSignature: string | null = null;
  let unchangedStreak = 0;
  const actionCounts = new Map<string, number>();

  // Failures the loop gets past on its own, instead of handing each one to
  // Claude. Most hand-backs in real runs were not doubt, they were a page
  // mid-flight: an action that failed on a re-render, or a page that took
  // longer to update than the settle window. A fresh look and a fresh decision
  // clears those. `failedActions` keeps it honest: an action that already
  // failed from this page is never tried a second time.
  const recovered: string[] = [];
  const failedActions = new Map<string, string>();
  // Page states already explored, so an unsure page is explored once, not per step.
  const explored = new Set<string>();
  const canRecover = (why: string): boolean => {
    if (recovered.length >= MAX_RECOVERIES) return false;
    recovered.push(why);
    return true;
  };
  const stop = (status: string, reason: string | null, extra: Partial<LegResult> = {}): LegResult => {
    // A leg that stops without finishing says what is in the way when the page
    // shows it: a disabled control the goal names, and the empty fields that
    // are probably why. Not for a fatal stop (time, budget, a lost page),
    // where the page is beside the point.
    if (status !== "done" && !extra.fatal && ctx.obs) {
      const blockers = diagnoseStop(ctx.obs, sub);
      if (blockers) {
        reason = reason ? `${reason} ${blockers.summary}` : blockers.summary;
        extra = { ...extra, blockers: { disabled: blockers.disabled, empty: blockers.empty } };
      }
    }
    return { status, reason, steps, recovered, ...extra };
  };

  // Observing is read-only and idempotent, so a failure is worth retrying.
  //
  // The post-action observation routinely lands while the page is still
  // navigating, and the content script then answers "Could not generate
  // accessibility tree" — which is not a dead run, it is a page mid-flight.
  // Treating it as terminal ended a task that was otherwise succeeding. A
  // domain refusal is a decision, not a failure, so it is never retried.
  const observeNow = async (): Promise<ObserveOutcome> => {
    const t = Date.now();
    const settleBefore = ctx.settleMs;
    let r = await observeOrFail(callTool, tabId, cfg);
    for (let attempt = 0; attempt < 2 && r.failure && !r.obs; attempt++) {
      await settle(callTool, tabId, ctx, { expect: "wait", timeoutMs: 200 * (attempt + 1) }, 400 * (attempt + 1));
      r = await observeOrFail(callTool, tabId, cfg);
    }
    // The retry backoff is settle time, not browser time; count it once.
    ctx.browserMs += Date.now() - t - (ctx.settleMs - settleBefore);
    return r;
  };

  for (let n = 1; n <= maxSteps; n++) {
    if (Date.now() > ctx.deadline) {
      return stop("limit_reached", `Time limit reached after ${steps.length} steps of this subgoal.`, { fatal: true });
    }
    const stepStart = Date.now();
    // Two counters on purpose: `decisionNo` numbers every Jev decision for the
    // trace, while a step in the result is numbered only when an action is
    // actually taken. The iteration that spots completion makes a decision and
    // performs nothing, and would otherwise leave a gap in the step numbering
    // that Claude reads.
    const i = ++ctx.decisionNo;

    // Reuse the observation taken after the previous action instead of taking
    // the same one again. The loop used to observe twice per step and throw the
    // second away.
    let obs = ctx.obs;
    if (!obs) {
      const { obs: fresh, failure } = await observeNow();
      if (failure) {
        if (fresh) ctx.obs = fresh;
        return stop(failure.status, failure.reason, { fatal: true });
      }
      obs = fresh;
    }
    ctx.obs = obs;

    let short,
      request,
      answers,
      jevMs = 0,
      verdict,
      inputTokens = 0;
    const carried = carry && carry.obs === obs ? carry : null;
    carry = null;
    // The next leg's questions ride along only once this leg has acted: they
    // double the target heads, and a leg is almost never finished before its
    // first action (the previous leg's next_satisfied covers that case).
    const ask = steps.length > 0 ? next : null;
    if (carried) {
      // Decided by the previous leg's request, on this very observation.
      ({ short, request, answers, verdict } = carried);
    } else {
      try {
        // Shortlist for both goals when the next one rides along, so the rows
        // its first action needs are on offer too.
        short = await shortlistRows(obs.rows, {
          goal: ask ? `${goal} ${ask.goal}` : goal,
          successCriteria: ask ? `${successCriteria} ${ask.successCriteria}` : successCriteria,
          values: ask ? { ...ask.values, ...values } : values,
          maxRows: cfg.maxRows,
          pageUrl: obs.url,
          decide: (st, q) => client.decide(st, q),
        });
        request = buildRequest(
          obs,
          short.rows,
          { goal, successCriteria, values, fillDefaults, history: history.slice(-3) },
          ask,
        );
        const res = await client.decide(request.state, request.questions);
        answers = res.answers;
        jevMs = res.ms;
        inputTokens = tokensOf(res.usage);
        ctx.jevMs += jevMs;
      } catch (err) {
        if (err instanceof BudgetExceeded) return stop("limit_reached", err.message, { fatal: true });
        return stop("needs_help", `Jev request failed: ${errorMessage(err)}`);
      }
      verdict = validate(answers, request.idMap, cfg, { allowSensitive, values, fillDefaults });
    }

    // Unsure, or sure that nothing offered helps: before handing back, map
    // the whole page, find the regions the goal is about, and decide again
    // with their controls on offer, on screen or not. Once per page state.
    let exploreTrace: Record<string, unknown> | null = null;
    if (
      !carried &&
      !verdict.ok &&
      (verdict.status === "blocked" || (verdict.confidence ?? 1) < cfg.minConfidence) &&
      (answers.satisfied?.noul ?? 0) <= 0.5 &&
      ctx.explore !== "never" &&
      hasJevTools(callTool) &&
      !explored.has(observationSignature(obs))
    ) {
      explored.add(observationSignature(obs));
      try {
        const deeper = await decideExplored(callTool, client, cfg, ctx, tabId, sub, {
          allowSensitive,
          history: history.slice(-3),
        });
        if (deeper) {
          exploreTrace = { ...deeper.trace, verdict: { ok: deeper.verdict.ok, reason: deeper.verdict.reason ?? null } };
          if (deeper.verdict.ok || (deeper.answers.satisfied?.noul ?? 0) > 0.5) {
            ({ short, request, answers, verdict } = deeper);
            obs = deeper.obs;
            ctx.obs = obs;
            inputTokens += deeper.inputTokens;
          }
        }
      } catch (err) {
        if (err instanceof BudgetExceeded) return stop("limit_reached", err.message, { fatal: true });
        exploreTrace = { error: errorMessage(err) };
      }
    }

    const contradiction = urlContradicts(successCriteria, obs.url);
    const satisfied = contradiction ? 0 : (answers.satisfied?.noul ?? 0);

    trace.step({
      i,
      subgoal: goal,
      url: obs.url,
      title: obs.title,
      carried: Boolean(carried),
      rows_offered: short.rows.length,
      rows_cut: short.cut,
      rows_offscreen: short.offscreen ?? null,
      truncated: obs.truncated,
      satisfied,
      url_check: contradiction,
      answers: carried ? null : answers,
      verdict: { ok: verdict.ok, status: verdict.status ?? null, reason: verdict.reason ?? null },
      operation: verdict.operation,
      target_ref: verdict.row?.ref ?? null,
      jev_ms: jevMs,
      input_tokens: inputTokens,
      ...(exploreTrace ? { explore: exploreTrace } : {}),
    });

    // The success check now governs completion, so it is tested before the
    // action and before any gate: if the page already satisfies the criteria,
    // there is nothing left to do and nothing to refuse.
    if (satisfied > 0.5) {
      return stop("done", null, {
        satisfied,
        carry: ask && !carried ? carryFor(answers, request, short, obs, ask, cfg, allowSensitive) : null,
      });
    }

    if (!verdict.ok) return stop(verdict.status, verdict.reason);

    if (verdict.operation === "DONE") {
      // Jev says finished, the page says otherwise — exactly the disagreement
      // success_criteria exists to catch. DONE is now a signal, not a gate.
      steps.push({
        i: ++ctx.actionNo,
        operation: "DONE",
        target_ref: null,
        target_label: "",
        confidence: verdict.confidence,
        ms: Date.now() - stepStart,
      });
      unchangedStreak++;
      ctx.obs = null;
      if (unchangedStreak >= 2) {
        return stop(
          "needs_help",
          `Jev reported DONE but the success criteria are not met (p=${satisfied.toFixed(2)}).`,
        );
      }
      continue;
    }

    // Key the repeat guard on the action AND the page it was taken from.
    //
    // Keying on the action alone cannot tell two opposite situations apart.
    // Paging through a list re-clicks "Next" at the same ref on every page —
    // the renderer restarts refs at ref_1 on each load — so the action key is
    // identical every time while the loop works perfectly. An oscillation
    // (click Filter, dropdown opens; click Filter, dropdown closes) also
    // changes the page every step, so the no-progress check never fires on it
    // either. Including the originating page separates them: paging starts each
    // click from a new state, oscillating keeps returning to the same one.
    const actionKey = `${observationSignature(obs)}|${verdict.operation}:${verdict.row?.ref ?? "-"}:${verdict.value ?? ""}`;
    const count = (actionCounts.get(actionKey) ?? 0) + 1;
    actionCounts.set(actionKey, count);
    // Waiting on a page that has not changed yet is not a loop; the step cap
    // and max_ms bound it.
    if (count > 2 && verdict.operation !== "WAIT") {
      return stop(
        "needs_help",
        `The same action (${verdict.operation} on ${rowLabel(verdict.row)}) came up three times without progress.`,
      );
    }
    if (failedActions.has(actionKey)) {
      return stop(
        "needs_help",
        `The action failed, and was chosen again after a fresh look at the page: ${failedActions.get(actionKey)}`,
      );
    }

    // Act. A ref can go stale between the observation and here — the Jev call
    // sits in between — so a ref failure re-observes and retries the same
    // operation once against the row that now carries that label.
    const actStart = Date.now();
    // A WAIT never outlasts the call's own budget: leave a second for the
    // decision that follows it.
    const waitMs = Math.max(250, Math.min(WAIT_MS, ctx.deadline - Date.now() - 1000));
    let acted = await runCalls(
      callTool,
      planToolCalls(verdict.operation, verdict.row, verdict.value, tabId, {
        jevTools: hasJevTools(callTool),
        waitMs,
      }),
    );
    // A covered target is not stale: re-finding it by name returns the same
    // covered element, so it goes straight back as the failure it is.
    const target = verdict.row;
    if (
      target &&
      acted.error &&
      !/covered:/.test(acted.error) &&
      /stale:|ref_\d+|not found|garbage collected/i.test(acted.error)
    ) {
      const { obs: retryObs } = await observeNow();
      const again = retryObs?.rows.find((r) => r.role === target.role && namesAgree(r.name, target.name));
      if (again) {
        acted = await runCalls(
          callTool,
          planToolCalls(verdict.operation, again, verdict.value, tabId, { jevTools: hasJevTools(callTool), waitMs }),
        );
      }
    }
    ctx.browserMs += Date.now() - actStart;
    if (acted.error) {
      // Look again and decide again. The page usually re-rendered or moved
      // under the action, and the new decision is made on what is there now.
      // Choosing the same action from the same page is caught above.
      failedActions.set(actionKey, acted.error);
      if (!canRecover(`${verdict.operation} on ${rowLabel(verdict.row)} failed: ${acted.error}`)) {
        return stop("needs_help", `The action failed: ${acted.error}`);
      }
      await settle(callTool, tabId, ctx, { expect: "wait", timeoutMs: 300 }, 300);
      ctx.obs = null;
      continue;
    }

    steps.push({
      i: ++ctx.actionNo,
      operation: verdict.operation,
      target_ref: verdict.row?.ref ?? null,
      target_label: rowLabel(verdict.row),
      confidence: Number(verdict.confidence.toFixed(3)),
      ...(verdict.demotedFrom ? { demoted_from: verdict.demotedFrom } : {}),
      ...(verdict.defaulted ? { defaulted_value: verdict.value } : {}),
      ms: Date.now() - stepStart,
    });

    // A WAIT already waited for the page to move. Whether it did is not
    // progress or its absence: the next decision looks again, and the
    // unchanged-page check below would end a leg that is only waiting.
    if (verdict.operation === "WAIT") {
      const waited = await observeNow();
      if (waited.failure) {
        if (waited.obs) ctx.obs = waited.obs;
        return stop(waited.failure.status, waited.failure.reason, { fatal: true });
      }
      const sig = observationSignature(waited.obs);
      if (sig !== observationSignature(obs)) unchangedStreak = 0;
      lastSignature = sig;
      ctx.obs = waited.obs;
      history.push({ operation: "WAIT", target: "", page_changed: sig !== observationSignature(obs) });
      continue;
    }

    // Observe once, and keep it: it is both this step's did-anything-move check
    // and the next step's starting observation.
    //
    // Let the action land before judging it. A click or a submit starts a
    // navigation that is still in flight microseconds later, and the browser
    // calls themselves take ~20ms, so reading straight away can catch the old
    // page and conclude nothing happened. The loop used to get this settle time
    // by accident, from the ~400ms Jev round trip of the following step;
    // TYPE_AND_SUBMIT does three calls back to back and removed it, which left
    // a successful search looking like a no-op.
    //
    // Only the unchanged case waits, so a page that already moved costs nothing.
    const before = observationSignature(obs);
    const beforeUrl = obs.url;
    // A submit is judged on the URL: it has already changed the signature by
    // putting text in the field, so the signature can no longer tell us whether
    // the navigation landed. Measured: the submit completes around +300ms, and
    // reading at +0ms caught the old page and looked like a no-op.
    // A click on a link that leaves the page is judged on the URL too.
    //
    // Signature change is the wrong test for it: clicking a link inside a
    // dropdown CLOSES the dropdown, which changes the signature immediately
    // while the navigation is still in flight. The loop then decided on a page
    // that was about to be replaced — twice in one audited run — and the next
    // action could have landed on the incoming page instead.
    //
    // A click with no href, or one that only moves to a fragment, does not
    // navigate, so the signature check stays right for it.
    const expectsNavigation =
      SUBMITTING_OPERATIONS.has(verdict.operation) ||
      (verdict.operation === "CLICK" && navigatesAway(verdict.row?.href, obs.url));

    const settled = (o: Observation) => (expectsNavigation ? o.url !== beforeUrl : observationSignature(o) !== before);

    // Wait on the event that means the action landed: the URL leaving for a
    // navigation, the suggestions appearing for a combobox, two frames for
    // anything else. The fixed 300 ms polls this replaces were most of the
    // time between one action and the next decision.
    //
    // A navigation gets one bounded wait and no polling after it: a submit
    // that only updates the page in place (an SPA filter) never changes the
    // URL, and must not cost more than the old 1.2 s poll did. Other actions
    // get two short re-checks for a page that updates after a fetch.
    const onCombobox = verdict.operation === "TYPE_TEXT" && (verdict.row?.role || "").toLowerCase() === "combobox";
    await settle(
      callTool,
      tabId,
      ctx,
      {
        expect: expectsNavigation ? "navigation" : onCombobox ? "combobox" : "dom",
        fromUrl: beforeUrl,
        ref: verdict.row?.ref,
        timeoutMs: 2000,
      },
      0,
    );
    let outcome = await observeNow();
    const jevTools = hasJevTools(callTool);
    const rechecks = !jevTools ? 4 : expectsNavigation ? 1 : 2;
    for (let check = 0; check < rechecks && !outcome.failure && !settled(outcome.obs); check++) {
      await settle(callTool, tabId, ctx, { expect: "wait", timeoutMs: 250 }, 300);
      outcome = await observeNow();
    }
    if (outcome.failure) {
      if (outcome.obs) ctx.obs = outcome.obs;
      return stop(outcome.failure.status, outcome.failure.reason, { fatal: true });
    }
    let after = outcome.obs;
    let sig = observationSignature(after);
    if (lastSignature !== null && sig === lastSignature) {
      unchangedStreak++;
      // A slow page — an SPA waiting on a fetch — looks exactly like a dead
      // one inside the normal settle window. Give it one long wait before
      // calling it no progress.
      if (
        unchangedStreak >= 2 &&
        canRecover(`the page looked unchanged after ${verdict.operation} on ${rowLabel(verdict.row)}; waited longer`)
      ) {
        await settle(callTool, tabId, ctx, { expect: "wait", timeoutMs: 1500 }, 1500);
        const { obs: later, failure: laterFail } = await observeNow();
        if (laterFail) {
          if (later) ctx.obs = later;
          return stop(laterFail.status, laterFail.reason, { fatal: true });
        }
        after = later;
        sig = observationSignature(after);
        if (sig !== lastSignature) unchangedStreak = 0;
      }
      if (unchangedStreak >= 2) {
        ctx.obs = after;
        return stop(
          "needs_help",
          `Two steps in a row left the page unchanged after ${verdict.operation} on ${rowLabel(verdict.row)}.`,
        );
      }
    } else {
      unchangedStreak = 0;
    }
    lastSignature = sig;
    ctx.obs = after;
    history.push({
      operation: verdict.operation,
      target: rowLabel(verdict.row),
      ...(verdict.value !== undefined ? { value: verdict.value } : {}),
      page_changed: sig !== before,
    });
  }

  return stop("limit_reached", `Step limit of ${maxSteps} reached for this subgoal.`);
}

/**
 * One decision made the long way: the whole page mapped into regions, the
 * regions the goal is about found by exploration (explore.ts), and the step
 * decided again with their controls on offer, on screen or not, and their
 * text as the excerpt. Refs are stable across observations, so the rows it
 * offers are acted on like any others. Null when the page cannot be mapped.
 */
async function decideExplored(
  callTool: CallTool,
  client: JevClient,
  cfg: JevConfig,
  ctx: RunContext,
  tabId: number,
  sub: Subgoal,
  { allowSensitive, history }: { allowSensitive: boolean; history: unknown[] },
): Promise<{
  obs: Observation;
  short: Shortlist;
  request: StepRequest;
  answers: Answers;
  verdict: Verdict;
  inputTokens: number;
  trace: Record<string, unknown>;
} | null> {
  const { goal, successCriteria, values, fillDefaults } = sub;
  const t = Date.now();
  const mapped = await observeOrFail(callTool, tabId, cfg, { map: true });
  ctx.browserMs += Date.now() - t;
  if (mapped.failure || !mapped.obs.regions) return null;
  const obs = mapped.obs;
  let inputTokens = 0;
  const decide: Decide = async (state, qs) => {
    const t0 = Date.now();
    try {
      const res = await client.decide(state, qs);
      inputTokens += tokensOf(res.usage);
      return res;
    } finally {
      ctx.jevMs += Date.now() - t0;
    }
  };
  const graph = buildGraph(obs.regions ?? [], obs.allRows, { title: obs.title, truncated: Boolean(obs.mapTruncated) });
  const found = await exploreForAction(decide, graph, {
    intent: `${goal ?? ""} Done when: ${successCriteria ?? ""}`.trim(),
    ...exploreSettings(cfg),
  });

  // The focus regions' controls, plus whatever is on screen, in page order.
  const inFocus = new Set(found.rows);
  let rows = usableRows(obs.allRows.filter((r) => inFocus.has(r) || r.inView));
  if (rows.length > cfg.maxRows) {
    // Narrowed by the goal's words, with on-screen-ness forgotten: being off
    // screen is exactly what these rows are allowed to be.
    const byRef = new Map(rows.map((r) => [r.ref, r]));
    const kept = prefilter(
      rows.map((r) => ({ ...r, inView: undefined })),
      { goal, successCriteria, values, limit: cfg.maxRows, pageUrl: obs.url },
    ).rows;
    rows = kept.map((r) => byRef.get(r.ref) as Row);
  }
  const request = buildRequest({ ...obs, excerpt: found.excerpt || obs.excerpt }, rows, {
    goal,
    successCriteria,
    values,
    fillDefaults,
    history,
  });
  const { answers } = await decide(request.state, request.questions);
  const verdict = validate(answers, request.idMap, cfg, { allowSensitive, values, fillDefaults });
  return {
    obs,
    short: {
      rows,
      cut: obs.allRows.length - rows.length,
      scored: true,
      sections: found.exploration.focus.length,
    },
    request,
    answers,
    verdict,
    inputTokens,
    trace: { ...traceOf({ exploration: found.exploration, text: found.excerpt }), rows_offered: rows.length },
  };
}

/**
 * The next leg's first decision, already answered by this leg's last request.
 *
 * Carried only when it is usable as-is: it passed the whole gate, or the next
 * leg is already satisfied on this page. Anything else — a refusal, low
 * confidence, a missing value — is dropped, and the next leg simply asks
 * again, so the gate's verdict always comes from a decision it can act on.
 */
function carryFor(
  allAnswers: Answers,
  request: StepRequest,
  short: Shortlist,
  obs: Observation,
  next: Subgoal,
  cfg: JevConfig,
  allowSensitive: boolean,
): Carry | null {
  const answers = answersFor(allAnswers, "next_");
  if (!answers["operation"]) return null;
  const verdict = validate(answers, request.idMap, cfg, {
    allowSensitive,
    values: next.values,
    fillDefaults: next.fillDefaults,
  });
  const satisfied = urlContradicts(next.successCriteria, obs.url) ? 0 : (answers["satisfied"]?.noul ?? 0);
  if (!verdict.ok && !(satisfied > 0.5)) return null;
  return { obs, short, request, answers, verdict };
}

/**
 * The page's controls as Claude should see them on hand-back: by real ref, so
 * a fallback click can use `ref` instead of reading coordinates off a
 * screenshot; disabled ones included and marked; the rows the stuck leg names
 * first, then what is on screen. Kept in document order.
 */
export function handbackRows(
  obs: (Pick<Observation, "rows"> & { allRows?: Row[] }) | null | undefined,
  sub: Pick<Subgoal, "goal" | "successCriteria"> | null | undefined,
  limit: number,
): string[] {
  const rows = obs?.allRows ?? obs?.rows ?? [];
  const terms = termsFrom(sub?.goal, sub?.successCriteria);
  const tier = (r: Row) => (lexicalScore(r, terms) > 0 ? 0 : r.inView === false ? 2 : 1);
  return rows
    .map((r, i) => ({ r, i, t: tier(r) }))
    .filter(({ r }) => r.role || r.name || r.href)
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .slice(0, limit)
    .sort((a, b) => a.i - b.i)
    .map(({ r }) => renderRow(r, r.ref));
}

// How much page text questions are asked of when the extension cannot map the
// page (one that predates jev_snapshot's `map`). With a map, the whole page is
// read when it fits exploreLeafChars and explored region by region when it
// does not (explore.ts), so a fact below the first few thousand characters,
// or in the twentieth card of a listing, is no longer out of reach.
const ANSWER_TEXT_CHARS = 6000;
// How much of that text comes back to Claude in page_excerpt.
const EXCERPT_RETURN_CHARS = 1500;

/** Mean confidence of Claude's questions' answers, to compare two readings. */
function meanConfidence(got: Answers, questions: readonly ClaudeQuestion[]): number {
  if (!questions.length) return 1;
  return questions.reduce((a, q) => a + (got[q.key]?.confidence ?? 0), 0) / questions.length;
}

/**
 * Ask Claude's questions, and a final check, about the page as it is now. The
 * page is read whole, or explored when it is too long for one request, then
 * cut into numbered passages so each answer comes back with the passage it
 * rests on, quoted verbatim, as jev_assess does. An explored reading that
 * leaves an answer unsure gets one wider look. Throws when the page cannot be
 * read or Jev cannot answer.
 */
async function answerOnPage(
  callTool: CallTool,
  client: JevClient,
  cfg: JevConfig,
  ctx: RunContext,
  trace: Trace,
  tabId: number,
  { questions, finalCheck, leg }: { questions: ClaudeQuestion[] | null; finalCheck: string | null; leg?: number },
): Promise<{
  answers: Record<string, CompactAnswer | null> | null;
  verified: number | null;
  obs: Observation;
  coverage: Coverage | null;
}> {
  const t = Date.now();
  const { obs, failure } = await observeOrFail(callTool, tabId, cfg, {
    excerptChars: ANSWER_TEXT_CHARS,
    fullText: true,
    map: ctx.explore !== "never",
  });
  ctx.browserMs += Date.now() - t;
  if (!obs || failure) throw new Error(failure?.reason ?? "the page could not be read");

  const decide: Decide = async (state, qs) => {
    const t0 = Date.now();
    try {
      return await client.decide(state, qs);
    } finally {
      ctx.jevMs += Date.now() - t0;
    }
  };
  const intent = [finalCheck ? `Check whether: ${finalCheck}` : "", ...(questions ?? []).map((q) => q.question)]
    .filter(Boolean)
    .join(" ");
  const graph = obs.regions
    ? buildGraph(obs.regions, obs.allRows, { title: obs.title, truncated: Boolean(obs.mapTruncated) })
    : null;
  const readOpts = { questions, intent, mode: ctx.explore, ...exploreSettings(cfg) };
  let page: PageReading | null = graph ? await readForQuestions(decide, graph, readOpts) : null;

  // The rows the questions name, when the page has more than fit.
  const rows = prefilter(obs.rows, { goal: intent, limit: cfg.maxRows, pageUrl: obs.url }).rows;
  const ask = async (text: string): Promise<{ got: Answers; passages: string[] }> => {
    const passages = questions ? splitPassages(text) : [];
    const jevQuestions: JevQuestions = {};
    if (questions) {
      Object.assign(jevQuestions, buildQuestions(questions));
      if (passages.length) Object.assign(jevQuestions, evidenceQuestions(questions, passages.length));
    }
    if (finalCheck) {
      jevQuestions["verified"] = {
        type: "noul",
        instructions: `Is ALL of this true of the page right now: ${finalCheck}`,
        criteria: {
          true: "Every part of the intended end state is visibly in place",
          false: "Some part of it is missing, or was undone",
        },
      };
    }
    const { answers: got } = await decide(
      {
        ...(finalCheck ? { intended_end_state: finalCheck } : {}),
        url: obs.url,
        title: obs.title,
        page_text: passages.length ? numberedText(passages) : text,
        elements: rows.map((r, k) => renderRow(r, `e${k + 1}`)),
      },
      jevQuestions,
    );
    return { got, passages };
  };

  let { got, passages } = await ask(page?.text ?? obs.excerpt);
  // Still unsure after exploring: add the next-best regions and ask once more,
  // keeping whichever reading answered more surely.
  if (
    graph &&
    page?.exploration &&
    questions &&
    questions.some((q) => (got[q.key]?.confidence ?? 0) < cfg.minConfidence)
  ) {
    const wider = await rethink(decide, graph, page, readOpts);
    if (wider) {
      const again = await ask(wider.text);
      if (meanConfidence(again.got, questions) > meanConfidence(got, questions)) {
        page = wider;
        ({ got, passages } = again);
      }
    }
  }

  let answers: Record<string, CompactAnswer | null> | null = null;
  if (questions) {
    answers = {};
    for (const q of questions) {
      const answer = compactAnswer(got[q.key]);
      if (answer && passages.length) {
        const quote = pickEvidence(got[q.key + EVIDENCE_SUFFIX], passages);
        if (quote) answer.evidence = quote;
      }
      answers[q.key] = answer;
    }
  }
  const verified = finalCheck ? (got["verified"]?.noul ?? 0) : null;
  trace.step({
    i: ++ctx.decisionNo,
    ...(leg ? { leg } : {}),
    final_check: finalCheck,
    verified,
    answers,
    url: obs.url,
    ...(page ? { explore: traceOf(page) } : {}),
  });
  return { answers, verified, obs, coverage: page?.coverage ?? null };
}

/** The full loop over one or more subgoals. Backs the jev_navigate tool. */
export async function navigate(
  callTool: CallTool,
  client: JevClient,
  cfg: JevConfig,
  args: NavigateInput,
): Promise<NavigateResult> {
  const { tabId, values = {}, start_url: startUrl, allow_sensitive: allowSensitive = false } = args;
  const questions = Array.isArray(args.questions) && args.questions.length ? args.questions : null;
  const finalCheck = args.final_check ?? args.finalCheck ?? null;
  // No goal and no legs: only answer the questions about the page as it is.
  // It used to take a "stay on this page; do nothing" leg to get there.
  const questionsOnly = !args.goal && !(Array.isArray(args.subgoals) && args.subgoals.length);
  if (questionsOnly && !questions && !finalCheck) {
    return { status: "error", reason: "Nothing to do: give a goal, subgoals, or questions about the current page." };
  }

  // Refused before anything is opened or clicked, as jev_assess does.
  const questionsProblem = (list: ClaudeQuestion[]) =>
    questionsError(list) ??
    (list.some((q) => q.key === "verified")
      ? 'Question key "verified" is reserved for final_check; use another name.'
      : null);
  if (questions) {
    const qErr = questionsProblem(questions);
    if (qErr) return { status: "error", reason: qErr };
  }

  const subgoals = questionsOnly ? [] : normalizeSubgoals(args);
  for (const [idx, sub] of subgoals.entries()) {
    const qErr = sub.questions ? questionsProblem(sub.questions) : null;
    if (qErr) return { status: "error", reason: `Subgoal ${idx + 1}: ${qErr}` };
  }
  // max_steps bounds each subgoal so one runaway leg cannot eat the whole call;
  // max_ms and the spend cap bound the call as a whole.
  const maxSteps = Math.min(args.max_steps ?? cfg.maxSteps, cfg.maxSteps);
  const maxMs = args.max_ms ?? cfg.maxMs;
  const minConfidence = args.min_confidence ?? cfg.minConfidence;
  const runCfg = { ...cfg, minConfidence };

  const trace = createTrace(cfg.tracesDir, {
    goal: questionsOnly ? "(questions only)" : subgoals.map((s) => s.goal).join(" → "),
    subgoals: subgoals.map((s) => ({ goal: s.goal, success_criteria: s.successCriteria })),
    tab_id: tabId,
    model: cfg.model,
    max_steps: maxSteps,
    max_ms: maxMs,
    min_confidence: minConfidence,
    allow_sensitive: allowSensitive,
    value_keys: Object.keys(values),
  });

  const startedAt = Date.now();
  const ctx: RunContext = {
    obs: null,
    deadline: startedAt + maxMs,
    decisionNo: 0,
    actionNo: 0,
    browserMs: 0,
    jevMs: 0,
    settleMs: 0,
    explore: args.explore ?? "auto",
  };
  const legs: LegSummary[] = [];
  const allSteps: ActionStep[] = [];
  let status = "done";
  let reason: string | null = null;
  // Set when a leg stops the run: what is in the way, and the legs after it,
  // echoed verbatim so Claude can re-call with [fix-up legs, ...remaining].
  let blockers: Blockers | null = null;
  let remaining: SubgoalInput[] | null = null;
  let stoppedLeg: Subgoal | null = null;
  let answers: Record<string, CompactAnswer | null> | null = null;
  let answersNote: string | null = null;
  let coverage: Coverage | null = null;

  const finish = (): NavigateResult => {
    const obs = ctx.obs;
    // A truncated observation is a real possible cause of "nothing here can
    // help": read_page hit its own character cap, so rows were dropped before
    // the prefilter could even rank them. Saying so turns a confidently wrong
    // answer into a legible one — an Octopus article yields 1,412 rows and
    // truncates, and this was only ever recorded in the trace.
    if (status !== "done" && obs?.truncated) {
      reason = `${reason ?? "Stopped."} NOTE: the page was too large to read in full (read_page truncated it), so some controls were never observed and could not be chosen. Try a narrower start_url, or scroll to the relevant part first.`;
    }
    // wall ≈ jev + browser + settle. settle is time spent deliberately
    // waiting for the page, which neither of the other two counts.
    const usage: TraceUsage = {
      ...client.totals,
      jev_ms: ctx.jevMs,
      browser_ms: ctx.browserMs,
      settle_ms: ctx.settleMs,
      wall_ms: Date.now() - startedAt,
    };
    const out: NavigateResult = {
      status,
      steps: allSteps,
      subgoals: legs,
      final_url: obs?.url ?? "",
      final_title: obs?.title ?? "",
      reason,
      // The final page, so Claude can carry on without spending a turn on
      // read_page just to find out where the loop left the tab.
      ...(answers ? { answers } : {}),
      ...(answers && answersNote ? { answers_note: answersNote } : {}),
      ...(answers && coverage ? { coverage } : {}),
      ...(blockers ? { blockers } : {}),
      ...(remaining ? { remaining_subgoals: remaining } : {}),
      page_excerpt: obs
        ? {
            url: obs.url,
            title: obs.title,
            text: obs.excerpt.slice(0, EXCERPT_RETURN_CHARS),
            // Rendered by ref, not e-id: these are what Claude acts on if it
            // has to take a step itself. More of them when it will.
            interactive: handbackRows(obs, stoppedLeg, status === "done" ? 40 : 80),
          }
        : null,
      usage,
      run_id: trace.runId,
    };
    trace.finish(
      { status, reason, final_url: out.final_url, subgoals: legs.map((l) => ({ goal: l.goal, status: l.status })) },
      usage,
    );
    return out;
  };

  // Only Claude navigates. `navigate` is not in the action space, so this is
  // the single point at which the loop can change the URL, and it happens
  // before any Jev call.
  if (startUrl) {
    const res = await callTool("navigate", { url: startUrl, tabId });
    if (isToolError(res)) {
      status = "blocked";
      reason = resultText(res);
      return finish();
    }
    // Support for jev_settle is only learned from the first observation, so
    // ask directly; an older extension refuses and there is nothing to wait on.
    const t = Date.now();
    await callTool("jev_settle", { tabId, expect: "quiet" });
    ctx.settleMs += Date.now() - t;
  }

  const continueOnFailure = Boolean(args.continue_on_failure ?? args.continueOnFailure);

  let carry: Carry | null = null;
  const skipped: Array<{ i: number; goal: string | undefined; status: string; reason: string | null }> = [];
  let stopped = false;
  for (const [idx, sub] of subgoals.entries()) {
    const leg = await runSubgoal(
      callTool,
      client,
      runCfg,
      sub,
      { tabId, allowSensitive, maxSteps, trace, next: subgoals[idx + 1] ?? null, carry },
      ctx,
    );
    carry = leg.carry ?? null;
    // A leg that fails but may be skipped is recorded and passed over; the next
    // leg starts from wherever this one left the page. Running out of time or
    // budget, or losing the page, stops every leg alike, so those never skip.
    const skip = leg.status !== "done" && !leg.fatal && (sub.optional ?? continueOnFailure);
    const summary: LegSummary = {
      i: idx + 1,
      goal: sub.goal,
      status: leg.status,
      steps: leg.steps,
      reason: leg.reason,
      ...(leg.blockers ? { blockers: leg.blockers } : {}),
      ...(leg.recovered?.length ? { recovered: leg.recovered } : {}),
      ...(skip ? { skipped: true } : {}),
    };
    legs.push(summary);
    allSteps.push(...leg.steps);
    // The leg's own checks, on the page it ended on. A test plan is a run of
    // "do this, then check that", and with checks only at the end of a run
    // every check cost a call of its own: ten calls for one plan in the run
    // that motivated this. Not asked of a skipped leg, whose page is whatever
    // an earlier leg left. The step observation is kept, not replaced, so the
    // next leg's carried decision still applies.
    if (sub.questions && !skip) {
      try {
        const got = await answerOnPage(callTool, client, runCfg, ctx, trace, tabId, {
          questions: sub.questions,
          finalCheck: null,
          leg: idx + 1,
        });
        if (got.answers) summary.answers = got.answers;
        if (got.answers && got.coverage) summary.coverage = got.coverage;
        if (leg.status !== "done") summary.answers_note = "Answered about the page where this leg stopped.";
      } catch (err) {
        summary.reason = `${summary.reason ? `${summary.reason} ` : ""}Its questions could not be answered: ${errorMessage(err)}`;
      }
    }
    status = leg.status;
    reason = leg.reason;
    if (skip) {
      skipped.push({ i: idx + 1, goal: sub.goal, status: leg.status, reason: leg.reason });
      continue;
    }
    // Stop at the first leg that does not finish, and say which one it was so
    // Claude knows where to pick the task back up.
    if (leg.status !== "done") {
      if (subgoals.length > 1) {
        reason = `Subgoal ${idx + 1} of ${subgoals.length} ("${sub.goal}") stopped: ${leg.reason}`;
      }
      stoppedLeg = sub;
      blockers = leg.blockers ?? null;
      if (Array.isArray(args.subgoals) && idx + 1 < args.subgoals.length) {
        remaining = args.subgoals.slice(idx + 1);
      }
      stopped = true;
      break;
    }
  }

  // Every leg ran, but some were skipped. `partial` says the run went the whole
  // way; the reason lists exactly which legs Claude still owes.
  if (!stopped && skipped.length) {
    const list = skipped.map((s) => `${s.i} ("${s.goal}"): ${s.status} — ${s.reason}`).join("; ");
    if (skipped.length === subgoals.length) {
      status = skipped[0]?.status ?? status;
      reason = `No subgoal finished. Skipped ${list}`;
    } else {
      status = "partial";
      reason = `${subgoals.length - skipped.length} of ${subgoals.length} subgoals finished. Skipped ${list}`;
    }
  } else if (!stopped) {
    status = "done";
    reason = null;
  } else if (skipped.length) {
    reason += ` Earlier legs skipped: ${skipped.map((s) => `${s.i} ("${s.goal}")`).join(", ")}.`;
  }

  // Every leg reported done — but a per-leg check only ever asked "is THIS leg
  // finished", on the page as it stood at the time. It cannot notice a setting
  // from leg 2 being silently reset by leg 7, which is exactly what the audited
  // app does: turning on "Group by week" resets the chart style a previous
  // leg had just set. One question against the whole intended end state is the
  // only thing that catches it.
  //
  // Claude's own questions ride in the same request. They are how a task ends
  // in verification without Claude reading the page: "is the Enable switch
  // off?" was thirteen manual calls in the audited run. final_check only
  // judges a run that claims to be done. The questions are answered whatever
  // the outcome, marked when the page is where a leg stopped: withholding them
  // cost a second call ("stay on this page; do nothing") just to ask them.
  const checkEnd = status === "done" ? finalCheck : null;
  if (checkEnd || questions) {
    try {
      const got = await answerOnPage(callTool, client, runCfg, ctx, trace, tabId, {
        questions,
        finalCheck: checkEnd,
      });
      ctx.obs = got.obs;
      answers = got.answers;
      coverage = got.coverage;
      if (status !== "done" && status !== "partial") {
        answersNote = stoppedLeg
          ? `Answered about the page where subgoal ${subgoals.indexOf(stoppedLeg) + 1} stopped, not the page the run was meant to reach.`
          : "Answered about the page the run stopped on, not the page it was meant to reach.";
      }
      const p = got.verified;
      if (checkEnd && p !== null && p <= 0.5) {
        status = "needs_help";
        reason = `Every subgoal finished, but the final check did not hold (p=${p.toFixed(2)}): ${checkEnd}. Something set earlier was probably undone by a later step — inspect the page before treating this as done.`;
      }
    } catch (err) {
      if (checkEnd) {
        status = "needs_help";
        reason = `Every subgoal finished, but the final check could not be run: ${errorMessage(err)}`;
      } else {
        reason = `${reason ? `${reason} ` : ""}The questions could not be answered: ${errorMessage(err)}`;
      }
    }
  }

  return finish();
}

/**
 * Let the page react, through jev_settle when the extension has it, and
 * otherwise by sleeping `legacyMs` (0 means: nothing to do without it).
 * Counted as settle time either way.
 */
async function settle(
  callTool: CallTool,
  tabId: number,
  ctx: RunContext,
  args: { expect: string; timeoutMs?: number; fromUrl?: string; ref?: string | undefined },
  legacyMs: number,
): Promise<void> {
  if (hasJevTools(callTool)) {
    const t = Date.now();
    const res = await callTool("jev_settle", { tabId, ...args });
    ctx.settleMs += Date.now() - t;
    if (!isToolError(res)) return;
  }
  if (legacyMs > 0) await pause(ctx, legacyMs);
}

/** Wait on purpose, and account for it: these sleeps are invisible otherwise. */
async function pause(ctx: RunContext, ms: number): Promise<void> {
  const t = Date.now();
  await new Promise((resolve) => setTimeout(resolve, ms));
  ctx.settleMs += Date.now() - t;
}

function tokensOf(usage: { input_tokens?: unknown; prompt_tokens?: unknown } | null | undefined): number {
  return Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0) || 0;
}

async function runCalls(callTool: CallTool, calls: PlannedCall[]): Promise<{ error: string | null }> {
  for (const [name, args] of calls) {
    const res = await callTool(name, args);
    if (isToolError(res)) return { error: resultText(res) };
  }
  return { error: null };
}
