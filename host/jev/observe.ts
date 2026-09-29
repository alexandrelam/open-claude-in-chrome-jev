// Turn a read_page("interactive") dump into typed rows Jev can choose between.
//
// The grammar comes from generateAccessibilityTree() in extension/content.ts
// (L207-231). Reproduced here because the parser has to match it exactly:
//
//   <indent><role> "<name, <=100 chars>" [ref_N] [href=".."] [src=".."]
//           [value=".."] [type=".."] [expanded=..] [checked=..] [selected=..]
//           [disabled] [required] [readonly] [section=".."] [options=[*v="text",  v2="text2"]]
//
// Three properties of that renderer make the naive split-on-spaces parser wrong:
//
//   1. `role` is emitted only `if (role)`, so it can be absent — the line then
//      opens with the indent followed straight by the quote.
//   2. `name` is emitted only `if (name)`, so it can be absent too. `[ref_N]`
//      is the single field guaranteed to be on every line.
//   3. The indent only grows for ancestors that were themselves shown AND
//      visible, so indentation is not DOM depth and must not be read as
//      structure. It is kept only as a grouping hint for shortlisting.

import type {
  CallTool,
  Flag,
  Observation,
  ObservationResult,
  PageRegion,
  Row,
  RowOption,
  ScrollState,
  ToolResult,
} from "./types.ts";

// A name or an href can legitimately contain "[ref_3]" (a URL with a fragment,
// a label quoting one). Pick the ref token that sits outside the quoted name by
// requiring an even number of quotes before it.
function findRefToken(line: string): { ref: string; start: number; end: number } | null {
  const re = /\[(ref_\d+)\]/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const before = line.slice(0, m.index);
    const quotes = (before.match(/"/g) || []).length;
    if (quotes % 2 === 0) return { ref: m[1] ?? "", start: m.index, end: m.index + m[0].length };
  }
  return null;
}

function parseOptions(raw: string): RowOption[] {
  // `${selected ? "*" : " "}${value}="${text}"`, joined with ", ".
  const out: RowOption[] = [];
  const re = /([*\s]?)([^=,]*)="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    out.push({
      value: (m[2] ?? "").trim(),
      label: m[3] ?? "",
      selected: m[1] === "*",
    });
  }
  return out;
}

interface Attrs {
  disabled: boolean;
  required: boolean;
  readonly: boolean;
  options: RowOption[] | null;
  /** Every key=value pair: quoted values as text, bare true/false as booleans. */
  fields: Record<string, string | boolean>;
}

