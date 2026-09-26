// The message protocol between the service worker and the offscreen document.
//
// Every request carries `__ocic_offscreen: true` and a `cmd`; the offscreen
// document answers each one. It answers ANY command with { ok: false, error }
// when the handler throws, and chrome.runtime.sendMessage resolves undefined
// when no offscreen document is alive, so callers see those too.

import type { BehaviorInput, CursorPoint, SegmentStatus, Trace, Utterance } from "./schema.ts";

export type { SegmentStatus };

/** Where one audio segment starts on the wall clock. */
export interface SegmentAnchor {
  index: number;
  startEpoch: number;
}

/** A 240p frame kept for the viewer, epoch-stamped in the store. */
export interface ImageRow {
  t: number;
  ref: string;
  dataUrl: string;
  w: number;
  h: number;
  vw?: number | undefined;
  vh?: number | undefined;
}

/** The record the Options viewer lists, in the recorder's IndexedDB. */
export interface SessionRecord {
  recording_id: string;
  started_at: number;
  ended_at: number | null;
  url0: string | null;
  events: number;
  utterances: number;
  transcriptStatus: string;
  segEpochs: SegmentAnchor[];
  trace: Trace;
  audio: Blob;
  /** Frames on the shared clock (ms since started_at). */
  images: ImageRow[];
  path?: string;
}

export interface Failed {
  ok: false;
  error: string;
}

/** What stop hands the service worker: the trace, and where the audio is. */
export interface RecordingBundle {
  recording_id: string;
  schema: string;
  trace: Trace;
  audioSegments?: Array<{ index: number; size: number; name: string }>;
  summary?: string;
  transcriptStatus?: string;
}

export interface TranscribeResult {
  ok: true;
  cognitive: Utterance[];
  transcript_status: string;
  transcript_segments: SegmentStatus[] | undefined;
  summary: string;
}

/** A behavior event as it travels to the offscreen buffer (epoch-stamped). */
export type BufferedEvent = BehaviorInput & Record<string, unknown>;

export interface OffscreenCommands {
  probe_key: { req: { apiKey: string }; res: { ok: true } | Failed };
  start: {
    req: { recording_id: string; started_at: number; apiKey: string; url0: string | null };
    res: { ok: true } | Failed | { ok: false; already: true; session: { recording_id: string; started_at: number } };
  };
  event: { req: { event: BufferedEvent }; res: void };
  cursor: { req: { points: CursorPoint[] }; res: void };
  image: {
    req: { t: number; ref: string; vw: number; vh: number; dataUrl: string };
    res: { ok: false } | { ok: true; dataUrl: string; w: number; h: number };
  };
  stop: { req: object; res: Failed | { ok: true; bundle: RecordingBundle } };
  audio_slice: { req: { index: number; start: number; len: number }; res: { ok: true; b64: string } | Failed };
  transcribe: { req: object; res: TranscribeResult | Failed };
  retranscribe: {
    req: { recording_id: string; apiKey: string };
    res: (Omit<TranscribeResult, "summary"> & { recording_id: string; trace: Trace; summary: string }) | Failed;
  };
  copy: { req: { text: string }; res: { ok: boolean; error?: string } };
  set_path: { req: { recording_id: string; path: string }; res: { ok: true } };
}

export type OffscreenCmd = keyof OffscreenCommands;

export type OffscreenRequest<K extends OffscreenCmd> = { __ocic_offscreen: true; cmd: K } & OffscreenCommands[K]["req"];

/** Any request the offscreen document handles, discriminated on `cmd`. */
export type OffscreenMessage = { [K in OffscreenCmd]: OffscreenRequest<K> }[OffscreenCmd];

export type OffscreenResponse<K extends OffscreenCmd> = OffscreenCommands[K]["res"] | Failed | undefined;

/** Send one command to the offscreen document and wait for its answer. */
export function sendToOffscreen<K extends OffscreenCmd>(msg: OffscreenRequest<K>): Promise<OffscreenResponse<K>> {
  // The offscreen document's listener (offscreen.ts) is the only party that
  // answers these, and it answers with exactly the shapes declared above.
  return chrome.runtime.sendMessage(msg) as Promise<OffscreenResponse<K>>;
}
