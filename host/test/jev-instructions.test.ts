#!/usr/bin/env node
//
// The server instructions must fit in what Claude Code keeps. Past the limit it
// silently drops the tail, which is how the whole jev_assess section once went
// unseen. Keep the tools each bullet names in view too, so a rename here fails.
//
// Run: node host/test/jev-instructions.test.ts

import { INSTRUCTIONS, INSTRUCTIONS_LIMIT } from "../jev/instructions.ts";
import { JEV_TOOL_NAMES } from "../jev/tools.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}

check(
  "instructions fit under the truncation limit, with room to spare",
  INSTRUCTIONS.length <= INSTRUCTIONS_LIMIT - 200,
  `${INSTRUCTIONS.length} chars, limit ${INSTRUCTIONS_LIMIT}`,
);
for (const name of ["jev_navigate", "jev_assess"]) {
  check(`names ${name}, a real tool`, INSTRUCTIONS.includes(name) && JEV_TOOL_NAMES.has(name), name);
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