function parseAttrs(tail: string): Attrs {
  const attrs: Attrs = { disabled: false, required: false, readonly: false, options: null, fields: {} };

  // options=[...] is appended last, so everything from its marker to the end of
  // the line belongs to it — and its contents hold both commas and quotes, so
  // it must come off before any generic key=value scanning.
  const optIdx = tail.indexOf("options=[");
  let rest = tail;
  if (optIdx !== -1) {
    const inner = tail.slice(optIdx + "options=[".length).replace(/\]\s*$/, "");
    attrs.options = parseOptions(inner);
    rest = tail.slice(0, optIdx);
  }

  if (/(^|\s)disabled(\s|$)/.test(rest)) attrs.disabled = true;
  if (/(^|\s)required(\s|$)/.test(rest)) attrs.required = true;
  if (/(^|\s)readonly(\s|$)/.test(rest)) attrs.readonly = true;

  const quoted = /(\w+)="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = quoted.exec(rest)) !== null) attrs.fields[m[1] ?? ""] = m[2] ?? "";

  const bare = /(\w+)=([^\s"]+)/g;
  while ((m = bare.exec(rest)) !== null) {
    const key = m[1] ?? "";
    if (attrs.fields[key] === undefined) {
      attrs.fields[key] = m[2] === "true" ? true : m[2] === "false" ? false : (m[2] ?? "");
    }
  }
  return attrs;
}

/** A field's text, or "" when the line did not carry it. */
function fieldText(v: string | boolean | undefined): string {
  return v === undefined ? "" : String(v);
}

export function parseLine(line: string | null | undefined): Row | null {
  if (!line || !line.trim()) return null;
  const token = findRefToken(line);
  if (!token) return null;

  const head = line.slice(0, token.start);
  const tail = line.slice(token.end).trim();

  const indent = head.length - head.trimStart().length;
  const headTrimmed = head.trim();

  let role = "";
  let name = "";
  const q = headTrimmed.indexOf('"');
  if (q === -1) {
    role = headTrimmed;
  } else {
    role = headTrimmed.slice(0, q).trim();
    // Greedy to the LAST quote: an accessible name may contain quotes of its
    // own, and the renderer does not escape them.
    const lastQ = headTrimmed.lastIndexOf('"');
    name = lastQ > q ? headTrimmed.slice(q + 1, lastQ) : "";
  }

  const attrs = parseAttrs(tail);
  const { fields } = attrs;
  return {
    ref: token.ref,
    role,
    name,
    indent,
    href: fieldText(fields["href"]),
    src: fieldText(fields["src"]),
    value: fieldText(fields["value"]),
    type: fieldText(fields["type"]),
    section: fieldText(fields["section"]),
    expanded: fields["expanded"],
    checked: fields["checked"],
    selected: fields["selected"],
    disabled: attrs.disabled,
    required: attrs.required,
    ...(attrs.readonly ? { readonly: true } : {}),
    options: attrs.options,
  };
}

export const TRUNCATION_MARKER = "... (truncated)";

/**
 * Parse a whole read_page dump.
 *
 * `truncated` matters beyond diagnostics: anything cut can't be chosen, so a
 * truncated observation is a possible cause of a BLOCKED answer and is recorded
 * as such in the trace.
 */
export function parsePage(text: string): { rows: Row[]; truncated: boolean } {
  const truncated = text.includes(TRUNCATION_MARKER);
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (line.includes(TRUNCATION_MARKER)) continue;
    const row = parseLine(line);
    if (row) rows.push(row);
  }
  return { rows, truncated };
}

/**
 * Narrow the parsed rows to the ones worth offering Jev.
 *
 * Disabled controls are kept. They used to be dropped, which hid the one fact
 * that explains a stuck form: asked to click Save while Save was disabled, Jev
 * could not see Save at all, chose "New product" at 0.52 and handed back a
 * reason that said nothing about the two empty required fields. Now Jev sees
 * `button | Save | disabled` in the state, and isCompatible() refuses every
 * disabled row as a target, so none can cost a wasted step.
 *
 * Duplicates are dropped because identical criteria descriptions would split
 * probability mass between indistinguishable options and depress confidence
 * below the gate.
 */
