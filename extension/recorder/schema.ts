// Imitation-learning trace schema — version 0.
//
// The trace is TWO parallel tracks on ONE epoch clock, never one merged
// sequence: behavior and narration overlap (you talk while you act), so
// flattening them would destroy ordering information. A viewer aligns them on
// the clock; the agent reads both.
//
// This module is dependency-free and runs unchanged in the extension
// (content script / offscreen / service worker) and in Node (the stop
// pipeline and tests).

export const SCHEMA_VERSION = "v0";

/** The exact OCIC tool input that reproduces an event. */
export interface Command {
  tool: string;
  input: Record<string, unknown>;
}

/** A durable description of the element an event acted on. */
export interface Anchor {
  selector?: string | undefined;
  role?: string | undefined;
  name?: string | undefined;
  text?: string | undefined;
  tag?: string | undefined;
  attrs?: Record<string, string> | undefined;
  path?: string[] | undefined;
}

/** What changed on the page as a result of an action. */
export interface Effect {
  added?: string[] | undefined;
  removed?: string[] | undefined;
  textChanged?: string[] | undefined;
  urlChanged?: string | undefined;
}

/** One entry of Track A. `t` is ms since the trace's started_at. */
export interface BehaviorEvent {
  t: number;
  tab: number;
  frame: number;
  action: string;
  command?: Command;
  url?: string;
  t_down?: number;
  t_up?: number;
  anchor?: Anchor;
  effect?: Effect;
  value?: unknown;
  suppressed?: true;
  inferred?: true;
  screenshot?: string;
}

/** A behavior event as a content script or the service worker reports it. */
export interface BehaviorInput {
  t: number;
  tab: number;
  frame?: number | undefined;
  action: string;
  command?: Command | undefined;
  url?: string | undefined;
  t_down?: number | undefined;
  t_up?: number | undefined;
  anchor?: Anchor | undefined;
  effect?: Effect | undefined;
  value?: unknown;
  suppressed?: boolean | undefined;
  inferred?: boolean | undefined;
  screenshot?: string | undefined;
}

export interface Utterance {
  t: number;
  end: number;
  text: string;
}

export interface CursorPoint {
  t: number;
  x: number;
  y: number;
}

export interface ImageRef {
  t: number;
  ref: string;
  w?: number | undefined;
  h?: number | undefined;
  vw?: number | undefined;
  vh?: number | undefined;
}

/** A Whisper verbose_json segment: seconds relative to the audio. */
export interface WhisperSegment {
  start: number;
  end: number;
  text?: string;
}

/** One audio segment's transcription outcome, on the shared clock. */
export interface SegmentStatus {
  index: number;
  t: number;
  status: string;
}

export interface Trace {
  schema: string;
  recording_id: string;
  started_at: number;
  ended_at: number | null;
  url0: string | null;
  behavior: BehaviorEvent[];
  cursor: CursorPoint[];
  images: ImageRef[];
  cognitive: Utterance[];
  transcript_status?: string;
  transcript_segments?: SegmentStatus[];
  [key: string]: unknown;
}

// ---- Track A: behavior -----------------------------------------------------
// One entry per captured interaction. Grounded in OCIC's computer-tool verbs.
export const ACTIONS = Object.freeze({
  LEFT_CLICK: "left_click",
  RIGHT_CLICK: "right_click",
  DOUBLE_CLICK: "double_click",
  TRIPLE_CLICK: "triple_click",
  HOVER: "hover", // inferred: a brief dwell over an element
  LEFT_CLICK_DRAG: "left_click_drag", // inferred: button-held move; endpoints + time range
  TYPE: "type",
  KEY: "key",
  SCROLL: "scroll",
  NAVIGATE: "navigate",
  TAB_ACTIVATED: "tab_activated", // segmentation: operator switched tabs
  TAB_OPENED: "tab_opened",
  TAB_CLOSED: "tab_closed",
});
// Raw cursor trajectory (Layer 2) lives in its own track, not as behavior
// events — see the cursor field on the trace. mouse_move is intentionally NOT
// a behavior action; the trajectory is the cursor track.

/**
 * A behavior event. `t` is ms since trace.started_at (the shared clock).
 * Every event is namespaced by (tab, frame) because each document numbers its
 * own DOM nodes independently — never assume a global id space.
 *
 * @param {object} o
 * @param {number} o.t            ms since started_at
 * @param {number} o.tab          chrome tabId
 * @param {number} [o.frame=0]    frameId
 * @param {string} o.action       one of ACTIONS
 * @param {object} [o.anchor]     durable semantic anchor (see makeAnchor)
 * @param {object} [o.effect]     pre/post DOM-effect summary
 * @param {*}      [o.value]      typed text, scroll delta, key, url, etc.
 * @param {boolean}[o.suppressed] true when captured in override/mask mode
 * @param {string} [o.screenshot] optional bundle-relative screenshot path
 */
