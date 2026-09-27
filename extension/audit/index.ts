// Audit recording: an rrweb stream per tab, stitched into a per-Claude-session
// timeline so you can watch what one agent session actually did.
//
// Deliberately self-contained. It owns its own IndexedDB and its own on-disk
// bundle, touches no recorder state, and background.ts reaches it through five
// calls (`setEnabled`, `noteAction`, `onTabRemoved`, `ingest`, `read`). The
// recorder is expected to absorb this eventually; keeping the seam narrow is
// what makes that a merge rather than a rewrite.
//
// THE ONE STRUCTURAL CONSTRAINT: rrweb node ids are integers scoped to a single
// snapshot, so two tabs' event streams can never be concatenated — the ids
// would collide and both replays would corrupt. Streams therefore stay separate
// at the data layer, and a session is an ORDERED LIST OF SEGMENTS that point
// into them. "One recording" is a presentation-layer idea, not a storage one.

/** One rrweb event stream: a single document in a single tab. */
export interface AuditStream {
  streamId: string;
  tabId: number;
  startedAt: number;
  endedAt: number | null;
  endedReason?: string;
  url: string;
  title: string;
  seqCount: number;
  bytes: number;
  events: number;
  truncated: boolean;
  lastEventAt: number;
}

/** An rrweb event, as far as this code reads one. */
export type RrwebEvent = RrwebEventLike;

interface AuditChunk {
  streamId: string;
  seq: number;
  events: RrwebEvent[];
}

/** One agent action, as the timeline records it. */
export interface AuditAction {
  t: number;
  tool: string;
  action: string | null;
  tabId: number | null;
  streamId: string | null;
  detail: string | null;
}

/** Everything one Claude Code client did, until it went quiet. */
export interface AuditSession {
  sessionId: string;
  clientId: string;
  startedAt: number;
  lastActivityAt: number;
  actions: AuditAction[];
}

/** Consecutive actions on one stream: what the viewer scrubs through. */
export interface Segment<A = AuditAction> {
  streamId: string;
  tabId: number | null;
  tStart: number;
  tEnd: number;
  actions: A[];
}

/** The fields of an action that segmenting reads. */
type Placed = Pick<AuditAction, "t" | "tabId" | "streamId">;

export interface SessionSummary {
  sessionId: string;
  clientId: string;
  startedAt: number;
  lastActivityAt: number;
  actionCount: number;
  segmentCount: number;
  tabs: number;
  journey: string[];
  title: string;
  url: string;
}

/** A session with every event of every stream it touched. */
export interface SessionPayload {
  session: AuditSession;
  segments: Segment[];
  streams: Record<string, Omit<AuditStream, "events"> & { events: RrwebEvent[] }>;
}

interface StoreRows {
  streams: AuditStream;
  chunks: AuditChunk;
  sessions: AuditSession;
}
type StoreName = keyof StoreRows;

/** Sends one message to the native host; background.ts supplies it. */
export type PostToHost = (msg: Record<string, unknown>) => void;

const DB_NAME = "ocic-audit";
const DB_VERSION = 1;

// --- Policy -----------------------------------------------------------------
//
// A stream lives until its document goes away (tab closed or navigated). That
// is the cheap choice, not the lazy one: re-starting a stream costs a fresh
// full-DOM snapshot — by far the most expensive thing here — while an idle tab
// costs approximately nothing, because rrweb is event-driven and a page nobody
// is touching emits nothing.
//
// So the policy is tuned for the MEDIAN case (a page held open across a few
// minutes of agent work) rather than the worst case (an ad-heavy page mutating
// forever in the background). The two guards below exist only to stop the worst
// case running away, and are set permissively enough that normal work never
// reaches them.
const IDLE_STOP_MS = 30 * 60 * 1000; // no action against this tab for 30 min
const MAX_STREAM_BYTES = 40 * 1024 * 1024; // ~40MB of events, then stop appending
const SESSION_IDLE_MS = 30 * 60 * 1000; // a client quiet this long starts a new session

let enabled = false;
let dbPromise: Promise<IDBDatabase> | null = null;

