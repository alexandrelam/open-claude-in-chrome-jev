// The two tools server-jev.ts adds on top of the ordinary catalog.
//
// Same {name, description, paramShape} shape as host/tool-definitions.ts, so
// the registration loop in the server does not have to special-case them.

import { z } from "zod";

import type { ToolDefinition } from "../tool-definitions.ts";

// One question Claude asks Jev, shared by jev_assess (per item) and
// jev_navigate (about the page the run ends on).
const QUESTION = z.object({
  key: z.string().describe("Short identifier used in the results, e.g. good_deal."),
  type: z.enum(["yes_no", "choice", "score"]),
  question: z.string().describe("The question, stated fully — Jev sees nothing else of your intent."),
  yes: z.string().optional().describe("yes_no: what counts as yes. Default 'Yes'."),
  no: z.string().optional().describe("yes_no: what counts as no. Default 'No'."),
  options: z.record(z.string()).optional().describe("choice: {key: description}, at least two."),
  scale: z
    .array(z.string())
    .optional()
    .describe("score: ordered labels, low to high, e.g. ['Poor','Fair','Good','Great']."),
});

const FILL_DEFAULTS =
  "Where a choice field (select, combobox, radio, checkbox) has no value in `values`, any valid option is acceptable and Jev picks the first real one. Never applies to free-text fields, which still return needs_value. Use it for forms whose choices you don't care about, e.g. test data.";

const NAVIGATE_SHAPE = {
  goal: z
    .string()
    .optional()
    .describe(
      'A single subgoal in natural language, e.g. "open the most recent invoice". Use this or `subgoals`, not both.',
    ),
  subgoals: z
    .array(
      z.object({
        goal: z.string().describe("This leg's objective."),
        success_criteria: z.string().describe("Observable condition that means this leg is finished."),
        values: z.record(z.string()).optional().describe("Text for this leg's fields, as {label: value}."),
        fill_defaults: z.boolean().optional().describe(`This leg only. ${FILL_DEFAULTS}`),
        optional: z
          .boolean()
          .optional()
          .describe(
            "If this leg fails, skip it and run the next one from wherever the page was left. Use for legs nothing later depends on, like dismissing a banner. Overrides continue_on_failure for this leg.",
          ),
      }),
    )
    .optional()
    .describe(
      "Several subgoals run in sequence in ONE call — prefer this for any multi-part task, and put as much of the plan in it as you can write without seeing the pages, since it collapses what would be several of your turns into one. Each leg starts from the page the previous one left. The run stops at the first leg that does not finish (unless it is optional), and `reason` names which, so you can take that step yourself and call again with the rest.",
    ),
  continue_on_failure: z
    .boolean()
    .optional()
    .describe(
      "Treat every leg as optional: a leg that fails is skipped and the run continues, returning status partial with the skipped legs listed. Only for independent legs — a later leg that needs an earlier one's page will then start from the wrong place. Running out of time or budget still stops the run. Default false.",
    ),
  tabId: z.number().describe("Tab ID to act in. Must be a tab in the MCP group — use tabs_context_mcp first."),
  success_criteria: z
    .string()
    .optional()
    .describe(
      'Observable condition for `goal`, e.g. "an invoice detail page with a total is shown". Checked on every step. Prefer criteria about WHERE you are over criteria about page content — "the revision history view is open" reads far more reliably than "a list of revisions with dates is shown", because the check sees the page\'s controls plus a short text excerpt rather than the full body. When the app puts state in the URL, say so as key=value ("newEncounterProfile=true in the URL"): that part is checked exactly. Required with `goal`; use the per-leg field inside `subgoals` instead.',
    ),
  values: z
    .record(z.string())
    .optional()
    .describe(
      "Text you supply for any field that has to be filled, as {label: value}. Jev picks which value belongs in which field but never invents one — if a field needs a value you did not provide, the call returns needs_value.",
    ),
  fill_defaults: z.boolean().optional().describe(`Every leg, unless a leg sets its own. ${FILL_DEFAULTS}`),
  questions: z
    .array(QUESTION)
    .optional()
    .describe(
      'Your questions about the page the run ends on, answered by Jev once every leg has finished (in the same request as final_check), and returned under `answers` as probabilities. Use them for verification — "is the Enable switch off?", "does the list show the new item?" — instead of taking a screenshot or reading the page yourself. Not asked when a leg stopped the run.',
    ),
  start_url: z.string().optional().describe("Navigate here before the first step. The loop itself can never navigate."),
  final_check: z
    .string()
    .optional()
    .describe(
      "One sentence describing the WHOLE intended end state, checked once after every subgoal has finished. Worth setting whenever later steps can undo earlier ones — some forms reset a section's style when a toggle changes, and a per-step check cannot see that because it only ever asks whether the current step is done. Costs one extra request.",
    ),
  max_steps: z.number().optional().describe("Maximum browser actions per subgoal (default 20, hard cap 50)."),
  max_ms: z
    .number()
    .optional()
    .describe(
      "Wall-clock budget in milliseconds for the whole call, across every subgoal (default 60000). Raise it for a long chain of subgoals — the default is sized for a few.",
    ),
  min_confidence: z
    .number()
    .optional()
    .describe(
      "Minimum decision confidence, 0..1 (default 0.6). Below this the loop hands back with needs_help rather than guessing.",
    ),
  allow_sensitive: z
    .boolean()
    .optional()
    .describe(
      "Permit actions that look destructive or irreversible (pay, delete, send, publish, submit). Default false, which stops and asks instead. Only set this when the user has asked for that specific action.",
    ),
} satisfies z.ZodRawShape;