export function usableRows(rows: Row[]): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const r of rows) {
    if (!r.role && !r.name && !r.href) continue;
    // The section is part of the identity, not decoration. Without it a form of
    // repeated cards collapses: seventeen `button "Paragraph"` rows, one per
    // card, share every other field and sixteen of them were being discarded
    // here as duplicates.
    const key = `${r.section}|${r.role}|${r.name}|${r.href}|${r.type}|${r.value}|${r.disabled ? "d" : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** The text of an MCP CallToolResult, or "" if it carries none. */
export function resultText(result: ToolResult | string | null | undefined): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  const block = (result.content || []).find((c) => c.type === "text");
  return block?.text ?? "";
}

// tool-runtime.callTool never throws and never sets isError — every failure
// arrives as a text block starting "Error: " (host/tool-runtime.ts L268-270).
// So detecting failure means sniffing the prefix; there is nothing else to test.
export function isToolError(result: ToolResult | string | null | undefined): boolean {
  return resultText(result).startsWith("Error: ");
}

/**
 * Strip text that merely repeats the interactive elements we already send.
 *
 * The excerpt's whole job is to show what the element list CANNOT: prose,
 * tables, a revision list, an invoice total. On a page like Wikipedia the body
 * text opens with the navigation — "Read Edit View history Tools Actions
 * General..." — which is word for word the names of rows Jev already has, and
 * it consumed the entire budget before any real content appeared. The per-step
 * `satisfied` check then judged "a list of past revisions is shown" while
 * looking at a menu, and sat on the fence at 0.50.
 *
 * Making the excerpt longer is not the fix — measured, that degrades the action
 * decision by diluting it. Making it non-redundant is.
 *
 * Only RUNS of names are removed: two or more back to back, as a menu, a tab
 * strip or a toolbar renders. A name standing alone is left in place, because
 * there it is part of a sentence. Removing every occurrence turned "These
 * totals use yesterday's data" into "These use yesterday's data" on a page
 * with a Totals tab, and "Export this report to share it." into "this to
 * share it." on a page with Export and Report buttons. Jev then answered 0.15
 * to "is that message shown?" while it was on screen.
 */
export function dropElementEcho(text: string, rows: ReadonlyArray<Pick<Row, "name">>, title = ""): string {
  // Never strip a word the page is ABOUT. On Wikipedia the subject is also a
  // link name, so filtering echoes turned the Octopus article's excerpt into
  // ": Revision history" — losing the one word that says where you are.
  const subject = new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
  const names = [
    ...new Set(
      rows
        .map((r) => (r.name || "").trim())
        .filter((n) => n.length >= 3 && n.length <= 30)
        .filter((n) => !subject.has(n.toLowerCase())),
    ),
  ].sort((a, b) => b.length - a.length); // longest first, so "View history" wins over "View"
  if (!names.length) return text;

  // get_page_text has already collapsed every run of whitespace, so the body
  // arrives as one long line with nothing to split on — the names have to be
  // found in place. One alternation, longest first, with word boundaries, so a
  // longer label is not shredded by a shorter one that is its prefix.
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<=^|\\W)(?:${escaped.join("|")})(?=\\W|$)`, "gi");
  const hits = [...text.matchAll(pattern)].map((m) => ({ start: m.index, end: m.index + m[0].length }));

  // Group hits separated only by spacing or a separator glyph into runs.
  const JOIN = /^[\s·|•,/>:–—-]{0,3}$/;
  const runs: Array<{ start: number; end: number; count: number }> = [];
  for (const hit of hits) {
    const last = runs[runs.length - 1];
    if (last && JOIN.test(text.slice(last.end, hit.start))) {
      last.end = hit.end;
      last.count++;
    } else {
      runs.push({ ...hit, count: 1 });
    }
  }
  let out = "";
  let at = 0;
  for (const run of runs) {
    if (run.count < 2) continue;
    out += `${text.slice(at, run.start)} `;
    at = run.end;
  }
  out += text.slice(at);
  out = out.replace(/\s+/g, " ").trim();

  // A page that is genuinely all controls would otherwise come back empty, and
  // an excerpt of nothing is worse than a redundant one.
  return out.length >= 40 ? out : text;
}

/** Drop get_page_text's "Title:/URL:/Source:" preamble, keeping the body. */
export function stripTextHeader(text: string): string {
  const blank = text.indexOf("\n\n");
  if (blank === -1) return text;
  const head = text.slice(0, blank);
  // Only strip a header that actually looks like one, so a page whose body
  // happens to start with a blank line is not truncated.
  return head.startsWith("Title:") ? text.slice(blank + 2) : text;
}

/** tabs_context_mcp prefixes its prose with a JSON blob. Pull the tab out. */
export function parseTabContext(text: string, tabId: number): { url: string; title: string } | null {
  const brace = text.indexOf("{");
  if (brace === -1) return null;
  const end = text.indexOf("}\n", brace);
  const slice = end === -1 ? text.slice(brace) : text.slice(brace, end + 1);
  try {
    const json = JSON.parse(slice) as { availableTabs?: Array<{ tabId: number; url: string; title: string }> };
    const tab = (json.availableTabs || []).find((t) => t.tabId === tabId);
    return tab ? { url: tab.url, title: tab.title } : null;
  } catch {
    return null;
  }
}