// --- IndexedDB --------------------------------------------------------------
// The service worker and the options page share an extension origin, so the
// options page reads these stores directly rather than messaging the worker.
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("streams")) {
        db.createObjectStore("streams", { keyPath: "streamId" });
      }
      if (!db.objectStoreNames.contains("chunks")) {
        // Events are appended as chunks, never as one growing array: a
        // read-modify-write of a multi-megabyte event list on every flush
        // would be the thing that made recording expensive.
        db.createObjectStore("chunks", { keyPath: ["streamId", "seq"] });
      }
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "sessionId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db: IDBDatabase, stores: StoreName[], mode: IDBTransactionMode): IDBTransaction {
  return db.transaction(stores, mode);
}

function reqDone<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function put<S extends StoreName>(store: S, value: StoreRows[S]): Promise<void> {
  const db = await openDb();
  const t = tx(db, [store], "readwrite");
  await reqDone(t.objectStore(store).put(value));
}

async function get<S extends StoreName>(store: S, key: IDBValidKey): Promise<StoreRows[S] | undefined> {
  const db = await openDb();
  const t = tx(db, [store], "readonly");
  // Each store only ever holds the rows put() writes into it.
  return (await reqDone(t.objectStore(store).get(key))) as StoreRows[S] | undefined;
}

async function getAll<S extends StoreName>(store: S, query?: IDBKeyRange): Promise<Array<StoreRows[S]>> {
  const db = await openDb();
  const t = tx(db, [store], "readonly");
  return (await reqDone(t.objectStore(store).getAll(query))) as Array<StoreRows[S]>;
}

// --- Public: config ---------------------------------------------------------

export function setEnabled(on: unknown): void {
  enabled = !!on;
}

export function isEnabled(): boolean {
  return enabled;
}

// --- Streams ----------------------------------------------------------------

function newStreamId(tabId: number, t: number): string {
  return `s${tabId}_${t}`;
}

/**
 * Make sure the tab is recording, and return its streamId.
 *
 * Resilience matters more than elegance here. The service worker can be evicted
 * mid-session and a page can navigate out from under us, and in both cases the
 * in-memory view is wrong while the tab may or may not still be recording. So
 * the tab itself is the source of truth: ask it. A live recorder answers with
 * the streamId it already owns; anything else means start fresh.
 *
 * A navigation therefore produces a NEW stream rather than a gap in the old
 * one, which is correct — a new document needs its own snapshot, and pretending
 * otherwise would yield a replay that cannot be reconstructed.
 */
export async function ensureStream(tabId: number, opts: { maskInputs?: boolean } = {}): Promise<string | null> {
  if (!enabled) return null;
  try {
    const ping: TabMessage = { type: "audit_ping" };
    // inject.ts answers an audit_ping with the stream it owns, if any.
    const pong = (await chrome.tabs.sendMessage(tabId, ping).catch(() => null)) as { streamId?: string | null } | null;
    if (pong && pong.streamId) return pong.streamId;
  } catch {
    /* no listener yet — fall through and inject */
  }

  const startedAt = Date.now();
  const streamId = newStreamId(tabId, startedAt);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["vendor/rrweb.umd.min.js", "dist/audit/inject.js"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (sid: string, o: { maskInputs: boolean }) => window.__ocicAuditStart && window.__ocicAuditStart(sid, o),
      args: [streamId, { maskInputs: !!opts.maskInputs }],
    });
  } catch {
    // Restricted pages (chrome://, the Web Store) refuse injection. That is a
    // fact about the page, not a fault, so it is recorded and not thrown.
    return null;
  }

  let url = "";
  let title = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    url = tab.url || "";
    title = tab.title || "";
  } catch {}

  await put("streams", {
    streamId,
    tabId,
    startedAt,
    endedAt: null,
    url,
    title,
    seqCount: 0,
    bytes: 0,
    events: 0,
    truncated: false,
    lastEventAt: startedAt,
  });
  return streamId;
}

/** Append a batch of rrweb events from a tab. */
export async function ingest(
  msg: { streamId?: string; seq: number; events?: RrwebEvent[] } | null | undefined,
): Promise<void> {
  if (!msg || !msg.streamId || !Array.isArray(msg.events) || !msg.events.length) return;
  const meta = await get("streams", msg.streamId);
  if (!meta) return; // stream was reaped; drop rather than resurrect a partial
  if (meta.truncated) return;

  const bytes = JSON.stringify(msg.events).length;
  if (meta.bytes + bytes > MAX_STREAM_BYTES) {
    // Stop appending, and SAY SO. A silently truncated replay that just ends is
    // indistinguishable from a session that stopped there.
    meta.truncated = true;
    meta.endedAt = Date.now();
    await put("streams", meta);
    return;
  }

  await put("chunks", { streamId: msg.streamId, seq: msg.seq, events: msg.events });
  meta.seqCount = Math.max(meta.seqCount, msg.seq + 1);
  meta.bytes += bytes;
  meta.events += msg.events.length;
  meta.lastEventAt = Date.now();
  await put("streams", meta);
}

