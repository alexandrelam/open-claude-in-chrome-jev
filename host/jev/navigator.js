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
  isToolError,
  resultText
} from "./observe.js";
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
  namesAgree
} from "./actions.js";
import { shortlistRows, renderRow } from "./shortlist.js";
import { termsFrom, lexicalScore, prefilter } from "./relevance.js";
import { buildQuestions, questionsError, compactAnswer } from "./questions.js";
import { MAX_CHOICES } from "./config.js";
import { createTrace } from "./trace.js";
import { BudgetExceeded } from "./client.js";

const NONE = "NONE";

// How many times one subgoal may recover from a failure on its own before it
// hands back. Each recovery is a fresh look at the page and a fresh decision,
// so this bounds the extra Jev requests a flaky page can cost.
const MAX_RECOVERIES = 2;

/**
 * Will activating this href replace the document?
 *
 * A same-page fragment does not navigate; anything else does. Used to decide
 * what "the action landed" means for a CLICK — see the settle check below.
 */
export function navigatesAway(href, currentUrl) {
  if (!href) return false;
  try {
    const target = new URL(href, currentUrl);
    const here = new URL(currentUrl);
    return (
      target.origin !== here.origin ||
      target.pathname !== here.pathname ||
      target.search !== here.search
    );
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
export function urlContradicts(criteria, url) {
  if (!criteria || !/\burl\b/i.test(criteria)) return null;
  let params;
  try {
    params = new URL(url).searchParams;
  } catch {
    return null;
  }
  const loose = (v) => v.replace(/\+/g, " ").trim().toLowerCase();
  for (const [, key, raw] of criteria.matchAll(/([A-Za-z_][\w.-]*)=("[^"]*"|'[^']*'|[^\s,;)]+)/g)) {
    const want = loose(raw.replace(/^["']|["']$/g, ""));
    const got = params.get(key);
    // A prefix is enough: "tagfilter=mobile edit" parses as tagfilter=mobile.
    if (got === null || !loose(got).startsWith(want)) {
      return `the success criteria require ${key}=${want} in the URL, and the URL has ${got === null ? `no ${key}` : `${key}=${loose(got)}`}`;
    }
  }
  return null;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function domainAllowed(url, cfg) {
  const host = hostOf(url);
  if (!host) return true;
  const matches = (d) => host === d || host.endsWith(`.${d}`);
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
export function defaultOption(row) {
  return (row?.options ?? []).find(
    (o) => !o.selected && String(o.value ?? "").trim() !== "" && !PLACEHOLDER.test(String(o.label ?? "").trim())
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
export function buildRequest(obs, rows, { goal, successCriteria, values, fillDefaults = false, history = [] }, next = null) {
  const idMap = new Map();
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
  const state = {
    goal,
    success_criteria: successCriteria,
    url: obs.url,
    title: obs.title,
    page_excerpt: obs.excerpt,
    elements,
    values: valueKeys
  };
  // What this leg already did. Without it every decision is made from scratch,
  // and on the audited admin page Jev clicked "New template" three times in a
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
function goalQuestions(idMap, scroll, { successCriteria, values }, prefix, preamble) {
  const ops = availableOperations([...idMap.values()], scroll);
  const valueKeys = Object.keys(values || {});

  const operationCriteria = {};
  for (const op of ops) operationCriteria[op] = OPERATIONS[op].description;

  const questions = {
    [`${prefix}operation`]: {
      type: "choice",
      instructions:
        `${preamble}What single operation should the browser agent take next to advance the goal? Choose DONE only if the success criteria are already visibly met on this page.`,
      criteria: operationCriteria
    }
  };

  // One head per kind of operation, each listing only the rows it can act on
  // (see TARGET_HEADS). A head with no legal rows is omitted: a Choice needs
  // something to choose between, and an empty criteria object is malformed.
  //
  // renderRow is the single row renderer, so what Jev chooses between carries
  // the same detail the state listing does (value, type, options).
  for (const [head, spec] of Object.entries(TARGET_HEADS)) {
    const criteria = {};
    for (const [id, row] of idMap) {
      if (isCompatible(spec.accepts, row)) criteria[id] = renderRow(row, id);
    }
    if (Object.keys(criteria).length === 0) continue;
    questions[`${prefix}${head}`] = {
      type: "choice",
      instructions: `${preamble}${spec.instructions}`,
      criteria
    };
  }

  if (valueKeys.length > 0) {
    const valueCriteria = { [NONE]: "None of the provided values belongs in this field" };
    for (const k of valueKeys) valueCriteria[k] = `The value provided under "${k}"`;
    questions[`${prefix}value_key`] = {
      type: "choice",
      instructions:
        `${preamble}If the operation types or selects, which provided value belongs in the target field?`,
      criteria: valueCriteria
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
      false: "They are not satisfied yet"
    }
  };

  questions[`${prefix}sensitive`] = {
    type: "noul",
    instructions:
      `${preamble}Would performing this action have a destructive, financial or otherwise irreversible effect?`,
    criteria: {
      true: "It pays, deletes, sends, publishes, submits or otherwise commits something that cannot simply be undone",
      false: "It only navigates, reads, filters or fills in a field, and is safe to undo"
    }
  };

  return questions;
}

/** The answers to one goal's questions, with `prefix` stripped off the keys. */
export function answersFor(answers, prefix) {
  if (!prefix) return answers;
  const out = {};
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
export function validate(answers, idMap, cfg, { allowSensitive, values, fillDefaults = false }) {
  const opAns = answers.operation;
  if (!opAns?.choice || !OPERATIONS[opAns.choice]) {
    return { ok: false, status: "needs_help", reason: `Jev returned an unknown operation: ${opAns?.choice}` };
  }
  let operation = opAns.choice;
  let spec = OPERATIONS[operation];
  let demotedFrom = null;

  if (operation === "BLOCKED") {
    return { ok: false, status: "blocked", operation, reason: "Jev reports no offered operation can advance the goal from this page." };
  }

  let row = null;
  let confidence = opAns.confidence;

  if (spec.needsTarget) {
    const targetAns = answers[targetHead(operation)];
    row = targetAns?.choice ? idMap.get(targetAns.choice) : null;
    if (!row) {
      return { ok: false, status: "needs_help", operation, reason: `Jev chose target "${targetAns?.choice}", which is not in this observation.` };
    }
    // Still checked: a head is shared by operations with different rules
    // (TYPE_AND_SUBMIT refuses a combobox that TYPE_TEXT accepts).
    if (!isCompatible(operation, row)) {
      const lesser = DEMOTIONS[operation];
      if (!lesser || !isCompatible(lesser, row)) {
        return { ok: false, status: "needs_help", operation, reason: `Operation ${operation} is not valid on ${rowLabel(row)}.` };
      }
      // Both operations say "act on this field through this head"; they differ
      // only in the part the element refuses. So the mass Jev split between
      // them is all confidence in the part that survives.
      confidence = (opAns.probabilities?.[operation] ?? opAns.confidence) + (opAns.probabilities?.[lesser] ?? 0);
      demotedFrom = operation;
      operation = lesser;
      spec = OPERATIONS[operation];
    }
    // Every option in the head is legal for its operation, so the chosen
    // option's probability already is the confidence in the target given the
    // operation. Nothing is left to renormalize.
    const targetConfidence = targetAns.probabilities?.[targetAns.choice] ?? targetAns.confidence;

    // The step is only as certain as its least certain half: a confident
    // operation aimed at a coin-flip target is not a confident action.
    confidence = Math.min(confidence, targetConfidence);
  }

  if (confidence < cfg.minConfidence) {
    return {
      ok: false, status: "needs_help", operation, row, confidence,
      reason: `Confidence ${confidence.toFixed(2)} is below the ${cfg.minConfidence} threshold for ${operation} on ${rowLabel(row)}.`
    };
  }

  const sensitiveByModel = (answers.sensitive?.noul ?? 0) > cfg.sensitiveThreshold;
  const sensitiveByLabel = looksSensitive(row);
  if ((sensitiveByModel || sensitiveByLabel) && !allowSensitive) {
    return {
      ok: false, status: "needs_help", operation, row, confidence, sensitive: true,
      reason: `Refusing a possibly irreversible action: ${operation} on ${rowLabel(row)} (model p=${(answers.sensitive?.noul ?? 0).toFixed(2)}${sensitiveByLabel ? ", label matched a sensitive keyword" : ""}). Re-run with allow_sensitive: true, or do this step yourself.`
    };
  }

  let value;
  if (spec.needsValue) {
    const key = answers.value_key?.choice;
    const fits = key && key !== NONE && key in (values || {});
    // Choice fields only. A select's options are the page's own values, so
    // picking one invents nothing; a text field would need Jev to write text,
    // which it never does.
    const fallback = !fits && fillDefaults && operation === "SELECT" ? defaultOption(row) : undefined;
    if (fallback) {
      return { ok: true, operation, row, value: String(fallback.value), confidence, sensitive: sensitiveByModel || sensitiveByLabel, demotedFrom, defaulted: true };
    }
    if (!fits) {
      return {
        ok: false, status: "needs_value", operation, row, confidence,
        reason: `${operation} needs a value for ${rowLabel(row)} (role ${row?.role || "unknown"}${row?.type ? `, type ${row.type}` : ""}), and none of the provided values fits. Supply one in \`values\` and call again.`
      };
    }
    value = String(values[key]);
  }

  return { ok: true, operation, row, value, confidence, sensitive: sensitiveByModel || sensitiveByLabel, demotedFrom };
}

async function observeOrFail(callTool, tabId, cfg, opts = {}) {
  const obs = await observe(callTool, tabId, opts);
  if (obs.error) return { obs: null, failure: { status: "blocked", reason: obs.error } };
  if (!domainAllowed(obs.url, cfg)) {
    return {
      obs,
      failure: {
        status: "blocked",
        reason: `${hostOf(obs.url)} is outside the configured jev.allowed_domains / blocked in jev.blocked_domains, so no page content was sent and no action was taken.`
      }
    };
  }
  return { obs, failure: null };
}

function topN(probabilities, n) {
  return Object.entries(probabilities ?? {})
    .filter(([, p]) => p > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, p]) => ({ choice: k, p: Number(p.toFixed(3)) }));
}

function topTargets(probabilities, idMap, n) {
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
export async function decideOnce(callTool, client, cfg, args) {
  const { tabId, goal, success_criteria: successCriteria, values, allow_sensitive } = args;
  const fillDefaults = Boolean(args.fill_defaults);
  const { obs, failure } = await observeOrFail(callTool, tabId, cfg);
  if (failure) return { status: failure.status, reason: failure.reason };

  const short = await shortlistRows(obs.rows, {
    goal, successCriteria, values, maxRows: cfg.maxRows, pageUrl: obs.url,
    decide: (s, q) => client.decide(s, q)
  });
  const { state, questions, idMap } = buildRequest(obs, short.rows, { goal, successCriteria, values, fillDefaults });
  const { answers, ms, usage } = await client.decide(state, questions);
  const verdict = validate(answers, idMap, cfg, { allowSensitive: allow_sensitive, values, fillDefaults });

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
      target: topTargets(answers[targetHead(answers.operation?.choice) ?? "click_target"]?.probabilities, idMap, 5)
    },
    rows_offered: short.rows.length,
    rows_cut: short.cut,
    truncated: obs.truncated,
    url: obs.url,
    title: obs.title,
    jev_ms: ms,
    usage
  };
}

/** Normalise the two input shapes into one list. A bare goal is a list of one. */
export function normalizeSubgoals(args) {
  if (Array.isArray(args.subgoals) && args.subgoals.length) {
    return args.subgoals.map((sg) => ({
      goal: sg.goal,
      successCriteria: sg.success_criteria ?? sg.successCriteria,
      values: sg.values ?? args.values ?? {},
      optional: sg.optional ?? null,
      fillDefaults: Boolean(sg.fill_defaults ?? args.fill_defaults ?? false)
    }));
  }
  return [
    {
      goal: args.goal,
      successCriteria: args.success_criteria ?? args.successCriteria,
      values: args.values ?? {},
      fillDefaults: Boolean(args.fill_defaults ?? false)
    }
  ];
}

const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "listbox", "select", "spinbutton", "textarea"]);

function isField(row) {
  const role = (row.role || "").toLowerCase();
  if (["checkbox", "radio", "switch", "button", "submit", "reset", "hidden"].includes((row.type || "").toLowerCase())) return false;
  return FIELD_ROLES.has(role) || Array.isArray(row.options) || Boolean(row.type);
}

function looksEmpty(row) {
  const selected = row.options?.find((o) => o.selected);
  if (selected) return PLACEHOLDER.test(String(selected.label ?? "").trim()) || String(selected.value ?? "") === "";
  return PLACEHOLDER.test(String(row.value ?? "").trim());
}

const brief = (r) => ({ ref: r.ref, role: r.role, name: r.name, ...(r.section ? { section: r.section } : {}), ...(r.required ? { required: true } : {}) });

/**
 * Why a leg is stuck, when the page shows it: the disabled controls its goal
 * names, and the empty fields around them.
 *
 * The audited run stopped with "Confidence 0.52 is below the 0.6 threshold for
 * CLICK on button New template" while the real story was on screen: Save was
 * disabled because Visit type and Format were empty. Claude had to take a
 * screenshot to learn that, then finished the form by hand. Said in the
 * reason, it is a one-call fix: add legs for the fields, then retry.
 *
 * Returns null when nothing on the page explains the stop.
 */
export function diagnoseStop(obs, sub) {
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

  const names = (list) => list.map((r) => `"${r.name || r.ref}" (${r.role || "field"}, ${r.ref})`).join(", ");
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
async function runSubgoal(callTool, client, cfg, sub, opts, ctx) {
  const { tabId, allowSensitive, maxSteps, trace, next } = opts;
  let carry = opts.carry ?? null;
  const { goal, successCriteria, values, fillDefaults = false } = sub;

  const steps = [];
  // The last few actions, fed back to Jev on every decision (see buildRequest).
  const history = [];
  let lastSignature = null;
  let unchangedStreak = 0;
  const actionCounts = new Map();

  // Failures the loop gets past on its own, instead of handing each one to
  // Claude. Most hand-backs in real runs were not doubt, they were a page
  // mid-flight: an action that failed on a re-render, or a page that took
  // longer to update than the settle window. A fresh look and a fresh decision
  // clears those. `failedActions` keeps it honest: an action that already
  // failed from this page is never tried a second time.
  const recovered = [];
  const failedActions = new Map();
  const canRecover = (why) => {
    if (recovered.length >= MAX_RECOVERIES) return false;
    recovered.push(why);
    return true;
  };
  const stop = (status, reason, extra = {}) => {
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
  const observeNow = async () => {
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

    let short, request, answers, jevMs = 0, verdict, inputTokens = 0;
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
          decide: (st, q) => client.decide(st, q)
        });
        request = buildRequest(obs, short.rows, { goal, successCriteria, values, fillDefaults, history: history.slice(-3) }, ask);
        const res = await client.decide(request.state, request.questions);
        answers = res.answers;
        jevMs = res.ms;
        inputTokens = tokensOf(res.usage);
        ctx.jevMs += jevMs;
      } catch (err) {
        if (err instanceof BudgetExceeded) return stop("limit_reached", err.message, { fatal: true });
        return stop("needs_help", `Jev request failed: ${err?.message ?? err}`);
      }
      verdict = validate(answers, request.idMap, cfg, { allowSensitive, values, fillDefaults });
    }

    const contradiction = urlContradicts(successCriteria, obs.url);
    const satisfied = contradiction ? 0 : answers.satisfied?.noul ?? 0;

    trace.step({
      i, subgoal: goal, url: obs.url, title: obs.title, carried: Boolean(carried),
      rows_offered: short.rows.length, rows_cut: short.cut, rows_offscreen: short.offscreen ?? null, truncated: obs.truncated,
      satisfied, url_check: contradiction, answers: carried ? null : answers,
      verdict: { ok: verdict.ok, status: verdict.status ?? null, reason: verdict.reason ?? null },
      operation: verdict.operation, target_ref: verdict.row?.ref ?? null,
      jev_ms: jevMs, input_tokens: inputTokens
    });

    // The success check now governs completion, so it is tested before the
    // action and before any gate: if the page already satisfies the criteria,
    // there is nothing left to do and nothing to refuse.
    if (satisfied > 0.5) {
      return stop("done", null, { satisfied, carry: ask && !carried ? carryFor(answers, request, short, obs, ask, cfg, allowSensitive) : null });
    }

    if (!verdict.ok) return stop(verdict.status, verdict.reason);

    if (verdict.operation === "DONE") {
      // Jev says finished, the page says otherwise — exactly the disagreement
      // success_criteria exists to catch. DONE is now a signal, not a gate.
      steps.push({ i: ++ctx.actionNo, operation: "DONE", target_ref: null, target_label: "", confidence: verdict.confidence, ms: Date.now() - stepStart });
      unchangedStreak++;
      ctx.obs = null;
      if (unchangedStreak >= 2) {
        return stop("needs_help", `Jev reported DONE but the success criteria are not met (p=${satisfied.toFixed(2)}).`);
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
    if (count > 2) {
      return stop("needs_help", `The same action (${verdict.operation} on ${rowLabel(verdict.row)}) came up three times without progress.`);
    }
    if (failedActions.has(actionKey)) {
      return stop("needs_help", `The action failed, and was chosen again after a fresh look at the page: ${failedActions.get(actionKey)}`);
    }

    // Act. A ref can go stale between the observation and here — the Jev call
    // sits in between — so a ref failure re-observes and retries the same
    // operation once against the row that now carries that label.
    const actStart = Date.now();
    let acted = await runCalls(callTool, planToolCalls(verdict.operation, verdict.row, verdict.value, tabId, { jevTools: hasJevTools(callTool) }));
    // A covered target is not stale: re-finding it by name returns the same
    // covered element, so it goes straight back as the failure it is.
    if (acted.error && !/covered:/.test(acted.error) && /stale:|ref_\d+|not found|garbage collected/i.test(acted.error)) {
      const { obs: retryObs } = await observeNow();
      const again = retryObs?.rows.find(
        (r) => r.role === verdict.row.role && namesAgree(r.name, verdict.row.name)
      );
      if (again) {
        acted = await runCalls(callTool, planToolCalls(verdict.operation, again, verdict.value, tabId, { jevTools: hasJevTools(callTool) }));
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
      i: ++ctx.actionNo, operation: verdict.operation, target_ref: verdict.row?.ref ?? null,
      target_label: rowLabel(verdict.row), confidence: Number(verdict.confidence.toFixed(3)),
      ...(verdict.demotedFrom ? { demoted_from: verdict.demotedFrom } : {}),
      ...(verdict.defaulted ? { defaulted_value: verdict.value } : {}),
      ms: Date.now() - stepStart
    });

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

    const settled = (o) =>
      expectsNavigation ? o.url !== beforeUrl : observationSignature(o) !== before;

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
    await settle(callTool, tabId, ctx, {
      expect: expectsNavigation ? "navigation" : onCombobox ? "combobox" : "dom",
      fromUrl: beforeUrl, ref: verdict.row?.ref, timeoutMs: 2000
    }, 0);
    let { obs: after, failure: afterFail } = await observeNow();
    const jevTools = hasJevTools(callTool);
    const rechecks = !jevTools ? 4 : expectsNavigation ? 1 : 2;
    for (let n = 0; n < rechecks && !afterFail && !settled(after); n++) {
      await settle(callTool, tabId, ctx, { expect: "wait", timeoutMs: 250 }, 300);
      ({ obs: after, failure: afterFail } = await observeNow());
    }
    if (afterFail) {
      if (after) ctx.obs = after;
      return stop(afterFail.status, afterFail.reason, { fatal: true });
    }
    let sig = observationSignature(after);
    if (lastSignature !== null && sig === lastSignature) {
      unchangedStreak++;
      // A slow page — an SPA waiting on a fetch — looks exactly like a dead
      // one inside the normal settle window. Give it one long wait before
      // calling it no progress.
      if (unchangedStreak >= 2 && canRecover(`the page looked unchanged after ${verdict.operation} on ${rowLabel(verdict.row)}; waited longer`)) {
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
        return stop("needs_help", `Two steps in a row left the page unchanged after ${verdict.operation} on ${rowLabel(verdict.row)}.`);
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
      page_changed: sig !== before
    });
  }

  return stop("limit_reached", `Step limit of ${maxSteps} reached for this subgoal.`);
}

/**
 * The next leg's first decision, already answered by this leg's last request.
 *
 * Carried only when it is usable as-is: it passed the whole gate, or the next
 * leg is already satisfied on this page. Anything else — a refusal, low
 * confidence, a missing value — is dropped, and the next leg simply asks
 * again, so the gate's verdict always comes from a decision it can act on.
 */
function carryFor(allAnswers, request, short, obs, next, cfg, allowSensitive) {
  const answers = answersFor(allAnswers, "next_");
  if (!answers.operation) return null;
  const verdict = validate(answers, request.idMap, cfg, { allowSensitive, values: next.values, fillDefaults: next.fillDefaults });
  const satisfied = urlContradicts(next.successCriteria, obs.url) ? 0 : answers.satisfied?.noul ?? 0;
  if (!verdict.ok && !(satisfied > 0.5)) return null;
  return { obs, short, request, answers, verdict };
}

/**
 * The page's controls as Claude should see them on hand-back: by real ref, so
 * a fallback click can use `ref` instead of reading coordinates off a
 * screenshot; disabled ones included and marked; the rows the stuck leg names
 * first, then what is on screen. Kept in document order.
 */
export function handbackRows(obs, sub, limit) {
  const rows = obs?.allRows ?? obs?.rows ?? [];
  const terms = termsFrom(sub?.goal, sub?.successCriteria);
  const tier = (r) => (lexicalScore(r, terms) > 0 ? 0 : r.inView === false ? 2 : 1);
  return rows
    .map((r, i) => ({ r, i, t: tier(r) }))
    .filter(({ r }) => r.role || r.name || r.href)
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .slice(0, limit)
    .sort((a, b) => a.i - b.i)
    .map(({ r }) => renderRow(r, r.ref));
}

/** The full loop over one or more subgoals. Backs the jev_navigate tool. */
export async function navigate(callTool, client, cfg, args) {
  const { tabId, values = {}, start_url: startUrl, allow_sensitive: allowSensitive = false } = args;
  const questions = Array.isArray(args.questions) && args.questions.length ? args.questions : null;

  // Refused before anything is opened or clicked, as jev_assess does.
  if (questions) {
    const qErr =
      questionsError(questions) ??
      (questions.some((q) => q.key === "verified") ? 'Question key "verified" is reserved for final_check; use another name.' : null);
    if (qErr) return { status: "error", reason: qErr };
  }

  const subgoals = normalizeSubgoals(args);
  // max_steps bounds each subgoal so one runaway leg cannot eat the whole call;
  // max_ms and the spend cap bound the call as a whole.
  const maxSteps = Math.min(args.max_steps ?? cfg.maxSteps, cfg.maxSteps);
  const maxMs = args.max_ms ?? cfg.maxMs;
  const minConfidence = args.min_confidence ?? cfg.minConfidence;
  const runCfg = { ...cfg, minConfidence };

  const trace = createTrace(cfg.tracesDir, {
    goal: subgoals.map((s) => s.goal).join(" → "),
    subgoals: subgoals.map((s) => ({ goal: s.goal, success_criteria: s.successCriteria })),
    tab_id: tabId, model: cfg.model, max_steps: maxSteps, max_ms: maxMs,
    min_confidence: minConfidence, allow_sensitive: allowSensitive,
    value_keys: Object.keys(values)
  });

  const startedAt = Date.now();
  const ctx = { obs: null, deadline: startedAt + maxMs, decisionNo: 0, actionNo: 0, browserMs: 0, jevMs: 0, settleMs: 0 };
  const legs = [];
  const allSteps = [];
  let status = "done";
  let reason = null;
  // Set when a leg stops the run: what is in the way, and the legs after it,
  // echoed verbatim so Claude can re-call with [fix-up legs, ...remaining].
  let blockers = null;
  let remaining = null;
  let stoppedLeg = null;
  let answers = null;

  const finish = () => {
    const obs = ctx.obs;
    // A truncated observation is a real possible cause of "nothing here can
    // help": read_page hit its own character cap, so rows were dropped before
    // the prefilter could even rank them. Saying so turns a confidently wrong
    // answer into a legible one — an Octopus article yields 1,412 rows and
    // truncates, and this was only ever recorded in the trace.
    if (status !== "done" && obs?.truncated) {
      reason = `${reason ?? "Stopped."} NOTE: the page was too large to read in full (read_page truncated it), so some controls were never observed and could not be chosen. Try a narrower start_url, or scroll to the relevant part first.`;
    }
    const out = {
      status,
      steps: allSteps,
      subgoals: legs,
      final_url: obs?.url ?? "",
      final_title: obs?.title ?? "",
      reason,
      // The final page, so Claude can carry on without spending a turn on
      // read_page just to find out where the loop left the tab.
      ...(answers ? { answers } : {}),
      ...(blockers ? { blockers } : {}),
      ...(remaining ? { remaining_subgoals: remaining } : {}),
      page_excerpt: obs
        ? {
            url: obs.url, title: obs.title, text: obs.excerpt,
            // Rendered by ref, not e-id: these are what Claude acts on if it
            // has to take a step itself. More of them when it will.
            interactive: handbackRows(obs, stoppedLeg, status === "done" ? 40 : 80)
          }
        : null,
      // wall ≈ jev + browser + settle. settle is time spent deliberately
      // waiting for the page, which neither of the other two counts.
      usage: { ...client.totals, jev_ms: ctx.jevMs, browser_ms: ctx.browserMs, settle_ms: ctx.settleMs, wall_ms: Date.now() - startedAt },
      run_id: trace.runId
    };
    trace.finish(
      { status, reason, final_url: out.final_url, subgoals: legs.map((l) => ({ goal: l.goal, status: l.status })) },
      out.usage
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

  const finalCheck = args.final_check ?? args.finalCheck ?? null;
  const continueOnFailure = Boolean(args.continue_on_failure ?? args.continueOnFailure);

  let carry = null;
  const skipped = [];
  let stopped = false;
  for (const [idx, sub] of subgoals.entries()) {
    const leg = await runSubgoal(
      callTool, client, runCfg, sub,
      { tabId, allowSensitive, maxSteps, trace, next: subgoals[idx + 1] ?? null, carry },
      ctx
    );
    carry = leg.carry ?? null;
    // A leg that fails but may be skipped is recorded and passed over; the next
    // leg starts from wherever this one left the page. Running out of time or
    // budget, or losing the page, stops every leg alike, so those never skip.
    const skip = leg.status !== "done" && !leg.fatal && (sub.optional ?? continueOnFailure);
    legs.push({
      i: idx + 1, goal: sub.goal, status: leg.status, steps: leg.steps, reason: leg.reason,
      ...(leg.blockers ? { blockers: leg.blockers } : {}),
      ...(leg.recovered?.length ? { recovered: leg.recovered } : {}),
      ...(skip ? { skipped: true } : {})
    });
    allSteps.push(...leg.steps);
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
      status = skipped[0].status;
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
  // app does: turning on "Split by problem" resets the section style a previous
  // leg had just set. One question against the whole intended end state is the
  // only thing that catches it.
  //
  // Claude's own questions ride in the same request. They are how a task ends
  // in verification without Claude reading the page: "is the Enable switch
  // off?" was thirteen manual calls in the audited run. Asked only when the
  // run got where it was going; on a page a leg stopped at, the answers would
  // describe the wrong place.
  // final_check only judges a run that claims to be done; questions are
  // answered on a partial run too, since skipped legs were optional ones.
  const checkEnd = status === "done" ? finalCheck : null;
  const askQuestions = (status === "done" || status === "partial") ? questions : null;
  if (checkEnd || askQuestions) {
    const { obs: finalObs } = await (async () => {
      const t = Date.now();
      // A wider excerpt than a step gets. The 300-char cap exists because more
      // prose dilutes an ACTION decision; these questions are about the page's
      // content, which the controls alone often do not show.
      const r = await observeOrFail(callTool, tabId, runCfg, { excerptChars: 1500 });
      ctx.browserMs += Date.now() - t;
      return r;
    })();
    if (finalObs) ctx.obs = finalObs;
    const jevQuestions = {};
    if (askQuestions) Object.assign(jevQuestions, buildQuestions(askQuestions));
    if (checkEnd) {
      jevQuestions.verified = {
        type: "noul",
        instructions: `Is ALL of this true of the page right now: ${checkEnd}`,
        criteria: {
          true: "Every part of the intended end state is visibly in place",
          false: "Some part of it is missing, or was undone"
        }
      };
    }
    // The rows the questions name, when the page has more than fit.
    const rows = prefilter(ctx.obs?.rows ?? [], {
      goal: [checkEnd, ...(askQuestions ?? []).map((q) => q.question)].filter(Boolean).join(" "),
      limit: runCfg.maxRows,
      pageUrl: ctx.obs?.url
    }).rows;
    try {
      const t = Date.now();
      const { answers: got } = await client.decide(
        {
          ...(checkEnd ? { intended_end_state: checkEnd } : {}),
          url: ctx.obs?.url,
          title: ctx.obs?.title,
          page_excerpt: ctx.obs?.excerpt,
          elements: rows.map((r, k) => renderRow(r, `e${k + 1}`))
        },
        jevQuestions
      );
      ctx.jevMs += Date.now() - t;
      if (askQuestions) {
        answers = {};
        for (const q of askQuestions) answers[q.key] = compactAnswer(got[q.key]);
      }
      const p = got.verified?.noul ?? 0;
      trace.step({ i: ++ctx.decisionNo, final_check: checkEnd, verified: checkEnd ? p : null, answers, url: ctx.obs?.url });
      if (checkEnd && p <= 0.5) {
        status = "needs_help";
        reason = `Every subgoal finished, but the final check did not hold (p=${p.toFixed(2)}): ${checkEnd}. Something set earlier was probably undone by a later step — inspect the page before treating this as done.`;
      }
    } catch (err) {
      if (checkEnd) {
        status = "needs_help";
        reason = `Every subgoal finished, but the final check could not be run: ${err?.message ?? err}`;
      } else {
        reason = `${reason ? `${reason} ` : ""}The questions could not be answered: ${err?.message ?? err}`;
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
async function settle(callTool, tabId, ctx, args, legacyMs) {
  if (hasJevTools(callTool)) {
    const t = Date.now();
    const res = await callTool("jev_settle", { tabId, ...args });
    ctx.settleMs += Date.now() - t;
    if (!isToolError(res)) return;
  }
  if (legacyMs > 0) await pause(ctx, legacyMs);
}

/** Wait on purpose, and account for it: these sleeps are invisible otherwise. */
async function pause(ctx, ms) {
  const t = Date.now();
  await new Promise((resolve) => setTimeout(resolve, ms));
  ctx.settleMs += Date.now() - t;
}

function tokensOf(usage) {
  return Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0) || 0;
}

async function runCalls(callTool, calls) {
  for (const [name, args] of calls) {
    const res = await callTool(name, args);
    if (isToolError(res)) return { error: resultText(res) };
  }
  return { error: null };
}