/** A snapshot row in the shape parseLine produces, plus where it sits on screen. */
/** A row as jev_snapshot sends it: the page's own values, loosely typed. */
interface SnapshotRow {
  ref: string;
  role?: string;
  name?: string;
  indent?: number;
  href?: string;
  src?: string;
  value?: string;
  type?: string;
  section?: string;
  expanded?: Flag;
  checked?: Flag;
  selected?: Flag;
  disabled?: boolean;
  required?: boolean;
  readonly?: boolean;
  options?: RowOption[];
  inView?: boolean;
  region?: string;
}

interface Snapshot {
  url: string;
  title?: string;
  rows: SnapshotRow[];
  text?: string;
  truncated?: boolean;
  scroll?: ScrollState;
  regions?: PageRegion[];
  map_truncated?: boolean;
}

function snapshotRow(r: SnapshotRow): Row {
  // read_page's text format turned bare true/false into booleans on parse;
  // keep that, so both paths hand the rest of the loop the same values.
  const flag = (v: Flag): Flag => (v === "true" ? true : v === "false" ? false : v);
  return {
    ref: r.ref,
    role: r.role || "",
    // A name can span lines (a banner link with "Learn more" under it); the
    // old text format split such a row in two and garbled the rest of the page.
    name: (r.name || "").replace(/\s+/g, " ").trim(),
    indent: r.indent ?? 0,
    href: r.href || "",
    src: r.src || "",
    value: r.value ?? "",
    type: r.type || "",
    section: r.section || "",
    expanded: flag(r.expanded),
    checked: flag(r.checked),
    selected: flag(r.selected),
    disabled: Boolean(r.disabled),
    required: Boolean(r.required),
    ...(r.readonly ? { readonly: true } : {}),
    options: Array.isArray(r.options) ? r.options : null,
    inView: r.inView,
    ...(r.region ? { region: r.region } : {}),
  };
}

// Whether a given callTool's extension has jev_snapshot. Per callTool rather
// than global, so one old extension (or a test's fake) doesn't decide for all.
const snapshotSupport = new WeakMap<CallTool, boolean>();

/**
 * Does this callTool's extension have the hidden Jev tools (jev_snapshot,
 * jev_settle, jev_act)? They ship together, so the first observation answers
 * for all three. False until that observation has happened.
 */
export function hasJevTools(callTool: CallTool): boolean {
  return snapshotSupport.get(callTool) === true;
}

/**
 * One full observation of a tab.
 *
 * Normally one jev_snapshot call. An extension that predates it gets the old
 * three-call observation instead, so an unreloaded extension still works.
 */
export interface ObserveOptions {
  excerptChars?: number;
  /**
   * Read the text of the whole page, not only what is in view. For questions
   * about its content, which is often below the fold; a step decides on what
   * is on screen.
   */
  fullText?: boolean;
  maxChars?: number;
  depth?: number;
  /**
   * Also map the whole page into regions (content.ts buildPageMap), for
   * explore.ts. Only an extension with jev_snapshot has it.
   */
  map?: boolean;
}

export async function observe(
  callTool: CallTool,
  tabId: number,
  opts: ObserveOptions = {},
): Promise<ObservationResult> {
  const { excerptChars = 300 } = opts;
  if (snapshotSupport.get(callTool) !== false) {
    const res = await callTool("jev_snapshot", {
      tabId,
      depth: opts.depth ?? 30,
      ...(opts.fullText ? { full_text: true, text_chars: excerptChars } : {}),
      ...(opts.map ? { map: true } : {}),
    });
    const text = resultText(res);
    if (isToolError(res) && !/Unknown tool/i.test(text)) return { error: text };
    let snap: Snapshot | null = null;
    try {
      snap = isToolError(res) ? null : (JSON.parse(text) as Snapshot | null);
    } catch {}
    if (snap && Array.isArray(snap.rows) && typeof snap.url === "string") {
      snapshotSupport.set(callTool, true);
      const rows = snap.rows.map(snapshotRow);
      const usable = usableRows(rows);
      // Keep it SHORT — see observeLegacy for the measurement behind 300.
      const excerpt = dropElementEcho(snap.text || "", usable, snap.title || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, excerptChars);
      return {
        url: snap.url,
        title: snap.title || "",
        rows: usable,
        allRows: rows,
        truncated: Boolean(snap.truncated),
        excerpt,
        scroll: snap.scroll ?? null,
        ...(Array.isArray(snap.regions) ? { regions: snap.regions, mapTruncated: Boolean(snap.map_truncated) } : {}),
      };
    }
    snapshotSupport.set(callTool, false);
  }
  return observeLegacy(callTool, tabId, opts);
}

