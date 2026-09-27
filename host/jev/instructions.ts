// Sent once at connect, ahead of any tool description. Claude Code keeps only
// the first ~2048 characters of a server's instructions and drops the rest, so
// this is the routing layer only: what Jev is, which tool fits which job, and
// the one pattern that changes run time the most. How to write each call lives
// in the jev-browser skill (skills/jev-browser) and in the tool descriptions.
//
// The audited session that first prompted this text made one jev_navigate call
// and about forty ordinary ones: when Jev handed back, Claude finished by hand.
// Hence "call again, don't finish by hand" stays in the part Claude sees.
export const INSTRUCTIONS = `This server drives the user's real Chrome with Jev, a fast, cheap decision model that clicks, types and answers your questions with probabilities. It never writes text or invents a value: you plan and supply every piece of text, Jev does the mechanical work. If the jev-browser skill is available, load it before the first Jev call.

Start with tabs_context_mcp (tabs_create_mcp for a fresh tab) to get a tabId.

- Doing things: jev_navigate, the whole task in one call (every leg in \`subgoals\`, all text in \`values\`). When it hands back, fix what \`reason\` names and call again with \`remaining_subgoals\`; don't finish by hand.
- Judging many items (listings, results, profiles): jev_assess, never one page at a time. Its \`items_script\` can fetch() every page with the user's session and return \`text\` items, judged in parallel: hundreds in seconds.
- Single steps: the ordinary tools, by \`ref\`, not screenshot coordinates.`;

/** Claude Code truncates server instructions past this many characters. */
export const INSTRUCTIONS_LIMIT = 2048;
