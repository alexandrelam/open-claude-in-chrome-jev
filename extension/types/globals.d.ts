// Types shared across the extension's execution contexts.
//
// The content scripts (content.ts, recorder/capture.ts, audit/inject.ts) are
// classic scripts, not modules: Chrome injects them as-is, so they cannot
// import anything, and a type-only import would still make tsc emit an
// `export {}` that breaks them. What they share with the service worker is
// therefore declared here, globally, with no import or export in this file.

// ---- Page globals the content scripts set ----------------------------------

interface Window {
  /** content.ts has run in this document. */
  __unblockedChromeLoaded?: boolean;
  /** content.ts's functions, for an executeScript fallback. */
  __unblockedChrome?: Record<string, unknown>;
  /** recorder/capture.ts has run in this document. */
  __ocicRecorderLoaded?: boolean;
  /** audit/inject.ts has run in this document. */
  __ocicAuditReady?: boolean;
  __ocicAuditStart?: (streamId: string, opts?: { maskInputs?: boolean }) => AuditStartResult;
  __ocicAuditStop?: () => { ok: true; streamId: string | null };
  /** The vendored rrweb-player UMD bundle (options page only). */
  rrwebPlayer?: RrwebPlayerConstructor | { default: RrwebPlayerConstructor };
}

interface RrwebPlayer {
  goto(offsetMs: number, play?: boolean): void;
  pause(): void;
}

type RrwebPlayerConstructor = new (options: {
  target: HTMLElement;
  props: { events: unknown[]; width: number; height: number; autoPlay: boolean; showController: boolean };
}) => RrwebPlayer;

type AuditStartResult = { ok: true; streamId: string | null; already?: true } | { ok: false; error: string };

/** An rrweb event, as far as this code reads one. */
interface RrwebEventLike {
  timestamp: number;
  [key: string]: unknown;
}

/** The part of the vendored rrweb bundle (vendor/rrweb.umd.min.js) audit/inject.ts uses. */
declare const rrweb:
  | {
      record(options: {
        emit(event: RrwebEventLike): void;
        recordCanvas?: boolean;
        collectFonts?: boolean;
        inlineStylesheet?: boolean;
        sampling?: Record<string, unknown>;
        maskAllInputs?: boolean;
      }): (() => void) | undefined;
    }
  | undefined;

// ---- background.ts <-> content.ts ------------------------------------------

/** One interactive element, as content.ts describes it. */
interface ContentRow {
  ref: string;
  role: string;
  name: string;
  href?: string;
  src?: string;
  value?: string;
  type?: string;
  expanded?: string;
  checked?: string | boolean;
  selected?: string;
  disabled?: true;
  required?: true;
  section?: string;
  options?: Array<{ value: string; label: string; selected: boolean }>;
  indent?: number;
  inView?: boolean;
}

interface AccessibilityOptions {
  filter?: string | undefined;
  depth?: number | undefined;
  max_chars?: number | undefined;
  ref_id?: string | undefined;
}

interface JevSnapshot {
  url: string;
  title: string;
  rows: ContentRow[];
  truncated: boolean;
  text: string;
  scroll: { y: number; height: number; viewport: number };
}

/** What describePoint found at a viewport coordinate. */
interface PointDescription {
  hit: {
    tag: string;
    attrs: Record<string, string>;
    cls: string;
    text: string;
    ref: string | null;
  } | null;
  outside?: boolean;
  bare?: boolean;
  deadLabel?: boolean;
  viewport: [number, number];
}

/** Where a ref is, after scrolling it into view, and what (if anything) covers it. */
interface RefCoordinates {
  x: number;
  y: number;
  reachable: boolean;
  covering: string | null;
  scrolledFrom: [number, number] | null;
}

interface FoundElement {
  ref: string;
  role: string;
  name: string;
  coordinates: [number, number];
  offViewport: boolean;
}

type SetFormValueResult = { error: string } | { success: true; checked: boolean } | { success: true; value: unknown };

type JevGuardResult = { ok: true } | { ok: false; reason: string };

/**
 * Every request background.ts sends to content.ts, keyed by `type`, with the
 * fields it carries and the response content.ts answers with.
 */
interface ContentRequests {
  generateAccessibilityTree: { req: { options: AccessibilityOptions }; res: { result: string } };
  jevGuard: {
    req: { ref: string; expect?: { role?: string; name?: string } | undefined };
    res: { result: JevGuardResult };
  };
  jevSettle: {
    req: { mode: "quiet" | "combobox" | "dom"; ref?: string | undefined; timeoutMs: number };
    res: { result: "timeout" | "quiet" | "settled" };
  };
  jevSnapshot: {
    req: { options: { depth?: number | undefined; max_rows?: number | undefined; text_chars?: number | undefined } };
    res: { result: JevSnapshot };
  };
  getPageText: { req: object; res: { result: string } };
  findElements: { req: { query: string }; res: { result: FoundElement[] } };
  setFormValue: { req: { ref: string; value: unknown }; res: { result: SetFormValueResult } };
  describePoint: { req: { x: number; y: number }; res: { result: PointDescription } };
  getRefCoordinates: { req: { ref: string; scrollIntoView: boolean }; res: { result: RefCoordinates | null } };
  markElementForUpload: {
    req: { ref: string };
    res: { ok: false } | { ok: true; isFileInput: boolean; tag: string };
  };
  unmarkElementForUpload: { req: object; res: { ok: true } };
  /** Sent by scroll_to; no content script handles it, so it resolves undefined. */
  scrollToRef: { req: { ref: string }; res: never };
}

type ContentRequestType = keyof ContentRequests;

type ContentRequest<K extends ContentRequestType = ContentRequestType> = {
  [T in K]: { type: T } & ContentRequests[T]["req"];
}[K];

// ---- recorder/capture.ts <-> background.ts ---------------------------------

/** A behavior event as capture.ts reports it: epoch-stamped, before the offscreen buffer rebases it. */
interface CapturedEvent {
  __ocic: "behavior_event";
  t: number;
  vw: number;
  vh: number;
  action: string;
  anchor?:
    | {
        selector?: string;
        role?: string | undefined;
        name?: string | undefined;
        text?: string | undefined;
        tag?: string;
        attrs?: Record<string, string>;
        path?: string[];
      }
    | undefined;
  suppressed?: true | undefined;
  inferred?: true | undefined;
  value?: unknown;
  command?: { tool: string; input: Record<string, unknown> };
  t_down?: number;
  t_up?: number;
  effect?: { added?: string[]; removed?: string[]; urlChanged?: string };
}

/** What content scripts send the service worker. */
type RecorderMessage =
  | CapturedEvent
  | { __ocic: "cursor_batch"; points: Array<{ t: number; x: number; y: number }>; vw: number; vh: number }
  | { __ocic: "recorder_hello" }
  | { type: "audit_events"; streamId: string; seq: number; events: RrwebEventLike[] };

/** What the service worker sends capture.ts and inject.ts. */
type TabMessage = { __ocic: "recording_state"; on: boolean } | { type: "audit_ping" };