const ASSESS_SHAPE = {
  items: z
    .array(
      z.object({
        url: z.string().optional().describe("Page to open and read. Only URLs you supply are ever opened."),
        text: z.string().optional().describe("Text you already hold (e.g. an ad body you fetched). No browsing."),
        goal: z
          .string()
          .optional()
          .describe("Run the navigation loop first (from `url` if given), then read the page it lands on."),
        success_criteria: z.string().optional().describe("For `goal`: the observable end state."),
        values: z.record(z.string()).optional().describe("For `goal`: text to type, as {label: value}."),
        label: z.string().optional().describe("Your name for the item, echoed in the results."),
        context: z.string().optional().describe("Facts about THIS item Jev should weigh, e.g. its price or storage."),
        selector: z
          .string()
          .optional()
          .describe("CSS selector of the part of the page to read, overriding the call's `selector`."),
      }),
    )
    .optional()
    .describe(
      "Any number of items; max_ms and the Jev budget bound the run, and `where` bounds the rows returned. Text items run in parallel; items that open pages share the tab and run in order.",
    ),
  items_script: z
    .string()
    .optional()
    .describe(
      "JavaScript run in `tabId` (top-level await allowed) whose last expression is an array of items shaped like `items` (e.g. [{url, label, context}] built from the page's data). They are appended to `items`, so extracting the list and judging it takes one call instead of two. The script runs with the user's session, so it can also `fetch()` further result pages and each item's page and return their content as `text` items: those are judged in parallel without opening anything, far faster than `url` items, which are opened one by one.",
    ),
  items_script_url: z
    .string()
    .optional()
    .describe(
      "Page to open before items_script runs, e.g. the listing, so the script never runs on wherever an earlier call left the tab. With or without it, the script waits for the page to stop rendering first.",
    ),
  items_script_timeout_ms: z
    .number()
    .optional()
    .describe("How long items_script may run, in ms (default 20000, max 120000)."),
  questions: z.array(QUESTION).describe("Asked of every item, all in one Jev request per item."),
  context: z
    .string()
    .optional()
    .describe(
      "Shared facts and rules applied to every item, e.g. 'New price today: 128 Go 527 €, 256 Go 680 €. A good deal is 15% or more below new, with an invoice.'",
    ),
  tabId: z.number().optional().describe("Tab to browse in. Required when any item has a url or goal."),
  where: z
    .array(
      z.object({
        key: z.string().describe("A question's key."),
        yes_above: z.number().optional().describe("yes_no: keep when P(yes) is above this, e.g. 0.5."),
        choice_in: z.array(z.string()).optional().describe("choice: keep when the chosen option is one of these."),
        score_at_least: z
          .number()
          .optional()
          .describe("score: keep when the score is at least this (0 = first label)."),
      }),
    )
    .optional()
    .describe(
      "Return only the rows that pass every condition, e.g. [{key:'available', yes_above:0.5}]. The summary still counts every item, rows that failed to load are always returned, and the rest are listed by label under filtered_out. Use it on long lists so you read the matches, not the whole table.",
    ),
  selector: z
    .string()
    .optional()
    .describe(
      "CSS selector of the part of each page to read. Default: <main>, else the body. Hidden text (collapsed panels, closed tabs) is read too.",
    ),
  max_chars: z.number().optional().describe("Page text sent to Jev per item (default 4000)."),
  return_chars: z
    .number()
    .optional()
    .describe(
      "Excerpt of each item's text returned to you, from the top of the page (default 300, 0 for none). With `evidence` on you rarely need more.",
    ),
  evidence: z
    .boolean()
    .optional()
    .describe(
      "Quote, with each answer, the passage of the page it rests on (default true). Jev picks the passage by number and the server returns it verbatim; turn it off only to save tokens on very long question lists.",
    ),
  max_ms: z
    .number()
    .optional()
    .describe("Wall-clock budget for the whole call (default 180000). Items past it are reported as skipped."),
  allow_sensitive: z
    .boolean()
    .optional()
    .describe("For items with a `goal`: permit actions that look irreversible. Default false."),
} satisfies z.ZodRawShape;