export function makeBehaviorEvent(o: BehaviorInput): BehaviorEvent {
  const e: BehaviorEvent = {
    t: o.t,
    tab: o.tab,
    frame: o.frame ?? 0,
    action: o.action,
  };
  // THE CORE KEY: the exact OCIC tool input that reproduces this event
  // ({ tool, input }); viewport-px space. Absent only where no OCIC verb
  // exists (tab_activated). Everything else on the event is enrichment.
  if (o.command) e.command = o.command;
  // context / timing enrichments
  if (o.url !== undefined) e.url = o.url;
  if (o.t_down !== undefined) e.t_down = o.t_down;
  if (o.t_up !== undefined) e.t_up = o.t_up;
  if (o.anchor) e.anchor = o.anchor;
  if (o.effect) e.effect = o.effect;
  if (o.value !== undefined) e.value = o.value;
  if (o.suppressed) e.suppressed = true;
  if (o.inferred) e.inferred = true; // heuristic-derived (hover, drag)
  if (o.screenshot) e.screenshot = o.screenshot;
  return e;
}

/**
 * A DURABLE semantic anchor. Resolved at capture time from the live element,
 * because ephemeral per-session node ids are useless to an agent later.
 * Everything downstream keys off selector + role + name + text, never an id.
 */
export function makeAnchor({ selector, role, name, text, tag, attrs, path }: Anchor): Anchor {
  const a: Anchor = {};
  if (selector) a.selector = selector;
  if (role) a.role = role;
  if (name) a.name = name; // accessible name
  if (text) a.text = text.slice(0, 120); // visible text, bounded
  if (tag) a.tag = tag;
  if (attrs) a.attrs = attrs; // { id, class, "data-testid", type, name, href, aria-* }
  if (path) a.path = path; // ancestor chain of cleaned opening tags (location context)
  return a;
}

/**
 * A pre/post DOM-effect summary: what changed as a result of the action.
 * This is the action->result signal an agent learns from (rrweb-style
 * mutation delta, but bounded and semantic rather than a full replay stream).
 */
export function makeEffect({ added, removed, textChanged, urlChanged }: Effect): Effect {
  const e: Effect = {};
  if (added && added.length) e.added = added.slice(0, 8); // brief descriptors
  if (removed && removed.length) e.removed = removed.slice(0, 8);
  if (textChanged && textChanged.length) e.textChanged = textChanged.slice(0, 8);
  if (urlChanged) e.urlChanged = urlChanged;
  return e;
}

// ---- Track B: cognitive (narration) ---------------------------------------
/**
 * An utterance span from the transcript. `t`/`end` are ms since started_at.
 */
export function makeUtterance({ t, end, text }: Utterance): Utterance {
  return { t, end, text };
}

// ---- The trace -------------------------------------------------------------
export function newTrace(startedAt: number, session: { recording_id: string; url0?: string | null }): Trace {
  return {
    schema: SCHEMA_VERSION,
    recording_id: session.recording_id,
    started_at: startedAt, // epoch ms — the shared zero for all tracks
    ended_at: null,
    url0: session.url0 ?? null, // first URL, for quick context
    behavior: [], // Track A — discrete events (clicks, type, nav, hover, drag)
    cursor: [], // Track C — raw cursor trajectory [{t,x,y}] (the gesture signal)
    images: [], // Track D — frame references [{t,ref,w,h}] into the images/ dir
    cognitive: [], // Track B — narration (filled at stop from the transcript)
  };
}

// Cursor points arrive as epoch-stamped {t,x,y}; convert to the shared clock.
export function cursorToTrack(
  points: readonly CursorPoint[] | null | undefined,
  traceStartedAt: number,
): CursorPoint[] {
  return (points || [])
    .map((p) => ({ t: Math.round(p.t - traceStartedAt), x: p.x, y: p.y }))
    .filter((p) => p.t >= 0)
    .sort((a, b) => a.t - b.t);
}

// Image refs arrive epoch-stamped; convert to the shared clock. Each is a
// pointer into the bundle's images/ dir — the agent (or viewer) reads the file
// only if it wants it. w/h are the captured frame size, for coordinate mapping.
export function imagesToTrack(images: readonly ImageRef[] | null | undefined, traceStartedAt: number): ImageRef[] {
  return (images || [])
    .map((im): ImageRef => ({
      t: Math.round(im.t - traceStartedAt),
      ref: im.ref,
      w: im.w,
      h: im.h,
      vw: im.vw, // viewport the frame was captured at (for mapping cursor x/y)
      vh: im.vh,
    }))
    .filter((im) => im.t >= 0)
    .sort((a, b) => a.t - b.t);
}

/**
 * Collapse Whisper segments into Track B utterances, offsetting to the shared
 * clock. `audioStartedAt` is the epoch ms when audio capture began (may differ
 * slightly from trace.started_at); `segments` are Whisper verbose_json
 * segments with start/end in seconds relative to the audio.
 */
export function segmentsToCognitive(
  segments: readonly WhisperSegment[] | null | undefined,
  audioStartedAt: number,
  traceStartedAt: number,
): Utterance[] {
  const offsetMs = audioStartedAt - traceStartedAt; // align audio to trace zero
  return (
    (segments || [])
      .map((s) =>
        makeUtterance({
          t: Math.round(s.start * 1000 + offsetMs),
          end: Math.round(s.end * 1000 + offsetMs),
          text: (s.text || "").trim(),
        }),
      )
      // Drop anything that lands entirely before the trace zero — that's the mic
      // warm-up window (offsetMs is negative), which carries no real narration.
      .filter((u) => u.end > 0)
      .map((u) => (u.t < 0 ? { ...u, t: 0 } : u))
  );
}
