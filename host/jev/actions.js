// The action space, and the deterministic gate around it.
//
// This table is the security boundary. Jev's answer is never a selector, a URL
// or code — it is a key into a set this file built from an observation we just
// took. `navigate`, `javascript_tool`, `file_upload` and `upload_image` are
// absent from the table, so they are unreachable by construction rather than by
// a denylist someone can forget to update.

const CLICK_ROLES = new Set([
  "link", "button", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "switch", "treeitem", "gridcell", "summary"
]);

const TEXT_ROLES = new Set([
  "textbox", "searchbox", "combobox", "spinbutton", "input", "textarea"
]);

const SELECT_ROLES = new Set(["combobox", "listbox", "select", "menu"]);

export const OPERATIONS = {
  CLICK: {
    needsTarget: true,
    description: "Activate an observed link, button or control"
  },
  TYPE_TEXT: {
    needsTarget: true,
    needsValue: true,
    // The boundary with TYPE_AND_SUBMIT has to be stated, not implied. Left
    // vague ("enter a value into a field"), both read as correct for a search
    // box and Jev hedged 0.61/0.38 between them — enough to drag a certain
    // action under the confidence gate and escalate it.
    description:
      "Enter a value into a field and then STOP, leaving it unsubmitted. Only correct when other fields still have to be filled before this form is sent. Never the right choice for a lone search box."
  },
  SELECT: {
    needsTarget: true,
    needsValue: true,
    description: "Pick an option in a dropdown or list"
  },
  // One decision instead of two.
  //
  // TYPE_TEXT followed by PRESS_ENTER was costing two full Jev round trips
  // (~400ms each) to do what a person does in one gesture, and submitting after
  // typing into a search field is close to deterministic. The browser calls it
  // expands to are ~20ms each, so collapsing the pair is nearly pure saving.
  // TYPE_TEXT survives for the case this would get wrong: filling one field of
  // a multi-field form, where submitting early is exactly the mistake.
  TYPE_AND_SUBMIT: {
    needsTarget: true,
    needsValue: true,
    description:
      "Enter a value into a field and submit it immediately, in one action. The right choice for a search box, or for the last or only field of a form — anywhere a person would type and then press Enter without pausing."
  },
  // Without this there is no way to submit. Typing into a search box leaves the
  // text sitting there, and while many pages also offer a Search button, plenty
  // only accept Enter. Found on the first real multi-step run: the loop typed a
  // query and then had no legal move left.
  PRESS_ENTER: {
    needsTarget: true,
    description:
      "Submit a field that ALREADY contains the right text, without changing it. Use when the value is in place from an earlier step."
  },
  SCROLL_DOWN: { needsTarget: false, description: "Reveal more of the page below" },
  SCROLL_UP: { needsTarget: false, description: "Go back up the page" },
  WAIT: { needsTarget: false, description: "Let the page finish loading or settling" },
  DONE: { needsTarget: false, description: "The goal is already satisfied on this page" },
  BLOCKED: {
    needsTarget: false,
    description: "No offered operation can advance the goal from this page"
  }
};

// What an operation falls back to when the element refuses it.
//
// Only ever a step DOWN — the fallback does strictly less than the original,
// never something it did not ask for. TYPE_AND_SUBMIT into an autocomplete
// combobox is the case this is for: the typing was right, the blind Enter was
// not, and handing that back to Claude ended an 8-leg Wikipedia chain on its
// last leg. Typing and letting the next decision pick from the list that opens
// is what a person would do.
export const DEMOTIONS = {
  TYPE_AND_SUBMIT: "TYPE_TEXT"
};

// Operations whose whole point is to submit, and therefore to navigate.
//
// These need their settle window judged on the URL rather than on the page
// signature. The signature includes field values, so TYPE_AND_SUBMIT changes it
// the instant the text lands — which reads as "the page moved" while the
// navigation the step actually cares about is still in flight.
export const SUBMITTING_OPERATIONS = new Set(["TYPE_AND_SUBMIT", "PRESS_ENTER"]);

