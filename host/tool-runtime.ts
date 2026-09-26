// Shared runtime for open-claude-in-chrome tools.
//
// Joins the browser bridge as a client and exposes a single
// `callTool(name, args)` entry point. The bridge is owned by the native host,
// which Chrome starts and stops with the extension, so this process never has
// to own anything, elect anything, or care who else is attached.
//
// It used to be far more than this: every consumer raced to bind a TCP port,
// and the winner multiplexed all the others through itself. That made an
// ordinary Claude Code session load-bearing for the whole machine. All of it —
// the election, the yield protocol, the peer-classification sniff, the
// self-promotion path, the pidfile — existed to manage a role nobody should
// have had, and went away with it.
//
// This used to live inline in mcp-server.ts; it's extracted so that other
// in-process consumers (the codemode + hybrid servers) can call tools
// without going through a child mcp-server.ts + stdio MCP roundtrip.

import net from "node:net";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { getPipePath } from "./endpoint.ts";
import { errorMessage } from "./errors.ts";
import { noteActivity } from "./parent-watch.ts";

/** Arguments to a browser tool, as they come off the MCP wire. */
export type ToolArgs = Record<string, unknown>;

/** A line on the bridge, in either direction. */
export interface BridgeMessage {
  type?: string;
  id?: string;
  result?: unknown;
  error?: string;
  [key: string]: unknown;
}

export type RecordingEventListener = (msg: BridgeMessage) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  sent: boolean;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return !!value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content);
}

const PIPE_PATH = getPipePath();

const REQUEST_TIMEOUT_MS = 60_000;
// javascript_tool may ask the extension for up to 120s of evaluation; the host
// waits that long plus slack so the extension's own timeout is the one reported.
const JS_MAX_TIMEOUT_MS = 120_000;
export function requestTimeoutMs(tool: string, args?: ToolArgs | null): number {
  if (tool !== "javascript_tool" || !args?.["timeout_ms"]) return REQUEST_TIMEOUT_MS;
  const ms = Math.min(Number(args["timeout_ms"]) || 0, JS_MAX_TIMEOUT_MS);
  return Math.max(REQUEST_TIMEOUT_MS, ms + 10_000);
}
// The host dies and respawns whenever Chrome recycles the service worker, and
// background.ts reconnects 250ms later. A call landing in that window should
// wait for the bridge to come back rather than fail.
const LINK_GRACE_MS = 5_000;
const RECONNECT_MS = 500;

let started = false;
let socket: net.Socket | null = null;
let readBuffer = Buffer.alloc(0);
let reconnectTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;
let requestIdCounter = 0;

const pendingRequests = new Map<string, PendingRequest>();

// Returned when the bridge drops with a request still in flight. Deliberately
// does NOT claim the action failed: the request may have reached the browser
// and run, with only the response lost. The wording has to leave the agent able
// to act — verify, then decide — rather than blindly retry.
const HOST_DROPPED_ERROR =
  "Browser connection dropped after the request was sent, so its result is unknown. " +
  "The action may have ALREADY taken effect in the browser. Do not blindly retry: " +
  "check the current page state first (e.g. take a screenshot or read the page), " +
  "then repeat the action only if it did not happen.";

const NO_BRIDGE_ERROR =
  "Browser extension is not connected. Make sure a supported Chromium browser " +
  "is running with the Open Claude in Chrome extension installed and enabled.";

// Unsolicited upstream events from the extension (not tool responses): the
// imitation-learning recorder posts { type: "recording_complete", ... } when
// a recording finishes. Subscribers (the channel-enabled MCP server) get
// notified so they can inject a channel event into the Claude Code session.
const recordingEventSubscribers = new Set<RecordingEventListener>();
export function onRecordingEvent(cb: RecordingEventListener): () => boolean {
  recordingEventSubscribers.add(cb);
  return () => recordingEventSubscribers.delete(cb);
}
function emitRecordingEvent(msg: BridgeMessage): void {
  for (const cb of recordingEventSubscribers) {
    try {
      cb(msg);
    } catch {}
  }
}

const linkIsUp = (): boolean => !!socket && !socket.destroyed && socket.readyState === "open";

// Wait for the bridge to come back, for callers that arrived while the host was
// being respawned.
function waitForLink(maxMs: number): Promise<boolean> {
  if (linkIsUp()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (linkIsUp()) {
        clearInterval(poll);
        resolve(true);
      } else if (Date.now() - startedAt >= maxMs) {
        clearInterval(poll);
        resolve(false);
      }
    }, 100);
  });
}

function handleMessage(msg: BridgeMessage): void {
  if (msg.type === "client_ack") return;
  if (msg.type === "recording_complete") {
    emitRecordingEvent(msg);
    return;
  }
  const pending = msg.id ? pendingRequests.get(msg.id) : undefined;
  if (msg.id && pending) {
    const { resolve, reject, timer } = pending;
    clearTimeout(timer);
    pendingRequests.delete(msg.id);
    if (msg.type === "tool_error") {
      reject(new Error(msg.error || "Tool execution failed"));
    } else {
      resolve(msg.result);
    }
  }
}

