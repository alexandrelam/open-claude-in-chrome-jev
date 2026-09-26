#!/usr/bin/env node

// MCP server variant: the ordinary tool catalog plus a Jev decision layer.
//
// Same process lifecycle as host/mcp-server.js, and the same in-process
// callTool — the navigator loop runs several browser calls per step, so the
// extra stdio hop a child mcp-server.js would add is the one cost worth
// avoiding here.
//
// Degradation follows execute_code in codemode/server-hybrid.js: stdio comes up
// first and the passthrough tools work immediately; the Jev tools are always
// advertised and fail individually with an actionable message when there is no
// API key. A missing key must never stop the browser tools from working.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { init, callTool, shutdown, coerceArgs } from "./tool-runtime.js";
import { TOOLS } from "./tool-definitions.js";
import { watchParent } from "./parent-watch.js";

import { JEV_TOOLS } from "./jev/tools.js";
import { resolveConfig, configError } from "./jev/config.js";
import { createClient } from "./jev/client.js";
import { navigate, decideOnce } from "./jev/navigator.js";
import { assess } from "./jev/assess.js";

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

// Sent once at connect, ahead of any tool description. The audited session
// that prompted this made one jev_navigate call and about forty ordinary ones:
// when Jev handed back, Claude finished the form and the verification by hand,
// although the tool description said to call again. Stated here, up front.
const INSTRUCTIONS = `This server drives the user's real Chrome. Besides the ordinary browser tools it has Jev, a fast, cheap decision model: it picks each next click or keystroke, and answers your questions with probabilities. It never writes text and never invents a value, so the split is: you plan, supply every piece of text, and state your rules; Jev does the mechanical clicking and the per-page judging. Each of your turns costs far more time than a Jev run, so put as much as you can into each call.

Start with tabs_context_mcp (and tabs_create_mcp for a fresh tab) to get a tabId.

## Doing things: jev_navigate
- Plan the whole task as ONE call. Put every navigation and form leg in \`subgoals\`, every piece of text to type in \`values\`, and \`start_url\` for where to begin. Set \`fill_defaults: true\` when any option will do for a form's choice fields (test data), and \`allow_sensitive: true\` when the task includes a save, submit, send or delete the user asked for. Put the verification you would otherwise do with screenshots in \`questions\` (see below). Add \`final_check\` when a later leg could undo an earlier one.
- Legs you can't see yet: describe the outcome ("fill the form and save it") rather than guessing at field names. Jev reads the page.
- Success criteria: name where you are, not page content. When the app puts state in the URL, write it as key=value ("newEncounterProfile=true in the URL"), which is checked exactly.
- When it hands back, stay in Jev:
  - needs_help / blocked: read \`reason\` and \`blockers\` (e.g. Save is disabled, and these fields are empty). Call again with fix-up legs followed by \`remaining_subgoals\`.
  - needs_value: add the missing text to \`values\`, then call again.
  - limit_reached: raise \`max_ms\`/\`max_steps\`, or split the task.
  - partial: the optional legs listed in \`reason\` were skipped.
- Only take a step yourself when Jev truly can't, and do it by \`ref\` from \`page_excerpt.interactive\`, never by screenshot coordinates. Then go back to jev_navigate.

## Judging things: questions and jev_assess
You can hand Jev your judgement as questions. It answers each one with a probability over the options you defined, never with prose.
- On one page, after acting: \`questions\` on jev_navigate, answered on the page the run ends on, under \`answers\`. E.g. {key: "disabled", type: "yes_no", question: "Is the 'Enable this template' switch off?"}.
- On many items: jev_assess. Use it whenever you would otherwise open or read items one by one to compare or filter them: listings, search results, profiles, table rows, candidates. Each item is a \`url\` to open, \`text\` you already hold, or a \`goal\` to navigate first (the jev_navigate loop), and every question is asked of every item. You get a summary per question, plus one row per item with its answers and a short excerpt.
- When the items come from a page (the ads on a results page, the sellers behind them), don't extract them first: pass \`items_script\`, a script whose last expression is the array of items, and extraction and judging happen in one call.
- Put what a page can't know in \`context\`: today's reference price, the user's criteria, what counts as good. Jev applies it to every item. Facts about one item go in that item's \`context\`.
- Writing questions: types are yes_no, choice (at least 2 \`options\`) and score (an ordered \`scale\`). Jev sees nothing of your intent beyond the question, so state it fully, ask one fact per question, and for yes_no say what counts as yes and no in \`yes\`/\`no\`. Keys are short identifiers (not "verified", "model", "usage" or "id").
- Reading answers: a yes_no answer near 0.5, or a choice with a close \`runner_up\`, is doubt. Check those items yourself; trust the clear ones.
- Questions can't extract text. For a value you need to reuse (an ID, a price, a name), read it with get_page_text or read_page.

## Other tools
- jev_decide: asks what Jev would do next, without doing it. Use it to sanity-check a new site before a long run.
- computer, find, read_page, form_input and the rest are for single steps. Prefer \`ref\` over coordinates. Screenshot coordinates are in the image's own pixels.`;

const server = new McpServer(
  {
    name: "open-claude-in-chrome-jev",
    version: "1.0.0"
  },
  { instructions: INSTRUCTIONS }
);

// Coerce stringified args (tabId, coordinate, etc.) before zod validation
// runs on tool-call requests. Some MCP clients serialize numbers/arrays
// as strings; the extension expects the real types.
{
  const origSetRequestHandler = server.server.setRequestHandler.bind(
    server.server
  );
  server.server.setRequestHandler = function (schema, handler) {
    return origSetRequestHandler(schema, async (request, extra) => {
      if (request?.params?.arguments) coerceArgs(request.params.arguments);
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
      if (!name.endsWith(".js")) continue;
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

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

// Both Jev tools return JSON. structuredContent carries the machine-readable
// copy for clients that support it; the text block is what Claude actually
// reads, so it has to stand alone.
function jsonResult(value) {
  return {
    content: [{ type: "text", text: stalenessWarning() + JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

async function runJevTool(name, args) {
  if (cfgError) return errorResult(`Jev tools unavailable: ${cfgError}`);
  // A client per call, so the budget in JEV_BUDGET_USD bounds one tool call
  // rather than the lifetime of the server.
  const client = createClient(cfg);
  try {
    const out =
      name === "jev_navigate"
        ? await navigate(callTool, client, cfg, args)
        : name === "jev_assess"
          ? await assess(callTool, client, cfg, args)
          : await decideOnce(callTool, client, cfg, args);
    return jsonResult(out);
  } catch (err) {
    return errorResult(
      `${name} failed: ${err?.message ?? err}\nSpent so far: $${client.totals.cost_usd}.`
    );
  }
}

for (const t of TOOLS) {
  server.tool(t.name, t.description, t.paramShape, async (args) =>
    callTool(t.name, args)
  );
}

for (const t of JEV_TOOLS) {
  server.tool(t.name, t.description, t.paramShape, async (args) =>
    runJevTool(t.name, args)
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