/**
 * The observation before jev_snapshot existed: three tool calls.
 *
 * The three calls are independent and the runtime multiplexes on a request id
 * (host/tool-runtime.ts L176), so they go out together rather than serially.
 */
async function observeLegacy(
  callTool: CallTool,
  tabId: number,
  { excerptChars = 300, maxChars = 400_000, depth = 30 }: ObserveOptions = {},
): Promise<ObservationResult> {
  const [pageRes, textRes, ctxRes] = await Promise.all([
    // read_page truncates at 50k characters by default, which a large article
    // reaches while still well inside Jev's context window — rows would be lost
    // before the shortlister ever sees them, and a row that was never observed
    // cannot be chosen. Read wide and let the token budget do the cutting.
    // depth matters as much as max_chars. generateAccessibilityTree stops at 15
    // levels unless told otherwise, and a React form nests its controls deeper
    // than that — on the audited page the section controls sat at depth 20 and
    // were simply absent from every observation, so Jev was asked to operate a
    // form it could not see.
    callTool("read_page", { tabId, filter: "interactive", max_chars: maxChars, depth }),
    callTool("get_page_text", { tabId }),
    callTool("tabs_context_mcp", {}),
  ]);

  if (isToolError(pageRes)) {
    return { error: resultText(pageRes) };
  }

  const { rows, truncated } = parsePage(resultText(pageRes));
  const ctx = parseTabContext(resultText(ctxRes), tabId) || { url: "", title: "" };
  // get_page_text returns "Title: ...\nURL: ...\nSource: <tag>\n\n<body>".
  // The header has to come off before the excerpt is measured: the title and
  // URL are already separate fields in the state, so keeping them here spent
  // about a quarter of the budget restating them.
  //
  // Keep it SHORT. The excerpt is the only window Jev has onto non-interactive
  // content, so the instinct is to send more — but measured on a Wikipedia
  // search box with the query already typed, more prose actively degrades the
  // action decision by diluting it:
  //
  //     excerpt chars    chosen operation    confidence
  //         0            PRESS_ENTER            0.73
  //       300            PRESS_ENTER            0.77
  //      1200            PRESS_ENTER            0.53   (below the 0.6 gate)
  //
  // At 1200 the TYPE_TEXT probability climbed from 0.05 to 0.32 — the page's
  // encyclopaedia prose crowds out the one fact that matters, that the field is
  // already filled. 300 characters of real content beats both a longer excerpt
  // and none at all.
  const usable = usableRows(rows);
  const excerpt = isToolError(textRes)
    ? ""
    : dropElementEcho(stripTextHeader(resultText(textRes)), usable, ctx.title)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, excerptChars);

  return {
    url: ctx.url,
    title: ctx.title,
    rows: usable,
    allRows: rows,
    truncated,
    excerpt,
  };
}

/** Identity of a page state, for the "nothing changed" check. */
export function observationSignature(
  obs:
    | (Pick<Observation, "url" | "title"> & { rows: ReadonlyArray<Pick<Row, "role" | "name" | "value" | "disabled">> })
    | null
    | undefined,
): string {
  if (!obs) return "";
  return [
    obs.url,
    obs.title,
    obs.rows.length,
    // The disabled flag counts: filling the last required field enables Save
    // and changes nothing else, and that is progress.
    obs.rows.map((r) => `${r.role}:${r.name}:${r.value}${r.disabled ? ":d" : ""}`).join("|"),
  ].join("~");
}