/** Can this operation act on this row? The gate, applied after Jev answers. */
export function isCompatible(operation, row) {
  if (!OPERATIONS[operation]) return false;
  if (!OPERATIONS[operation].needsTarget) return true;
  if (!row) return false;
  // A disabled control is on offer as context, never as a target: acting on
  // it is a no-op the loop would misread as "the page didn't change".
  if (row.disabled) return false;
  const role = (row.role || "").toLowerCase();
  switch (operation) {
    case "CLICK":
      // An anchor often renders with no role at all; its href is what makes it
      // clickable, so treat that as the evidence rather than demanding a role.
      //
      // Text fields are clickable too. Treating CLICK and TYPE_TEXT as mutually
      // exclusive was too strict: focusing a field, or clicking it to open a
      // suggestions dropdown, is something people do constantly, and refusing
      // it stranded a run that had typed a query and wanted to open the
      // autocomplete list.
      return CLICK_ROLES.has(role) || TEXT_ROLES.has(role) || Boolean(row.href) || Boolean(row.type);
    case "TYPE_AND_SUBMIT":
      // Not into an autocomplete combobox. Its Enter belongs to the suggestion
      // menu, not to a form: typing "mobile edit" into a tag filter and
      // submitting blind landed on a revision diff page. Those need TYPE_TEXT,
      // then a decision that picks from the list that opens.
      if (role === "combobox") return false;
      return TEXT_ROLES.has(role) || Boolean(row.type);
    case "PRESS_ENTER":
      return TEXT_ROLES.has(role) || Boolean(row.type);
    case "TYPE_TEXT":
      return TEXT_ROLES.has(role) || Boolean(row.type);
    case "SELECT":
      return SELECT_ROLES.has(role) || Array.isArray(row.options);
    default:
      return false;
  }
}

// One target question per kind of operation, each offering only the rows that
// kind of operation can act on.
//
// A single target question asked in parallel with the operation question had
// to list every row, so its probability mass landed on rows the chosen
// operation could never touch, and that mass read as doubt. On Wikipedia,
// PRESS_ENTER split 0.58/0.41 between the search field and the Search button,
// which is not a legal PRESS_ENTER target at all. jev-ultrafast's design
// avoids this: a head that cannot name an illegal target leaves nothing to
// renormalize away.
export const TARGET_HEADS = {
  click_target: {
    accepts: "CLICK",
    instructions: "If the next operation is CLICK, which element should be clicked? Pick the one whose label best matches the next step toward the goal."
  },
  text_target: {
    accepts: "TYPE_TEXT",
    instructions: "If the next operation types into or submits a field (TYPE_TEXT, TYPE_AND_SUBMIT or PRESS_ENTER), which field? Do not choose a field that already holds the value it needs, unless the next step is to submit it."
  },
  select_target: {
    accepts: "SELECT",
    instructions: "If the next operation is SELECT, which dropdown or list?"
  }
};

/** The target question that answers for `operation`, or null if it takes none. */
export function targetHead(operation) {
  switch (operation) {
    case "CLICK": return "click_target";
    case "TYPE_TEXT":
    case "TYPE_AND_SUBMIT":
    case "PRESS_ENTER": return "text_target";
    case "SELECT": return "select_target";
    default: return null;
  }
}

/**
 * Which operations this page can actually support right now.
 *
 * `scroll` ({y, height, viewport}, from jev_snapshot) offers a scroll only in a
 * direction the page can actually move. Without it both are offered, as before.
 */
export function availableOperations(rows, scroll = null) {
  const ops = new Set(["WAIT", "DONE", "BLOCKED"]);
  if (!scroll || scroll.y + scroll.viewport < scroll.height - 2) ops.add("SCROLL_DOWN");
  if (!scroll || scroll.y > 0) ops.add("SCROLL_UP");
  for (const r of rows) {
    if (isCompatible("CLICK", r)) ops.add("CLICK");
    if (isCompatible("TYPE_TEXT", r)) {
      ops.add("TYPE_TEXT");
      ops.add("PRESS_ENTER");
      ops.add("TYPE_AND_SUBMIT");
    }
    if (isCompatible("SELECT", r)) ops.add("SELECT");
  }
  return [...ops];
}

// A page's own words are the more reliable signal here: Jev's `sensitive`
// answer is a judgement about consequences, this is a fact about the label.
// Either one trips the gate, so a miss by one is covered by the other.
const SENSITIVE_WORDS = [
  "delete", "remove", "destroy", "erase", "wipe",
  "pay", "payment", "purchase", "buy", "checkout", "order", "subscribe",
  "send", "publish", "post", "submit", "confirm", "transfer", "withdraw",
  "cancel subscription", "deactivate", "close account", "sign out", "log out"
];