const DECIDE_SHAPE = {
  goal: z.string().describe("The subgoal to decide against."),
  tabId: z.number().describe("Tab ID to observe. Must be a tab in the MCP group."),
  success_criteria: z.string().describe("The observable condition that would mean the goal is met."),
  values: z.record(z.string()).optional().describe("Candidate values, as {label: value}."),
  allow_sensitive: z
    .boolean()
    .optional()
    .describe("Report a sensitive action as proposed rather than gated. Nothing is executed either way."),
} satisfies z.ZodRawShape;

/** jev_navigate's arguments, as validated by its schema. */
export type NavigateArgs = z.infer<z.ZodObject<typeof NAVIGATE_SHAPE>>;
/** jev_assess's arguments, as validated by its schema. */
export type AssessArgs = z.infer<z.ZodObject<typeof ASSESS_SHAPE>>;
/** jev_decide's arguments, as validated by its schema. */
export type DecideArgs = z.infer<z.ZodObject<typeof DECIDE_SHAPE>>;
/** One leg of a jev_navigate call. */
export type SubgoalArgs = NonNullable<NavigateArgs["subgoals"]>[number];
/** One item of a jev_assess call. */
export type AssessItem = NonNullable<AssessArgs["items"]>[number];
/** One `where` condition of a jev_assess call. */
export type WhereCondition = NonNullable<AssessArgs["where"]>[number];

export const JEV_TOOLS: ToolDefinition[] = [
  {
    name: "jev_navigate",
    description:
      "Delegate browser work to the Jev decision model, which picks each next action while the extension carries it out in the real profile. Put the WHOLE task in one call: the navigation and form legs as `subgoals`, the text to type as `values`, `fill_defaults` for choice fields you don't care about, and the check you would otherwise do by reading the page as `questions`.\n\nWhen it hands back (needs_help, needs_value, blocked), stay in Jev. `reason` and `blockers` say what is in the way (e.g. Save is disabled, and these fields are empty). Call again with fix-up legs followed by `remaining_subgoals`, which is returned for exactly that. If one step truly needs the ordinary tools, act by `ref` from `page_excerpt.interactive`, not by screenshot coordinates, and go back to jev_navigate for the rest.\n\nReturns the status, the steps taken, `answers` to your questions, and the final page's controls by ref. A status of partial means every leg ran but some optional ones were skipped; `reason` lists them.",
    paramShape: NAVIGATE_SHAPE,
  },
  {
    name: "jev_assess",
    description:
      "Ask Jev YOUR questions about many items in one call, and read every answer at the end in one table. Use it whenever you would otherwise open or read items one by one to judge them: listings, profiles, search results, rows of data. Each item is a page to open (`url`), text you already have (`text`), or a page reached by first running a navigation `goal` (the same loop as jev_navigate). Questions are yes_no, choice or score, and Jev answers each with a probability — it never writes text. Put the facts a page cannot know, and your rules for judging, in `context` (e.g. today's new price and what counts as a good deal): Jev applies them to every item. Items can also come from `items_script`, a script run on the page that returns them, so a list you would otherwise extract first is built and judged in the same call. Returns a per-question summary plus one row per item. Each answer carries `evidence`: the passage of the page it rests on, quoted verbatim, so you can check an answer, and read the names and figures behind it, without opening the page again.",
    paramShape: ASSESS_SHAPE,
  },
  {
    name: "jev_decide",
    description:
      "Advisory: observe the tab and ask Jev what it would do next, WITHOUT doing it. Returns the proposed operation, the target element, the full probability distribution and whether the action looks sensitive. Use it to sanity-check the loop on a new site, or to see Jev's reasoning shape before committing to jev_navigate.",
    paramShape: DECIDE_SHAPE,
  },
];

export const JEV_TOOL_NAMES = new Set(JEV_TOOLS.map((t) => t.name));
