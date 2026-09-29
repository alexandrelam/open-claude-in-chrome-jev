// Shapes shared across the Jev modules: what the browser tools return, what a
// page observation holds, and what the Decisions API is asked and answers.

/** Arguments to a browser tool. */
export type ToolArgs = Record<string, unknown>;

/** One content block of a tool result. Only text blocks are ever read here. */
export interface ContentBlock {
  type: string;
  text?: string | undefined;
}

/** An MCP CallToolResult, as far as this code reads it. */
export interface ToolResult {
  content?: ContentBlock[] | undefined;
  isError?: boolean | undefined;
}

/**
 * How the loop reaches the browser: host/tool-runtime.ts's callTool in
 * production, a fake in the tests.
 */
export type CallTool = (name: string, args: ToolArgs) => Promise<ToolResult | string>;

/** One tool call planned for an operation: [tool name, its arguments]. */
export type PlannedCall = [string, ToolArgs];

/** One option of a select or listbox. */
export interface RowOption {
  value: string;
  label: string;
  selected: boolean;
}

/** A tri-state attribute: a boolean when the page said true/false, else the raw text. */
export type Flag = boolean | string | undefined;

/** One interactive element of an observed page. */
export interface Row {
  ref: string;
  role: string;
  name: string;
  indent: number;
  href: string;
  src?: string;
  value: string;
  type: string;
  section: string;
  expanded?: Flag;
  checked?: Flag;
  selected?: Flag;
  disabled?: boolean;
  required?: boolean;
  /** A field that shows a value but does not take typing. */
  readonly?: boolean;
  options: RowOption[] | null;
  /** Whether the element is on screen. Only a jev_snapshot observation knows. */
  inView?: boolean | undefined;
  /** The page-map region it sits in, when the observation asked for a map. */
  region?: string | undefined;
}

/** One region of the page map, as jev_snapshot sends it (content.ts buildPageMap). */
export interface PageRegion {
  id: string;
  parent: string | null;
  kind: string;
  name: string;
  /** Rendered text the region holds itself, not counting its child regions. */
  text: string;
  /** Text in the DOM but not rendered: collapsed panels, closed tabs. */
  hidden?: string | undefined;
  y?: number | undefined;
  inView?: boolean | undefined;
}

/** Scroll position of the page, from jev_snapshot. */
export interface ScrollState {
  y: number;
  height: number;
  viewport: number;
}

/** One look at a tab. */
export interface Observation {
  url: string;
  title: string;
  rows: Row[];
  allRows: Row[];
  truncated: boolean;
  excerpt: string;
  scroll?: ScrollState | null;
  /** The whole page as regions, when the observation asked for a map. */
  regions?: PageRegion[] | undefined;
  /** The map hit its size cap, so some of the page's text is missing from it. */
  mapTruncated?: boolean | undefined;
}

/** An observation, or why one could not be taken. */
export type ObservationResult = Observation | { error: string };

/** A question in the Decisions API's shape. */
export interface JevQuestion {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria: Record<string, string> | string[];
}

export type JevQuestions = Record<string, JevQuestion>;

/**
 * An answer, normalized so every type carries a comparable `confidence`.
 * Which of the other fields are set depends on `type`.
 */
export interface Answer {
  type: string;
  raw?: unknown;
  confidence?: number;
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

export type Answers = Record<string, Answer>;

/** Usage as the provider reports it, with `cost` always a number. */
export interface JevUsage {
  cost: number;
  input_tokens?: number;
  prompt_tokens?: number;
  [key: string]: unknown;
}

export interface DecideResult {
  answers: Answers;
  usage: JevUsage;
  model: string | null;
  ms: number;
  raw?: unknown;
}

export interface ClientTotals {
  requests: number;
  input_tokens: number;
  cost_usd: number;
  budget_usd: number;
  resolved_model: string | null;
}

/** Asks Jev one set of questions about one state. */
export type Decide = (
  state: unknown,
  questions: JevQuestions,
  opts?: { signal?: AbortSignal },
) => Promise<DecideResult>;

export interface JevClient {
  decide: Decide;
  readonly totals: ClientTotals;
}

/** The resolved Jev configuration (see config.ts). */
export interface JevConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxSteps: number;
  maxMs: number;
  minConfidence: number;
  maxRows: number;
  budgetUsd: number;
  sensitiveThreshold: number;
  /** null means no allowlist; an empty array permits nothing. */
  allowedDomains: string[] | null;
  blockedDomains: string[];
  tracesDir: string;
  /** Regions kept per exploration round besides the clearly relevant ones. */
  exploreBeam?: number | undefined;
  /** Most score-and-expand rounds one exploration may take. */
  exploreMaxRounds?: number | undefined;
  /** Page text read in one request; a page longer than this is explored. */
  exploreLeafChars?: number | undefined;
}

/** When a long page is explored region by region instead of read in one shot. */
export type ExploreMode = "auto" | "always" | "never";

/** One of Claude's own questions, as jev_assess and jev_navigate accept them. */
export interface ClaudeQuestion {
  key: string;
  type: "yes_no" | "choice" | "score";
  question: string;
  yes?: string | undefined;
  no?: string | undefined;
  options?: Record<string, string> | undefined;
  scale?: string[] | undefined;
}

/** One answer compacted for Claude to read. */
export interface CompactAnswer {
  yes?: number;
  choice?: string | undefined;
  p?: number;
  runner_up?: { choice: string; p: number };
  score?: number;
  label?: string;
  confidence?: number;
  evidence?: string;
}
