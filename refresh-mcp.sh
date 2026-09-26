#!/usr/bin/env bash
# refresh-mcp.sh — make sure a test runs on the LATEST MCP server code.
#
# Scope: this only refreshes the MCP server processes (knob K5). It is the
# correct and sufficient refresh for any edit under host/ that is NOT in the
# extension (extension/* needs K2) or in install.sh (needs K4/K3). For the
# execute_code instruction work, K5 -> K6 is all that is needed.
#
#   K5 (this script)  kill the stale MCP servers + their wrangler/workerd kids
#   K6 (you)          reconnect: run `/mcp` in your session, OR just start the
#                     test in a fresh session — either way Claude Code respawns
#                     the server FROM DISK, picking up the new code.
#
# Usage:
#   ./refresh-mcp.sh            kill stale servers, then tell you to reconnect
#   ./refresh-mcp.sh --check    verify on-disk wiring + show what's running; no kill

set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="$REPO/host"
# scope every match to THIS repo so we never touch unrelated node/wrangler procs
SCOPE="$REPO/host"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }

# ---- 1. pre-flight: is the new instruction wiring actually on disk? ----
bold "pre-flight — instruction wiring on disk"
PASS=1
grep -q "export const SERVER_INSTRUCTIONS" "$HOST/codemode/common.ts" \
  && ok "common.ts exports SERVER_INSTRUCTIONS (L1 source)" \
  || { bad "common.ts missing SERVER_INSTRUCTIONS"; PASS=0; }
grep -q "instructions: SERVER_INSTRUCTIONS" "$HOST/codemode/server-hybrid.ts" \
  && ok "server-hybrid.ts wires instructions into the Server (L1)" \
  || { bad "server-hybrid.ts does not set instructions"; PASS=0; }
grep -q "instructions: SERVER_INSTRUCTIONS" "$HOST/codemode/server-codemode.ts" \
  && ok "server-codemode.ts wires instructions into the McpServer (L1)" \
  || { bad "server-codemode.ts does not set instructions"; PASS=0; }
grep -q "recognize a pattern, then batch it" "$HOST/codemode/common.ts" \
  && ok "common.ts carries the rewritten execute_code strategy (L4d)" \
  || { bad "common.ts missing the L4d rewrite"; PASS=0; }
# syntax sanity so a relaunch can't fail on a typo
for f in common.ts server-hybrid.ts server-codemode.ts; do
  node --check "$HOST/codemode/$f" 2>/dev/null \
    && ok "syntax OK: codemode/$f" \
    || { bad "SYNTAX ERROR: codemode/$f — fix before refreshing"; PASS=0; }
done
# The jev variant lives at the host root and pulls in host/jev/*; a typo in any
# of them only surfaces when the server is relaunched, which is exactly the
# thing this script exists to make safe.
for f in server-jev.ts jev/config.ts jev/client.ts jev/observe.ts jev/actions.ts \
         jev/shortlist.ts jev/trace.ts jev/navigator.ts jev/tools.ts; do
  node --check "$HOST/$f" 2>/dev/null \
    && ok "syntax OK: $f" \
    || { bad "SYNTAX ERROR: $f — fix before refreshing"; PASS=0; }
done
[ "$PASS" = 1 ] || { echo; bad "on-disk code is not ready; not killing anything."; exit 1; }

# ---- 2. what's running right now ----
echo
bold "running MCP servers (this repo)"
HY=$(pgrep -f "$SCOPE/codemode/server-hybrid\.[jt]s" | wc -l | tr -d ' ')
CM=$(pgrep -f "$SCOPE/codemode/server-codemode\.[jt]s" | wc -l | tr -d ' ')
DF=$(pgrep -f "$SCOPE/mcp-server\.[jt]s" | wc -l | tr -d ' ')
JV=$(pgrep -f "$SCOPE/server-jev\.[jt]s" | wc -l | tr -d ' ')
printf "  hybrid: %s   codemode: %s   default: %s   jev: %s\n" "$HY" "$CM" "$DF" "$JV"
TOTAL=$(( HY + CM + DF + JV ))
[ "$TOTAL" -gt 1 ] && printf "  \033[33m%s\033[0m\n" "note: $TOTAL servers alive — stale instances accumulate across sessions; this clears them."

if [ "${1:-}" = "--check" ]; then
  echo; bold "--check only — nothing killed. Run without --check to refresh."
  exit 0
fi

# ---- 3. K5: kill servers + their sandbox children, scoped to this repo ----
echo
bold "K5 — killing stale MCP servers + wrangler/workerd sandboxes"
# order: sandboxes first (children), then the servers (parents)
pkill -9 -f "$SCOPE/codemode/worker" 2>/dev/null && ok "killed wrangler/workerd under host/codemode/worker" || ok "no wrangler/workerd to kill"
pkill -9 -f "$SCOPE/codemode/server-hybrid\.[jt]s"   2>/dev/null && ok "killed server-hybrid.ts"   || ok "no server-hybrid.ts running"
pkill -9 -f "$SCOPE/codemode/server-codemode\.[jt]s" 2>/dev/null && ok "killed server-codemode.ts" || ok "no server-codemode.ts running"
pkill -9 -f "$SCOPE/mcp-server\.[jt]s"               2>/dev/null && ok "killed mcp-server.ts"       || ok "no default mcp-server.ts running"
pkill -9 -f "$SCOPE/server-jev\.[jt]s"              2>/dev/null && ok "killed server-jev.ts"      || ok "no server-jev.ts running"
sleep 1

# ---- 4. confirm clean ----
echo
bold "verify"
LEFT=$(pgrep -f "$SCOPE/codemode/server-hybrid\.[jt]s|$SCOPE/codemode/server-codemode\.[jt]s|$SCOPE/mcp-server\.[jt]s|$SCOPE/server-jev\.[jt]s" | wc -l | tr -d ' ')
if [ "$LEFT" = "0" ]; then
  ok "no MCP servers from this repo are running — next connect loads fresh code"
else
  bad "$LEFT server(s) still alive; re-run, or pkill -9 -f \"$SCOPE\""
fi

echo
bold "K6 — now reconnect (one of):"
echo "  • in your current session:  run  /mcp"
echo "  • or just start the test in a NEW session (it spawns a fresh server on its own)"
echo
echo "Either way the open-claude-in-chrome MCP relaunches from disk with the new"
echo "instructions + execute_code playbook. You are then on the latest version."