export function looksSensitive(row) {
  if (!row) return false;
  const hay = `${row.name} ${row.value} ${row.type}`.toLowerCase();
  return SENSITIVE_WORDS.some((w) => hay.includes(w));
}

const JEV_ACT_OPERATIONS = new Set([
  "CLICK", "SELECT", "TYPE_TEXT", "TYPE_AND_SUBMIT", "PRESS_ENTER", "SCROLL_DOWN", "SCROLL_UP"
]);

/**
 * Turn a validated (operation, row, value) into the tool calls that perform it.
 * Returns a list because typing into a rich editor needs two.
 */
export function planToolCalls(operation, row, value, tabId, { jevTools = false } = {}) {
  // One jev_act call per operation when the extension has it: one round trip
  // instead of up to three, and the target is checked before it is touched.
  if (jevTools && JEV_ACT_OPERATIONS.has(operation)) {
    const call = { tabId, operation };
    if (row) {
      call.ref = row.ref;
      call.expect = { role: row.role || "", name: row.name || "" };
      call.formField = Boolean(row.type);
    }
    if (value !== undefined) call.value = value;
    return [["jev_act", call]];
  }
  switch (operation) {
    case "CLICK":
      return [["computer", { action: "left_click", ref: row.ref, tabId }]];
    case "SELECT":
      return [["form_input", { ref: row.ref, value, tabId }]];
    case "PRESS_ENTER":
      // The key action dispatches to whatever currently has focus and ignores
      // ref entirely (extension/background.js L1592), and form_input sets a
      // value programmatically without focusing anything. So the click is not
      // decoration — it is what makes the keystroke land in the right field.
      return [
        ["computer", { action: "left_click", ref: row.ref, tabId }],
        ["computer", { action: "key", text: "Return", tabId }]
      ];
    case "TYPE_AND_SUBMIT":
      return [
        ...planToolCalls("TYPE_TEXT", row, value, tabId, { jevTools }),
        ...planToolCalls("PRESS_ENTER", row, value, tabId, { jevTools })
      ];
    case "TYPE_TEXT": {
      // form_input sets the value directly and fires the events a framework
      // listens for — one round trip, no focus dance. It only works on real
      // form controls, which `type` on the row is what tells us; anything else
      // (contenteditable, a styled div) needs select-all-then-type.
      if (row.type) return [["form_input", { ref: row.ref, value, tabId }]];
      return [
        ["computer", { action: "triple_click", ref: row.ref, tabId }],
        ["computer", { action: "type", text: value, tabId }]
      ];
    }
    // The computer tool's scroll needs a point to scroll at, and without one
    // it declined without an "Error:" prefix, so these used to be silent
    // no-ops. Any point inside the viewport scrolls the page.
    case "SCROLL_DOWN":
      return [
        ["computer", { action: "scroll", coordinate: [400, 300], scroll_direction: "down", scroll_amount: 5, tabId }]
      ];
    case "SCROLL_UP":
      return [
        ["computer", { action: "scroll", coordinate: [400, 300], scroll_direction: "up", scroll_amount: 5, tabId }]
      ];
    case "WAIT":
      // A quarter second and then two frames, as jev-ultrafast does, rather
      // than a flat second. An extension without jev_settle gets the second.
      return jevTools
        ? [["jev_settle", { tabId, expect: "wait", timeoutMs: 250 }]]
        : [["computer", { action: "wait", duration: 1, tabId }]];
    default:
      return [];
  }
}

/**
 * Do two accessible names denote the same control? Ignores bracketed hints,
 * case and spacing, because pages rewrite those after load (MediaWiki turns
 * "[t]" into "[ctrl-option-t]"). Mirrors looseName in extension/content.js.
 */
export function namesAgree(a, b) {
  const loose = (s) => String(s || "").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return loose(a) === loose(b);
}

/** A short, stable label for a row — used in traces and in the step log. */
export function rowLabel(row) {
  if (!row) return "";
  const base = [row.role, row.name && `"${row.name}"`].filter(Boolean).join(" ");
  // Name the card in step logs and escalation reasons. "CLICK on button
  // \"Paragraph\"" is unreadable when the page offers seventeen of them.
  const located = base && row.section ? `${base} in ${row.section}` : base;
  return located || row.href || row.ref;
}