export async function onTabRemoved(tabId: number): Promise<void> {
  const streams = await getAll("streams");
  const now = Date.now();
  for (const s of streams) {
    if (s.tabId === tabId && !s.endedAt) {
      s.endedAt = now;
      await put("streams", s);
    }
  }
}

/** Permissive reaper: only ever closes streams nothing has touched in ages. */
export async function reapIdle(): Promise<void> {
  const now = Date.now();
  const streams = await getAll("streams");
  for (const s of streams) {
    if (s.endedAt) continue;
    if (now - (s.lastEventAt || s.startedAt) > IDLE_STOP_MS) {
      s.endedAt = now;
      s.endedReason = "idle";
      await put("streams", s);
      try {
        await chrome.scripting.executeScript({
          target: { tabId: s.tabId },
          func: () => window.__ocicAuditStop && window.__ocicAuditStop(),
        });
      } catch {}
    }
  }
}

// --- Sessions ---------------------------------------------------------------
//
// One session per Claude Code client. The host namespaces every request as
// `h{clientId}_{id}` (native-host.ts), and background.ts echoes that id back
// untouched, so the client is already identifiable with no protocol change.
// clientId is a counter that resets when the host restarts, so it is paired
// with a start timestamp to stay unique across restarts.

function newSessionId(clientId: string, t: number): string {
  return `c${clientId}_${t}`;
}

async function currentSession(clientId: string): Promise<AuditSession> {
  const all = await getAll("sessions");
  const mine = all.filter((s) => s.clientId === clientId).sort((a, b) => b.startedAt - a.startedAt);
  const live = mine[0];
  if (live && Date.now() - live.lastActivityAt < SESSION_IDLE_MS) return live;
  const startedAt = Date.now();
  const fresh: AuditSession = {
    sessionId: newSessionId(clientId, startedAt),
    clientId,
    startedAt,
    lastActivityAt: startedAt,
    actions: [],
  };
  await put("sessions", fresh);
  return fresh;
}

/**
 * Record one agent action and make sure its tab is recording.
 *
 * This is the join between the two halves: the action stream gives the timeline
 * its meaning (what the agent did, and when), the rrweb stream gives it pixels.
 */
export async function noteAction({
  clientId,
  tool,
  action,
  tabId,
  detail,
  postToHost,
}: {
  clientId: string | null;
  tool: string;
  action: unknown;
  tabId: unknown;
  detail: string | null;
  postToHost: PostToHost;
}): Promise<void> {
  if (!enabled || clientId == null) return;
  try {
    let streamId: string | null = null;
    if (typeof tabId === "number") streamId = await ensureStream(tabId);

    const session = await currentSession(clientId);
    session.actions.push({
      t: Date.now(),
      tool,
      action: typeof action === "string" && action ? action : null,
      tabId: typeof tabId === "number" ? tabId : null,
      streamId,
      detail: detail ? detail.slice(0, 200) : null,
    });
    session.lastActivityAt = Date.now();
    await put("sessions", session);
    scheduleCheckpoint(session.sessionId, postToHost);
  } catch {
    // Auditing must never be able to break the action it is auditing.
  }
}

// --- Checkpointing to disk --------------------------------------------------
//
// IndexedDB is what the options page reads, but it is not somewhere a person or
// an agent can look. Checkpointing the session to
// ~/.config/open-claude-in-chrome/audits/<sessionId>/audit.json makes an audit
// inspectable from outside the browser while its tabs are still open, and
// survives the profile being cleared.
//
// Debounced rather than written per action: a checkpoint serialises the whole
// event stream, so doing it on every click would make auditing cost more than
// the work being audited.
const CHECKPOINT_DEBOUNCE_MS = 5000;
const pendingCheckpoints = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleCheckpoint(sessionId: string, postToHost: PostToHost): void {
  if (pendingCheckpoints.has(sessionId)) return;
  const timer = setTimeout(() => {
    pendingCheckpoints.delete(sessionId);
    checkpoint(sessionId, postToHost).catch(() => {});
  }, CHECKPOINT_DEBOUNCE_MS);
  pendingCheckpoints.set(sessionId, timer);
}

