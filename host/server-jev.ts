#!/usr/bin/env node

// MCP server variant: the ordinary tool catalog plus a Jev decision layer.
//
// Same process lifecycle as host/mcp-server.ts, and the same in-process
// callTool — the navigator loop runs several browser calls per step, so the
// extra stdio hop a child mcp-server.ts would add is the one cost worth
// avoiding here.
//
// Degradation follows execute_code in codemode/server-hybrid.ts: stdio comes up
// first and the passthrough tools work immediately; the Jev tools are always
// advertised and fail individually with an actionable message when there is no
// API key. A missing key must never stop the browser tools from working.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { init, callTool, shutdown, coerceArgs } from "./tool-runtime.ts";
import { TOOLS } from "./tool-definitions.ts";
import { watchParent } from "./parent-watch.ts";

import { JEV_TOOLS } from "./jev/tools.ts";
import { resolveConfig, configError } from "./jev/config.ts";
import { createClient } from "./jev/client.ts";
import { navigate, decideOnce } from "./jev/navigator.ts";
import { assess } from "./jev/assess.ts";
import { INSTRUCTIONS } from "./jev/instructions.ts";
import type { AssessArgs, DecideArgs, NavigateArgs } from "./jev/tools.ts";
import { errorMessage } from "./errors.ts";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function exitClean(code = 0) {
  try {
    shutdown();
  } catch {}
  process.exit(code);
}

process.on("SIGTERM", () => exitClean());
process.on("SIGINT", () => exitClean());
process.on("SIGHUP", () => exitClean());
process.stdin.on("end", () => exitClean());
process.stdin.resume();

// stdin EOF is the fast path, but it only arrives if nobody else holds a copy
// of the write end. Watching the parent directly is the backstop that does not
// depend on the pipe — without it these processes accumulate indefinitely.
watchParent(() => exitClean());

await init();

const cfg = resolveConfig();
const cfgError = configError(cfg);
if (cfgError) process.stderr.write(`[jev] ${cfgError}\n`);

const server = new McpServer(
  {
    name: "open-claude-in-chrome-jev",
    version: "1.0.0",
  },
  { instructions: INSTRUCTIONS },
);

// Coerce stringified args (tabId, coordinate, etc.) before zod validation
// runs on tool-call requests. Some MCP clients serialize numbers/arrays
// as strings; the extension expects the real types.
{
  const origSetRequestHandler = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = function (schema, handler) {
    return origSetRequestHandler(schema, async (request, extra) => {
      // The SDK types the request by `schema`; only tool calls carry arguments.
      const params = (request as { params?: { arguments?: unknown } } | undefined)?.params;
      if (params?.arguments) coerceArgs(params.arguments);
      return handler(request, extra);
    });
  };
}

// Warn when the running process is older than the code on disk.
//
// MCP servers are long-lived, and the tool schema is sent once at connect time.
// An audited run silently lacked the `subgoals` parameter for half an hour
// because the server had started before it was written — the code was on disk,
// the client just never saw it, and nothing said so. A file newer than this
// process means the schema in the client's hands is stale.
const STARTED_AT = Date.now();
const WATCHED = path.join(path.dirname(fileURLToPath(import.meta.url)), "jev");

function stalenessWarning() {
  try {
    let newest = 0;
    for (const name of fs.readdirSync(WATCHED)) {
      if (!name.endsWith(".ts")) continue;
      newest = Math.max(newest, fs.statSync(path.join(WATCHED, name)).mtimeMs);
    }
    const self = fs.statSync(fileURLToPath(import.meta.url)).mtimeMs;
    newest = Math.max(newest, self);
    if (newest > STARTED_AT) {
      return `NOTE: this server started ${new Date(STARTED_AT).toISOString()} but host/jev was modified since. The tool definitions you were given may be out of date — restart the MCP server (./refresh-mcp.sh, then /mcp) to pick up new parameters.\n\n`;
    }
  } catch {}
  return "";
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// Both Jev tools return JSON. structuredContent carries the machine-readable
// copy for clients that support it; the text block is what Claude actually
// reads, so it has to stand alone.
function jsonResult(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: stalenessWarning() + JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

async function runJevTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (cfgError) return errorResult(`Jev tools unavailable: ${cfgError}`);
  // A client per call, so the budget in JEV_BUDGET_USD bounds one tool call
  // rather than the lifetime of the server.
  const client = createClient(cfg);
  try {
    const out =
      name === "jev_navigate"
        ? await navigate(callTool, client, cfg, args as NavigateArgs)
        : name === "jev_assess"
          ? await assess(callTool, client, cfg, args as AssessArgs)
          : await decideOnce(callTool, client, cfg, args as DecideArgs);
    return jsonResult({ ...out });
  } catch (err) {
    return errorResult(`${name} failed: ${errorMessage(err)}\nSpent so far: $${client.totals.cost_usd}.`);
  }
}

for (const t of TOOLS) {
  server.tool(t.name, t.description, t.paramShape, async (args) => callTool(t.name, args));
}

for (const t of JEV_TOOLS) {
  server.tool(t.name, t.description, t.paramShape, async (args) => runJevTool(t.name, args));
}

const transport = new StdioServerTransport();
await server.connect(transport);
