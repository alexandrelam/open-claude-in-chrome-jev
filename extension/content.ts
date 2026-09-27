// Content script for Open Claude in Chrome extension.
// Injected into every page. Provides:
// - Accessibility tree generation (read_page)
// - Element ref mapping with WeakRef (persistent across calls)
// - Form input handling
// - Page text extraction
// - Element finding by text/attributes

(function () {
  if (window.__unblockedChromeLoaded) return;
  window.__unblockedChromeLoaded = true;

  /**
   * An element, read loosely. Pages hand us every kind of element, and the
   * properties below exist only on some of them (form controls, links,
   * images, HTML but not SVG). A <form>'s named getters can also shadow any of
   * them with an element, so each read below checks the type it gets.
   */
  type Loose = Element &
    Partial<Pick<HTMLElement, "offsetParent" | "tabIndex" | "onclick" | "contentEditable" | "innerText" | "title">> & {
      placeholder?: unknown;
      alt?: unknown;
      type?: unknown;
      value?: unknown;
      disabled?: unknown;
      required?: unknown;
      checked?: unknown;
      href?: unknown;
      src?: unknown;
    };

  /** The value if it is a string, else "". */
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  // --- Element reference map ---
  // Persistent ref IDs stored as WeakRefs so GC still works
  let refCounter = 0;
  const elementMap: Record<string, WeakRef<Element>> = {};
  const reverseMap = new WeakMap<Element, string>();

  function getOrAssignRef(el: Element): string {
    const existing = reverseMap.get(el);
    if (existing && elementMap[existing]?.deref() === el) return existing;
    const ref = `ref_${++refCounter}`;
    elementMap[ref] = new WeakRef(el);
    reverseMap.set(el, ref);
    return ref;
  }

  function resolveRef(refId: string): Loose | null {
    const wr = elementMap[refId];
    if (!wr) return null;
    const el = wr.deref();
    if (!el) {
      delete elementMap[refId];
      return null;
    }
    return el;
  }

  // --- ARIA role mapping ---
  const TAG_TO_ROLE: Record<string, string> = {
    a: "link",
    button: "button",
    input: "textbox",
    textarea: "textbox",
    select: "combobox",
    img: "img",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    aside: "complementary",
    form: "form",
    table: "table",
    tr: "row",
    th: "columnheader",
    td: "cell",
    ul: "list",
    ol: "list",
    li: "listitem",
    dialog: "dialog",
    details: "group",
    summary: "button",
    progress: "progressbar",
    meter: "meter",
    video: "video",
    audio: "audio",
    section: "region",
    article: "article",
  };

  function getRole(el: Loose): string | null {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (str(el.type) || "text").toLowerCase();
      const typeRoles: Record<string, string> = {
        checkbox: "checkbox",
        radio: "radio",
        range: "slider",
        button: "button",
        submit: "button",
        reset: "button",
        search: "searchbox",
        number: "spinbutton",
      };
      return typeRoles[type] || "textbox";
    }
    return TAG_TO_ROLE[tag] || null;
  }

  // --- Accessible name ---
  function getAccessibleName(el: Loose): string {
    // Priority: aria-label > aria-labelledby > placeholder > title > alt > label > text
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const names = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean);
      if (names.length) return names.join(" ");
    }

    // typeof guards: a <form> (or <fieldset>) exposes its named controls as
    // properties via a [LegacyOverrideBuiltIns] named getter, so an
    // <input name="title"> makes form.title the ELEMENT, not the string —
    // and .trim() on it throws, taking down read_page/find for the whole
    // page. Same shadowing applies to placeholder and alt.
    if (typeof el.placeholder === "string" && el.placeholder) return el.placeholder.trim();
    if (typeof el.title === "string" && el.title) return el.title.trim();
    if (typeof el.alt === "string" && el.alt) return el.alt.trim();

    // Associated <label>
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return (label.textContent ?? "").trim();
    }
    const wrapping = el.closest("label");
    if (wrapping) {
      const labelText = (wrapping.textContent ?? "").trim();
      if (labelText) return labelText;
    }

    // Direct text content (only for leaf-ish elements)
    const tag = el.tagName.toLowerCase();
    if (
      ["a", "button", "h1", "h2", "h3", "h4", "h5", "h6", "li", "summary", "label", "th", "td", "span"].includes(tag)
    ) {
      const text = el.textContent?.trim();
      if (text && text.length < 200) return text;
    }

    return "";
  }

  // --- Interactivity check ---
  function isInteractive(el: Loose): boolean {
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "textarea", "select", "summary", "details"].includes(tag)) return true;
    const role = el.getAttribute("role");
    if (
      role &&
      [
        "button",
        "link",
        "textbox",
        "checkbox",
        "radio",
        "tab",
        "menuitem",
        "switch",
        "combobox",
        "slider",
        "spinbutton",
        "searchbox",
        "option",
      ].includes(role)
    )
      return true;
    if (el.tabIndex !== undefined && el.tabIndex >= 0) return true;
    if (el.onclick || el.getAttribute("onclick")) return true;
    if (el.contentEditable === "true") return true;
    return false;
  }

  // --- Visibility check ---
  function isVisible(el: Loose): boolean {
    if (el.offsetParent === null && el.tagName.toLowerCase() !== "body" && getComputedStyle(el).position !== "fixed")
      return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  }

  // --- Accessibility tree generation ---

  // Elements that group a page into named parts. A repeated-card form is the
  // case that matters: seventeen cards each offering a "Paragraph" button is
  // seventeen rows that are identical unless we say which card they came from.
  const REGION_TAGS = new Set([
    "section",
    "article",
    "nav",
    "aside",
    "form",
    "fieldset",
    "main",
    "header",
    "footer",
    "dialog",
    "details",
    "table",
    "li",
  ]);
  const REGION_ROLES = new Set([
    "region",
    "group",
    "form",
    "dialog",
    "tabpanel",
    "listitem",
    "row",
    "article",
    "navigation",
    "complementary",
    "search",
    "radiogroup",
  ]);

  // The name of the part `el` introduces, or null if it introduces none.
  function regionNameFor(el: Element): string | null {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (!REGION_TAGS.has(tag) && !REGION_ROLES.has(role)) return labelledByHeading(el);

    // aria-label / aria-labelledby first, which is how a well-built card names
    // itself; then the heading or legend a card usually leads with.
    let name = "";
    const aria = el.getAttribute("aria-label");
    if (aria) name = aria.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (!name && labelledBy) {
      name = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
        .join(" ");
    }
    if (!name) {
      const heading = el.querySelector("h1, h2, h3, h4, h5, h6, legend, summary, caption");
      // Only a heading that belongs to THIS region, not one from a nested card.
      if (heading && heading.closest(REGION_TAGS_SELECTOR) === el) {
        name = (heading.textContent ?? "").trim();
      }
    }
    if (!name) return null;
    return name.replace(/\s+/g, " ").slice(0, 60);
  }
  // A plain container that names itself after a heading is a region too, even
  // with no landmark tag or role. Google Tasks builds each list's column this
  // way: a bare <div aria-labelledby> pointing at the list's <h2>. Without it,
  // three columns each offering "Add a task" were three identical rows, and
  // Jev clicked the first column's button six times while trying to add to
  // the third. Only a heading counts as the label, so a div that merely
  // borrows some text for its name does not start stamping sections.
  function labelledByHeading(el: Element): string | null {
    const ids = el.getAttribute("aria-labelledby");
    if (!ids || el.getAttribute("role")) return null;
    const heading = ids
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .find((h) => h && (/^h[1-6]$/i.test(h.tagName) || h.getAttribute("role") === "heading"));
    const name = heading?.textContent?.replace(/\s+/g, " ").trim();
    return name ? name.slice(0, 60) : null;
  }
  const REGION_TAGS_SELECTOR =
    [...REGION_TAGS].join(",") +
    ",[role=region],[role=group],[role=form],[role=dialog],[role=tabpanel],[role=listitem],[role=row]";

  // An element the page has explicitly removed from the accessibility tree.
  // Offering these is worse than useless: they are exactly the controls sitting
  // underneath an open panel, and clicking one does nothing while looking like
  // a legitimate action that simply had no effect.
  function isHiddenFromA11y(el: Element): boolean {
    return Boolean(el.closest('[aria-hidden="true"], [inert]'));
  }

  // One interactive/visible element, as structured fields. The single source
  // of what a row says: read_page's text line is formatted from this, and
  // jev_snapshot returns it as-is, so the two cannot drift apart.
  // Disabled the way a person experiences it: the control's own attribute, a
  // <fieldset disabled> it sits in (:disabled inherits, .disabled does not),
  // or an aria-disabled / inert ancestor, which is how component libraries
  // disable a styled button that is not a real <button>.
  function isEffectivelyDisabled(el: Loose): boolean {
    if (el.disabled) return true;
    try {
      if (el.matches(":disabled")) return true;
    } catch {}
    return Boolean(el.closest('[aria-disabled="true"],[inert]'));
  }

  // The text a custom select shows as its current choice. A styled combobox is
  // a <div> with no value property, so without this an empty "Visit type"
  // picker and a filled one render identically, and nothing can report that a
  // required field was left blank.
  function displayedChoice(el: Loose, tag: string, role: string | null, name: string): string {
    if (["input", "textarea", "select"].includes(tag)) return "";
    const popup = (el.getAttribute("aria-haspopup") || "").toLowerCase();
    if (role !== "combobox" && popup !== "listbox") return "";
    const shown = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    return shown && shown !== name ? shown.substring(0, 100) : "";
  }

  function describeRow(el: Loose, tag: string, role: string | null, name: string, landmark: string | null): ContentRow {
    const row: ContentRow = { ref: getOrAssignRef(el), role: role || "", name: name ? name.substring(0, 100) : "" };
    if (tag === "a" && str(el.href)) row.href = str(el.href);
    if (tag === "img" && str(el.src)) row.src = str(el.src).substring(0, 100);
    if (["input", "textarea"].includes(tag) && str(el.value)) row.value = str(el.value).substring(0, 100);
    if (tag === "input") row.type = str(el.type) || "text";
    const expanded = el.getAttribute("aria-expanded");
    if (expanded) row.expanded = expanded;
    const checked = el.getAttribute("aria-checked");
    if (checked) row.checked = checked;
    else if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) row.checked = el.checked === true;
    const selected = el.getAttribute("aria-selected");
    if (selected) row.selected = selected;
    if (!row.value) {
      const shown = displayedChoice(el, tag, role, name);
      if (shown) row.value = shown;
    }
    if (isEffectivelyDisabled(el)) row.disabled = true;
    if (el.required || el.getAttribute("aria-required") === "true") row.required = true;
    // Which part of the page this control belongs to. Without it a form of
    // repeated cards is an undifferentiated list in which the same label
    // appears once per card and none of them can be told apart.
    if (landmark && landmark !== name) row.section = landmark;
    if (el instanceof HTMLSelectElement) {
      const opts = Array.from(el.options).map((o) => ({
        value: o.value,
        label: (o.textContent ?? "").trim(),
        selected: o.selected,
      }));
      if (opts.length) row.options = opts;
    }
    return row;
  }

  function formatRow(indent: string, row: ContentRow): string {
    let line = indent;
    if (row.role) line += row.role;
    if (row.name) line += ` "${row.name}"`;
    line += ` [${row.ref}]`;
    if (row.href) line += ` href="${row.href}"`;
    if (row.src) line += ` src="${row.src}"`;
    if (row.value) line += ` value="${row.value}"`;
    if (row.type) line += ` type="${row.type}"`;
    if (row.expanded) line += ` expanded=${row.expanded}`;
    if (row.checked !== undefined) line += ` checked=${row.checked}`;
    if (row.selected) line += ` selected=${row.selected}`;
    if (row.disabled) line += " disabled";
    if (row.required) line += " required";
    if (row.section) line += ` section="${row.section}"`;
    if (row.options) {
      line += ` options=[${row.options.map((o) => `${o.selected ? "*" : " "}${o.value}="${o.label}"`).join(", ")}]`;
    }
    return line;
  }

  // Walk the page the way read_page always has, calling visit(el, row, indent)
  // for every element that is shown. visit returns false to stop the walk.
  // Returns an error string if startRefId cannot be resolved, else null.
  type Visit = (el: Loose, row: ContentRow, indent: string) => boolean;

  function walkRows(options: AccessibilityOptions, visit: Visit): string | null {
    const filter = options.filter || "all";
    const maxDepth = options.depth || 15;
    const startRefId = options.ref_id || null;
    let stopped = false;

    function walk(el: Loose, depth: number, indent: string, landmark: string | null): void {
      if (stopped) return;
      if (depth > maxDepth) return;
      if (!el || el.nodeType !== 1) return;

      const tag = el.tagName.toLowerCase();
      // Skip invisible, script, style, svg internals
      if (["script", "style", "noscript", "template"].includes(tag)) return;
      if (isHiddenFromA11y(el)) return;

      const interactive = isInteractive(el);

      // Filter: if interactive-only mode, skip non-interactive non-container elements
      const isContainer = el.children.length > 0;
      if (filter === "interactive" && !interactive && !isContainer) return;

      // Name and style are the expensive part of the walk (a container's name
      // reads its whole textContent), so an element that cannot be shown
      // never pays for them. Nothing below reads either unless it is shown.
      const role = filter === "all" || interactive ? getRole(el) : null;
      const name = filter === "all" || interactive ? getAccessibleName(el) : "";

      const shouldShow = (filter === "all" && (role || name)) || (filter === "interactive" && interactive);
      const visible = shouldShow && isVisible(el);

      if (shouldShow && visible) {
        if (!visit(el, describeRow(el, tag, role, name, landmark), indent)) {
          stopped = true;
          return;
        }
      }

      // Recurse children (including shadow DOM)
      const nextIndent = shouldShow && visible ? indent + "  " : indent;
      // The nearest named region wins, so a control reports the card it is in
      // rather than the outermost <main> that contains everything.
      const nextLandmark = regionNameFor(el) || landmark;
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) {
          walk(child, depth + 1, nextIndent, nextLandmark);
        }
      }
      for (const child of el.children) {
        walk(child, depth + 1, nextIndent, nextLandmark);
      }
    }

    let root: Loose = document.body;
    if (startRefId) {
      const el = resolveRef(startRefId);
      if (el) root = el;
      else return `Error: ref_id "${startRefId}" not found or element was garbage collected.`;
    } else {
      // A modal dialog means everything behind it is unreachable — that is what
      // aria-modal asserts. Reporting the covered page as though it were
      // actionable is how an agent ends up clicking a button under a panel and
      // reading the no-op as "the page didn't change".
      const modal = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"], dialog[open]');
      if (modal && isVisible(modal)) root = modal;
    }

    walk(root, 0, "", root === document.body ? null : regionNameFor(root));
    return null;
  }

  function generateAccessibilityTree(options: AccessibilityOptions = {}): string {
    const maxChars = options.max_chars || 50000;
    let output = "";
    let charCount = 0;

    const error = walkRows(options, (_el, row, indent) => {
      const text = formatRow(indent, row) + "\n";
      if (charCount + text.length > maxChars) {
        output += text.substring(0, maxChars - charCount);
        output += "\n... (truncated)";
        return false;
      }
      output += text;
      charCount += text.length;
      return true;
    });
    return error || output;
  }

  // Text the user can actually see: text nodes inside the main content region
  // (the same region get_page_text picks) whose box intersects the viewport.
  // Off-screen article bodies and footers never reach the decision model.
  function visibleText(maxChars: number): string {
    const root = pickContentRoot();
    const words: string[] = [];
    let length = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let node: Node | null;
    while ((node = walker.nextNode()) && length < maxChars) {
      const value = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      const parent = node.parentElement;
      if (!value || !parent || parent.closest("script,style,noscript,template,svg")) continue;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
        words.push(value);
        length += value.length + 1;
      }
    }
    return words.join(" ").slice(0, maxChars);
  }

  // Resolve once the page has had a chance to react to an action: two
  // animation frames, bounded by timeoutMs. For an editable combobox, wait
  // instead for its suggestions to become visible (same bound), so the next
  // decision is not made against a popup that has not opened yet. Ported from
  // jev-ultrafast's post-input wait.
  //
  // mode "quiet" is for a page that just loaded: the load event fires before
  // the page's own scripts finish building it. On Wikipedia the Appearance
  // radios do not exist yet and link titles are rewritten a moment later, so
  // a decision taken at load chose "Hide Appearance" over a Dark radio it
  // could not see. Resolve once the document is complete and QUIET_MS pass
  // with no DOM mutation, bounded by timeoutMs for pages that never stop.
  const QUIET_MS = 150;
  type SettleResult = ContentRequests["jevSettle"]["res"]["result"];

  function settleFrames(mode: string, ref: string | undefined, timeoutMs: number): Promise<SettleResult> {
    return new Promise((resolve) => {
      let frames = 0;
      let done = false;
      let observer: MutationObserver | null = null;
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (reason: SettleResult) => {
        if (done) return;
        done = true;
        observer?.disconnect();
        clearTimeout(quietTimer);
        resolve(reason);
      };
      setTimeout(() => finish("timeout"), timeoutMs);
      if (mode === "quiet") {
        const arm = () => {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(() => (document.readyState === "complete" ? finish("quiet") : arm()), QUIET_MS);
        };
        observer = new MutationObserver(arm);
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        arm();
        return;
      }
      const field = mode === "combobox" && ref ? resolveRef(ref) : null;
      const optionsVisible = () => {
        const ids = (field?.getAttribute("aria-controls") || field?.getAttribute("aria-owns") || "")
          .split(/\s+/)
          .filter(Boolean);
        const roots: ParentNode[] = ids.length
          ? ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => e !== null)
          : [document];
        return roots.some((root) =>
          [...root.querySelectorAll<HTMLElement>('[role="option"]')].some((e) => {
            const r = e.getBoundingClientRect();
            return r.width && r.height && r.bottom > 0 && r.top < innerHeight && isVisible(e);
          }),
        );
      };
      const tick = () => {
        if (done) return;
        if (++frames >= 2 && (mode !== "combobox" || optionsVisible())) finish("settled");
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  // Is `ref` still the element the decision was made about? Checked right
  // before acting, because a Jev round trip sits between the observation and
  // the action and the page can change under it. A ref that now names a
  // different, hidden or disabled element is refused instead of clicked.
  //
  // Names are compared without bracketed hints, case or spacing: MediaWiki
  // rewrites "[t]" to "[ctrl-option-t]" in link titles after load, and an exact
  // comparison refused the same link as stale. Keep in step with namesAgree in
  // host/jev/actions.ts.
  const looseName = (s: unknown) =>
    (typeof s === "string" ? s : "")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  function jevGuard(ref: string, expect: { role?: string; name?: string } = {}): JevGuardResult {
    const el = resolveRef(ref);
    if (!el || !el.isConnected) return { ok: false, reason: `${ref} is no longer on the page` };
    if (isEffectivelyDisabled(el)) return { ok: false, reason: `${ref} is now disabled` };
    if (isHiddenFromA11y(el) || !isVisible(el)) return { ok: false, reason: `${ref} is no longer visible` };
    const role = getRole(el) || "";
    const name = getAccessibleName(el).substring(0, 100).replace(/\s+/g, " ").trim();
    if (expect.role !== undefined && expect.role !== role)
      return { ok: false, reason: `${ref} is now a ${role || "element"}, not a ${expect.role}` };
    if (expect.name !== undefined && looseName(expect.name) !== looseName(name))
      return { ok: false, reason: `${ref} is now named "${name}", not "${expect.name}"` };
    return { ok: true };
  }

  // Everything the Jev loop needs from one observation, in one message:
  // structured rows (no text format to parse), what is on screen, and where
  // the page is scrolled. Replaces read_page + get_page_text + tabs_context.
  function jevSnapshot(options: ContentRequests["jevSnapshot"]["req"]["options"] = {}): JevSnapshot {
    const maxRows = options.max_rows || 3000;
    const rows: ContentRow[] = [];
    let truncated = false;
    walkRows({ filter: "interactive", depth: options.depth || 30 }, (el, row, indent) => {
      if (rows.length >= maxRows) {
        truncated = true;
        return false;
      }
      const r = el.getBoundingClientRect();
      row.indent = indent.length;
      row.inView =
        r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      rows.push(row);
      return true;
    });
    const height = document.documentElement.scrollHeight;
    return {
      url: location.href,
      title: document.title || "",
      rows,
      truncated,
      text: visibleText(options.text_chars || 2000),
      scroll: { y: Math.round(scrollY), height, viewport: innerHeight },
    };
  }

  // --- Page text extraction ---
  function pickContentRoot(): HTMLElement {
    const selectors = [
      "article",
      "main",
      '[class*="articleBody"]',
      '[class*="post-content"]',
      '[class*="entry-content"]',
      '[role="main"]',
      ".content",
      "#content",
    ];
    for (const sel of selectors) {
      const source = document.querySelector<HTMLElement>(sel);
      if (source) return source;
    }
    return document.body;
  }

  function getPageText(): string {
    const source = pickContentRoot();
    const title = document.title || "";
    const url = location.href;
    const tag = source.tagName.toLowerCase();

    // Clean text: remove script/style content, collapse whitespace
    const clone = source.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script, style, noscript, template, svg").forEach((el) => el.remove());
    const text = (clone.textContent ?? "").replace(/\s+/g, " ").trim();

    return JSON.stringify({ title, url, sourceTag: tag, text: text.substring(0, 100000) });
  }

  // --- Element finding ---
  function findElements(query: string): FoundElement[] {
    const q = query.toLowerCase();
    const results: FoundElement[] = [];

    // Collect all elements including those inside shadow roots
    function collectAll(root: ParentNode): Loose[] {
      const elements: Loose[] = [];
      for (const el of root.querySelectorAll("*")) {
        elements.push(el);
        if (el.shadowRoot) {
          elements.push(...collectAll(el.shadowRoot));
        }
      }
      return elements;
    }

    const all = collectAll(document);

    for (const el of all) {
      if (results.length >= 20) break;
      if (!isVisible(el)) continue;

      const tag = el.tagName.toLowerCase();
      if (["script", "style", "noscript", "template"].includes(tag)) continue;

      const role = getRole(el) || "";
      const name = getAccessibleName(el) || "";
      const text = el.textContent?.trim()?.substring(0, 200) || "";
      // Coerce to "" unless it's really a string: a form control named
      // title/placeholder/type shadows the built-in property with an ELEMENT,
      // which would stringify to "[object HTMLInputElement]" and silently
      // pollute matching (see the typeof guards in getAccessibleName).
      const placeholder = str(el.placeholder);
      const ariaLabel = el.getAttribute("aria-label") || "";
      const title = str(el.title);
      const type = str(el.type);

      const searchable = `${role} ${name} ${text} ${placeholder} ${ariaLabel} ${title} ${type} ${tag}`.toLowerCase();

      if (searchable.includes(q)) {
        const ref = getOrAssignRef(el);
        const rect = el.getBoundingClientRect();
        const cx = Math.round(rect.x + rect.width / 2);
        const cy = Math.round(rect.y + rect.height / 2);
        results.push({
          ref,
          role: role || tag,
          name: name || text.substring(0, 80),
          coordinates: [cx, cy],
          // A match can be scrolled out of view — inside a horizontally
          // overflowing strip, below the fold, anywhere. Its coordinates are
          // still returned (they are correct, just not currently reachable),
          // but clicking them would land on the document root instead of the
          // element. Flag it here so the caller scrolls first rather than
          // discovering the miss afterwards.
          offViewport: cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight,
        });
      }
    }
    return results;
  }

  // --- Form input ---

  // Find the actual input/textarea/select inside an element, traversing shadow DOM
  function findInputInside(el: Loose): Loose | null {
    const tag = el.tagName.toLowerCase();
    if (["input", "textarea", "select"].includes(tag)) return el;

    // Check shadow DOM first
    const root = el.shadowRoot || el;
    const inner = root.querySelector("input, textarea, select");
    if (inner) return inner;

    // Recurse into shadow roots of children
    for (const child of root.querySelectorAll("*")) {
      if (child.shadowRoot) {
        const deep = child.shadowRoot.querySelector("input, textarea, select");
        if (deep) return deep;
      }
    }
    return null;
  }

  function setFormValue(refId: string, value: unknown): SetFormValueResult {
    const el = resolveRef(refId);
    if (!el) return { error: `Element ${refId} not found or was garbage collected.` };

    el.scrollIntoView({ block: "center", behavior: "instant" });

    // Resolve the actual form element (may be inside shadow DOM)
    const target = findInputInside(el) || el;
    const tag = target.tagName.toLowerCase();
    const type = str(target.type).toLowerCase();

    if (target instanceof HTMLSelectElement) {
      const opt = Array.from(target.options).find(
        (o) => o.value === String(value) || (o.textContent ?? "").trim() === String(value),
      );
      if (opt) {
        target.value = opt.value;
      } else {
        target.value = String(value);
      }
    } else if (type === "checkbox" || type === "radio") {
      const shouldCheck = typeof value === "boolean" ? value : value === "true";
      if (target.checked !== shouldCheck && target instanceof HTMLElement) target.click();
      return { success: true, checked: (target as Loose).checked === true };
    } else if (target.contentEditable === "true") {
      target.textContent = String(value);
    } else if (["input", "textarea"].includes(tag)) {
      // Use the native setter for actual input/textarea elements
      const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      // Reflect.set with `target` as the receiver runs the prototype's own
      // setter on it, which frameworks that patch the instance still observe.
      if (!Reflect.set(proto, "value", String(value), target)) {
        target.value = String(value);
      }
    } else {
      // Fallback for unknown elements — try direct assignment
      try {
        target.value = String(value);
      } catch {
        return { error: `Cannot set value on <${tag}> element. No input found inside.` };
      }
    }

    // Dispatch events on the target (bubbles up through shadow DOM)
    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    return { success: true, value: target.value };
  }

  // --- What is actually at a point ---
  // A dispatched click lands on whatever occupies its coordinates, which is not
  // necessarily what the caller aimed at: the target may have scrolled out of
  // view, or something transparent may be sitting on top of it. The dispatch
  // succeeds either way, so without this a hit and a miss are indistinguishable
  // from the tool result. Runs in the isolated world, so it can also report the
  // ref of the element it found — the same ref space read_page/find hand out.
  function describePoint(x: number, y: number): PointDescription {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const outside = x < 0 || y < 0 || x >= vw || y >= vh;
    const el = outside ? null : document.elementFromPoint(x, y);
    if (!el) return { hit: null, outside, viewport: [vw, vh] };

    // Shadow DOM: elementFromPoint stops at the host, so walk into the shadow
    // tree to name the node that will really receive the event.
    let node: Element = el;
    for (let depth = 0; depth < 4 && node.shadowRoot; depth++) {
      const inner = node.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === node) break;
      node = inner;
    }

    const tag = node.tagName.toLowerCase();
    const attrs: Record<string, string> = {};
    for (const a of ["id", "name", "type", "role", "data-testid", "data-test", "aria-label"]) {
      const v = node.getAttribute(a);
      if (v) attrs[a] = v.length > 40 ? v.slice(0, 40) + "…" : v;
    }
    const cls =
      typeof node.className === "string" && node.className.trim()
        ? node.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
    const text = (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    // Only report a ref the element already has; assigning a new one here would
    // grow the ref map on every click.
    const existing = reverseMap.get(node);
    const ref = existing && elementMap[existing]?.deref() === node ? existing : null;
    // Whether a click here can be a no-op a caller can't tell apart from a hit.
    // Flag it only when the point is on/inside a <label> whose associated
    // control is missing OR not natively activatable, AND no live interactive
    // element is present to receive the bubbled click. A click on a label with
    // a working control, or on a label under a real interactive ancestor, still
    // reaches a target and must not read as dead.
    //
    // The effective disabled state is deliberate: ctrl.disabled is the control's
    // own attribute, so it misses a control disabled by being inside a
    // <fieldset disabled>, while ctrl.matches(":disabled") reflects the real,
    // inheritable state. Testing :disabled (not :enabled) also matters because
    // :enabled only matches button/input/select/textarea/option — it would
    // wrongly mark non-disabled labelable elements like <meter>/<output>/
    // <progress> as non-activatable and flag a healthy label as dead.
    //
    // The hit must be resolved through the DOM, not just the direct
    // elementFromPoint result: labels usually wrap a <span>/<svg> child, so the
    // point often lands on the child, not the <label> itself.
    //
    // The ancestor selector matches only LIVE interactive elements: enabled form
    // controls, acted-on anchors, and interactive ARIA roles. Bare [role] would
    // match presentational/landmark roles like banner or presentation; bare
    // input/button would count a DISABLED control as "still gets the click".
    const labelEl = node.closest("label");
    const ctrl = labelEl && labelEl.control;
    const noNativeActivation = !ctrl || ctrl.matches(":disabled");
    // [onclick]/[tabindex] must also exclude disabled controls: a disabled
    // control that happens to carry one still never receives the click.
    // ARIA roles are ASCII case-insensitive, so use the `i` flag. contenteditable
    // and media controls are natively interactive targets of their own.
    const interactiveAncestor = node.closest(
      "a[href],a[onclick]," +
        "button:enabled,input:enabled,textarea:enabled,select:enabled," +
        "summary," +
        "[onclick]:not(:disabled),[tabindex]:not(:disabled)," +
        '[contenteditable]:not([contenteditable="false"]),audio[controls],video[controls],' +
        "[role=button i],[role=combobox i],[role=link i],[role=menuitem i],[role=menuitemradio i]," +
        "[role=menuitemcheckbox i],[role=option i],[role=radio i],[role=checkbox i],[role=tab i]," +
        "[role=switch i],[role=textbox i],[role=spinbutton i],[role=slider i],[role=listbox i]," +
        "[role=treeitem i]",
    );
    const deadLabel = !!labelEl && noNativeActivation && !interactiveAncestor;
    return {
      hit: { tag, attrs, cls, text, ref },
      // <html>/<body> means the point is over page background — nothing
      // interactive there, which is almost always a miss worth flagging.
      bare: tag === "html" || tag === "body",
      deadLabel,
      viewport: [vw, vh],
    };
  }

  // --- Get element coordinates for ref ---
  function getRefCoordinates(refId: string, opts: { scrollIntoView?: boolean } = {}): RefCoordinates | null {
    const el = resolveRef(refId);
    if (!el) return null;

    // Bring the element into view before reading its position.
    //
    // Coordinates are viewport-relative, so an element scrolled out of view has
    // coordinates that cannot be clicked at all: the dispatch lands on the
    // document root instead. That is not a reporting problem, it is a targeting
    // one — the caller named an element, and the element is reachable, it just
    // is not on screen yet. Scrolling first is what a person does, and what
    // Playwright/Puppeteer do before every click, so the click lands on what
    // was actually asked for.
    //
    // block/inline "center" (rather than the default "start") keeps the element
    // clear of sticky headers and footers, which are a common way for a
    // technically-in-viewport element to still be covered.
    let scrolledFrom: [number, number] | null = null;
    if (opts.scrollIntoView !== false) {
      const r = el.getBoundingClientRect();
      const off = r.left < 0 || r.top < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight;
      if (off) {
        // Remember where it was, so the caller can record that a scroll
        // happened. A move this large silently changing the coordinates is
        // exactly the kind of thing a debug log has to show.
        scrolledFrom = [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
        try {
          el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        } catch {
          el.scrollIntoView(true);
        }
      }
    }

    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    // Report what is actually at the resulting point, so the caller learns when
    // something else (an overlay, a sticky bar) will receive the click. That
    // case is NOT auto-corrected: a person clicking there would hit the overlay
    // too, so silently clicking through it would be the unfaithful choice.
    let covering: string | null = null;
    if (x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight) {
      const at = document.elementFromPoint(x, y);
      // An element's own <label> sitting over it forwards the click, so it is
      // not in the way. Styled checkboxes are built exactly like that.
      const label = at?.closest("label");
      const ownLabel = label && (label.control === el || label.contains(el));
      if (at && at !== el && !el.contains(at) && !at.contains(el) && !ownLabel) {
        covering = describeBrief(at);
      }
    }
    return {
      x,
      y,
      reachable: x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight,
      covering,
      scrolledFrom,
    };
  }

  function describeBrief(el: Element): string {
    const id = el.id ? `#${el.id}` : "";
    const cls =
      typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/)[0] : "";
    const t = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
    return `<${el.tagName.toLowerCase()}${id}${cls}>${t ? ` "${t}"` : ""}`;
  }

  // --- Message handler ---
  // background.ts sends these; types/globals.d.ts declares each request and its answer.
  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse: (response: unknown) => void) => {
    const msg = raw as ContentRequest;
    if (msg.type === "generateAccessibilityTree") {
      const result = generateAccessibilityTree(msg.options || {});
      sendResponse({ result });
      return true;
    }

    if (msg.type === "jevGuard") {
      sendResponse({ result: jevGuard(msg.ref, msg.expect || {}) });
      return true;
    }

    if (msg.type === "jevSettle") {
      void settleFrames(msg.mode, msg.ref, msg.timeoutMs || 50).then((result) => sendResponse({ result }));
      return true;
    }

    if (msg.type === "jevSnapshot") {
      sendResponse({ result: jevSnapshot(msg.options || {}) });
      return true;
    }

    if (msg.type === "getPageText") {
      const result = getPageText();
      sendResponse({ result });
      return true;
    }

    if (msg.type === "findElements") {
      const result = findElements(msg.query);
      sendResponse({ result });
      return true;
    }

    if (msg.type === "setFormValue") {
      const result = setFormValue(msg.ref, msg.value);
      sendResponse({ result });
      return true;
    }

    if (msg.type === "describePoint") {
      sendResponse({ result: describePoint(msg.x, msg.y) });
      return true;
    }

    if (msg.type === "getRefCoordinates") {
      const result = getRefCoordinates(msg.ref, { scrollIntoView: msg.scrollIntoView });
      sendResponse({ result });
      return true;
    }

    // Resolve a ref in THIS (isolated) world — where resolveRef/elementMap live —
    // and stamp a DOM attribute on the element so the background page can find it
    // via CDP. CDP Runtime.evaluate runs in the page's MAIN world and cannot see
    // window.__unblockedChrome, so a main-world resolveRef always returns null;
    // the DOM is shared across worlds, so an attribute set here IS visible to CDP.
    // Used by file_upload / upload_image to reach a (possibly hidden) file input.
    if (msg.type === "markElementForUpload") {
      const el = resolveRef(msg.ref);
      if (!el) {
        sendResponse({ ok: false });
        return true;
      }
      const isFileInput = el.tagName.toLowerCase() === "input" && str(el.type).toLowerCase() === "file";
      try {
        el.setAttribute("data-ocic-upload-target", "1");
      } catch {}
      try {
        el.scrollIntoView({ block: "center", behavior: "instant" });
      } catch {}
      sendResponse({ ok: true, isFileInput, tag: el.tagName.toLowerCase() });
      return true;
    }

    if (msg.type === "unmarkElementForUpload") {
      try {
        document
          .querySelectorAll("[data-ocic-upload-target]")
          .forEach((e) => e.removeAttribute("data-ocic-upload-target"));
      } catch {}
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });

  // Expose globally for executeScript fallback
  window.__unblockedChrome = {
    describePoint,
    generateAccessibilityTree,
    jevSnapshot,
    settleFrames,
    jevGuard,
    getPageText,
    findElements,
    setFormValue,
    getRefCoordinates,
    resolveRef,
    elementMap,
  };
})();