export async function checkpoint(sessionId: string, postToHost: PostToHost | undefined): Promise<string | null> {
  if (typeof postToHost !== "function") return null;
  const payload = await readSession(sessionId);
  if (!payload) return null;
  postToHost({ type: "save_audit", session_id: sessionId, payload });
  return sessionId;
}

// --- Read side --------------------------------------------------------------

/**
 * Derive presentation segments: consecutive actions on the same tab collapse
 * into one segment. This is where "tab A, then tab B, then back to tab A"
 * becomes three segments over two streams — the division the viewer scrubs
 * through, without ever merging the underlying event streams.
 */
export function segmentsOf<A extends Placed>(session: { actions?: readonly A[] | undefined }): Array<Segment<A>> {
  const segs: Array<Segment<A>> = [];
  for (const a of session.actions || []) {
    if (!a.streamId) continue;
    const last = segs[segs.length - 1];
    if (last && last.streamId === a.streamId) {
      last.tEnd = a.t;
      last.actions.push(a);
    } else {
      segs.push({ streamId: a.streamId, tabId: a.tabId, tStart: a.t, tEnd: a.t, actions: [a] });
    }
  }
  return segs;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const sessions = await getAll("sessions");
  const streams = await getAll("streams");
  const byId = new Map(streams.map((s) => [s.streamId, s]));
  return sessions
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((s) => {
      const segs = segmentsOf(s);
      // The sequence of sites a session moved through. A page title is a poor
      // identity — several captures of one page all read the same — while the
      // journey is what a reviewer actually recognises a session by.
      const journey: string[] = [];
      for (const seg of segs) {
        const st = byId.get(seg.streamId);
        let site = `tab ${seg.tabId}`;
        try {
          if (st && st.url) site = new URL(st.url).host || site;
        } catch {}
        if (journey[journey.length - 1] !== site) journey.push(site);
      }
      return {
        sessionId: s.sessionId,
        clientId: s.clientId,
        startedAt: s.startedAt,
        lastActivityAt: s.lastActivityAt,
        actionCount: (s.actions || []).length,
        segmentCount: segs.length,
        tabs: new Set(segs.map((x) => x.tabId)).size,
        journey,
        title: segs.map((x) => byId.get(x.streamId)?.title).find(Boolean) || "(untitled)",
        url: segs.map((x) => byId.get(x.streamId)?.url).find(Boolean) || "",
      };
    });
}

/** Full session payload including events, for the viewer or a disk bundle. */
export async function readSession(sessionId: string): Promise<SessionPayload | null> {
  const session = await get("sessions", sessionId);
  if (!session) return null;
  const segs = segmentsOf(session);
  const streamIds = [...new Set(segs.map((s) => s.streamId))];
  const streams: SessionPayload["streams"] = {};
  for (const sid of streamIds) {
    const meta = await get("streams", sid);
    if (!meta) continue;
    const db = await openDb();
    const t = tx(db, ["chunks"], "readonly");
    const range = IDBKeyRange.bound([sid, -Infinity], [sid, Infinity]);
    const chunks = (await reqDone(t.objectStore("chunks").getAll(range))) as AuditChunk[];
    chunks.sort((a, b) => a.seq - b.seq);
    streams[sid] = { ...meta, events: chunks.flatMap((c) => c.events) };
  }
  return { session, segments: segs, streams };
}

export async function deleteSession(sessionId: string): Promise<void> {
  const payload = await readSession(sessionId);
  const db = await openDb();
  if (payload) {
    for (const sid of Object.keys(payload.streams)) {
      const t = tx(db, ["chunks", "streams"], "readwrite");
      const range = IDBKeyRange.bound([sid, -Infinity], [sid, Infinity]);
      await reqDone(t.objectStore("chunks").delete(range));
      await reqDone(t.objectStore("streams").delete(sid));
    }
  }
  const t2 = tx(db, ["sessions"], "readwrite");
  await reqDone(t2.objectStore("sessions").delete(sessionId));
}