function connect(): void {
  if (shuttingDown) return;
  reconnectTimer = null;

  const sock = net.createConnection(PIPE_PATH);
  socket = sock;
  readBuffer = Buffer.alloc(0);
  let established = false;

  sock.on("connect", () => {
    established = true;
    sock.write(JSON.stringify({ type: "client_hello" }) + "\n");
    process.stderr.write(`Joined the browser bridge at ${PIPE_PATH}\n`);
  });

  sock.on("data", (chunk) => {
    readBuffer = Buffer.concat([readBuffer, chunk]);
    let idx;
    while ((idx = readBuffer.indexOf(10)) !== -1) {
      const line = readBuffer.subarray(0, idx).toString("utf-8").trim();
      readBuffer = readBuffer.subarray(idx + 1);
      if (!line) continue;
      try {
        handleMessage(JSON.parse(line) as BridgeMessage);
      } catch {
        // skip malformed
      }
    }
  });

  // Nothing to report for a connect that simply found no host: that is the
  // ordinary state when the browser is not running, and the close handler
  // schedules the retry.
  sock.on("error", (err) => {
    if (established) process.stderr.write(`Bridge error: ${err.message}\n`);
  });

  sock.on("close", () => {
    if (socket === sock) socket = null;
    failPending();
    if (!shuttingDown && !reconnectTimer) {
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
    }
  });
}

// Settle everything in flight when the link drops.
//
// A request that was actually written may have reached the browser and run,
// with only its response lost — replaying it would silently double-execute the
// action (a click clicks twice) while the agent sees one successful call. There
// is no way to tell "never ran" from "ran, response lost" at this layer, so
// those fail loudly and let the agent decide with page context. A request still
// waiting for the link never went anywhere, so it can say so plainly.
function failPending(): void {
  if (pendingRequests.size === 0) return;
  for (const [, entry] of pendingRequests) {
    clearTimeout(entry.timer);
    entry.reject(new Error(entry.sent ? HOST_DROPPED_ERROR : NO_BRIDGE_ERROR));
  }
  pendingRequests.clear();
}

function sendToExtension(tool: string, args: ToolArgs): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = String(++requestIdCounter);
    const waitMs = requestTimeoutMs(tool, args);
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Tool request timed out after ${Math.round(waitMs / 1000)}s`));
    }, waitMs);
    const entry: PendingRequest = { resolve, reject, timer, sent: false };
    pendingRequests.set(id, entry);

    const line = JSON.stringify({ id, type: "tool_request", tool, args }) + "\n";

    if (linkIsUp()) {
      entry.sent = true;
      socket?.write(line);
      return;
    }

    void waitForLink(LINK_GRACE_MS).then((ok) => {
      // Only dispatch if still pending: the entry is gone once the promise has
      // settled some other way, and sending then would run an action nobody is
      // waiting on.
      if (!pendingRequests.has(id)) return;
      if (ok && linkIsUp()) {
        entry.sent = true;
        socket?.write(line);
        return;
      }
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(new Error(NO_BRIDGE_ERROR));
    });
  });
}

// --- Public API ---

/**
 * Join the browser bridge. Returns as soon as the first connection attempt has
 * been made — deliberately not once it succeeds, because the MCP server has to
 * come up and advertise its tools whether or not a browser is running. Calls
 * made before the bridge is up get the grace period in sendToExtension.
 */
export async function init(): Promise<void> {
  if (started) return;
  started = true;
  connect();
}

/**
 * Coerce stringified params that some MCP clients send as strings into
 * the types the extension expects (numbers, arrays). Mutates and
 * returns args.
 */
export function coerceArgs<T>(args: T): T {
  if (!args || typeof args !== "object") return args;
  const a = args as ToolArgs;
  if (typeof a["tabId"] === "string") a["tabId"] = Number(a["tabId"]);
  for (const key of ["coordinate", "start_coordinate", "region"]) {
    const value = a[key];
    if (typeof value !== "string") continue;
    try {
      a[key] = JSON.parse(value);
    } catch {}
  }
  return args;
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Call a tool on the extension. Returns an MCP CallToolResult envelope
 * (with text/image/etc. content blocks).
 *
 * Args are coerced (string→number/array) before the call so this is
 * safe to invoke directly with values straight off the MCP wire.
 */
export async function callTool(toolName: string, args?: ToolArgs | null): Promise<CallToolResult> {
  noteActivity();
  try {
    const coerced = coerceArgs(args ?? {});
    const result = await sendToExtension(toolName, coerced);
    if (typeof result === "string") return textResult(result);
    if (isCallToolResult(result)) return result;
    return textResult(JSON.stringify(result, null, 2));
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`);
  }
}

/**
 * Tear down the connection and pending requests. Idempotent.
 * The caller (process owner) handles process.exit().
 */
export function shutdown(): void {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  for (const [, { reject, timer }] of pendingRequests) {
    clearTimeout(timer);
    reject(new Error("Server shutting down"));
  }
  pendingRequests.clear();
  if (socket && !socket.destroyed) socket.destroy();
  socket = null;
}
