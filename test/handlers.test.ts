// Handler-level tests for #28 (no focus stealing) and #35 (set_tab_focus),
// running the SHIPPED handler bodies against a mocked chrome.* API. Covers the
// logic a browser test would cover, minus the browser.
import { extractMethod, extractFunction, compile } from "./_extract.ts";
import { errorMessage } from "../extension/errors.ts";
import type { ToolArgsMap, ToolResult } from "../extension/tool-types.ts";
let fail = 0;
const ok = (c: unknown, m: string) => {
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) fail++;
};

interface MockTab {
  id: number;
  windowId: number;
  active: boolean;
  groupId?: number;
}
interface State {
  tabs: MockTab[];
  groupId: number;
  curWin: number;
  focusedWin: number;
  local: Record<string, unknown>;
  session: Record<string, unknown>;
}
interface Call {
  name: string;
  arg: { [key: string]: unknown };
}

const api: Call[] = []; // every chrome.* call, in order
function mkChrome(state: State) {
  const rec = (name: string, arg: unknown) => api.push({ name, arg: arg as Call["arg"] });
  return {
    tabs: {
      create: async (o: { windowId?: number; active?: boolean }) => {
        rec("tabs.create", o);
        const t = { id: 999, windowId: o.windowId ?? state.curWin, active: !!o.active };
        state.tabs.push(t);
        return t;
      },
      group: async (o: unknown) => {
        rec("tabs.group", o);
        return state.groupId;
      },
      query: async (q: { groupId?: number }) => {
        rec("tabs.query", q);
        return state.tabs.filter((t) => t.groupId === state.groupId || q.groupId === undefined);
      },
      get: async (id: number) => {
        rec("tabs.get", id);
        const found = state.tabs.find((t) => t.id === id);
        if (!found) throw new Error("no tab");
        return found;
      },
      update: async (id: number, o: { active?: boolean }) => {
        rec("tabs.update", { id, ...o });
        const found = state.tabs.find((t) => t.id === id);
        if (found && o.active !== undefined) found.active = o.active;
        return found;
      },
    },
    windows: {
      update: async (id: number, o: { focused?: boolean }) => {
        rec("windows.update", { id, ...o });
        state.focusedWin = o.focused ? id : state.focusedWin;
      },
    },
    tabGroups: { update: async () => {}, get: async () => ({ id: state.groupId, title: "MCP" }) },
    storage: {
      local: {
        get: async () => ({}),
        set: async (v: Record<string, unknown>) => {
          rec("storage.local.set", Object.keys(v));
          Object.assign(state.local, v);
        },
      },
      session: {
        get: async () => ({}),
        set: async (v: Record<string, unknown>) => {
          rec("storage.session.set", Object.keys(v));
          Object.assign(state.session, v);
        },
      },
    },
  };
}

const state: State = {
  tabs: [{ id: 100, windowId: 7, active: true, groupId: 55 }],
  groupId: 55,
  curWin: 1,
  focusedWin: 1,
  local: {},
  session: {},
};
const chromeMock = mkChrome(state);

// deps the handlers close over
let tabGroupId = 55;
let tabGroupTabs = new Set([100]);
const isInGroup = async (id: number) => state.tabs.some((t) => t.id === id);
const ensureTabGroup = async () => {};
const formatTabContext = (tabs: MockTab[]): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ availableTabs: tabs.map((t) => ({ tabId: t.id })) }) }],
});
// The same small helpers background.ts defines, for the handlers that use them.
const textResult = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const firstText = (result: ToolResult) => result.content[0];
const CONFIG_KEY = "ocic_config_v1",
  TAB_CONFIG_KEY = "ocic_tab_config_v1";
const CONFIG_SCHEMA = { humanize: "drive input like a person" };
let configState = { default: { humanize: false, humanize_speed: "fast", humanize_seed: null }, byTab: {} };
const configHydrated = Promise.resolve();
// get_config reports the live humanization persona; give the harness one so the
// handler can be exercised the same way the extension runs it.
let humanSessionSeed: number | null = 12345;
let humanSession = { persona: { speed: 1.02, steadiness: 0.88, overshoot: 1.1, typeTempo: 0.94 } };
// set_config primes the hand so a pinned seed is observable immediately; the
// harness supplies a stand-in that records what it was asked to build.
let primedWith: { speed: unknown; seed: unknown } | null = null;
/** What human() was last asked to build (read through a call, so the checks see the update). */
const lastPrimed = () => primedWith;
const human = (speed: unknown, seed: unknown) => {
  primedWith = { speed, seed };
  humanSessionSeed = typeof seed === "number" ? seed : null;
  return humanSession;
};

const src = [
  ...["tabs_create_mcp", "set_tab_focus", "get_config", "set_config"].map(
    (m) => `const H_${m} = { ${extractMethod(m)} };`,
  ),
  extractFunction("effectiveConfig"),
  extractFunction("writeConfig"),
].join("\n\n");
/** The extracted handlers and config helpers, as background.ts defines them. */
interface Harness {
  H_tabs_create_mcp: { tabs_create_mcp(args: ToolArgsMap["tabs_create_mcp"]): Promise<ToolResult> };
  H_set_tab_focus: { set_tab_focus(args: ToolArgsMap["set_tab_focus"]): Promise<ToolResult> };
  H_get_config: { get_config(args: ToolArgsMap["get_config"]): Promise<ToolResult> };
  H_set_config: { set_config(args: ToolArgsMap["set_config"]): Promise<ToolResult> };
  effectiveConfig(tabId: number): Record<string, unknown>;
  writeConfig(key: string, value: unknown, tabId: number | undefined): Promise<unknown>;
}
const H = compile(
  src,
  {
    chrome: chromeMock,
    tabGroupId,
    tabGroupTabs,
    isInGroup,
    ensureTabGroup,
    formatTabContext,
    textResult,
    firstText,
    errorMessage,
    CONFIG_KEY,
    TAB_CONFIG_KEY,
    CONFIG_SCHEMA,
    configState,
    configHydrated,
    humanSession,
    humanSessionSeed,
    human,
  },
  "{ H_tabs_create_mcp, H_set_tab_focus, H_get_config, H_set_config, effectiveConfig, writeConfig }",
) as Harness;
/** The text of a result's first block. */
const said = (r: ToolResult) => {
  const b = r.content[0];
  return b && b.type === "text" ? b.text : "";
};

console.log("== #28: creating a tab must not select it or steal focus ==");
api.length = 0;
await H.H_tabs_create_mcp.tabs_create_mcp({});
const create = api.find((c) => c.name === "tabs.create");
ok(
  create && create.arg.active === false,
  `tabs.create called with active:false (got ${JSON.stringify(create && create.arg)})`,
);
ok(
  create && create.arg.windowId === 7,
  "new tab created in the MCP group's OWN window, not the operator's focused window",
);
ok(!api.some((c) => c.name === "windows.update"), "no windows.update — never raises a window");
ok(
  !api.some((c) => c.name === "tabs.update" && c.arg.active === true),
  "no tabs.update({active:true}) — never selects the new tab",
);

console.log("== #35: set_tab_focus selects the tab ==");
api.length = 0;
const r1 = await H.H_set_tab_focus.set_tab_focus({ tabId: 100 });
ok(
  api.some((c) => c.name === "tabs.update" && c.arg.active === true),
  "selects the tab in its window",
);
ok(
  !api.some((c) => c.name === "windows.update"),
  "does NOT raise the window when focus_window is omitted (quiet by default)",
);
ok(/active tab/.test(said(r1)), `result explains what happened: "${said(r1)}"`);

console.log("== #35: focus_window:true also raises the window ==");
api.length = 0;
const r2 = await H.H_set_tab_focus.set_tab_focus({ tabId: 100, focus_window: true });
const wu = api.find((c) => c.name === "windows.update");
ok(wu && wu.arg.focused === true, "windows.update({focused:true}) issued");
ok(wu && wu.arg.id === 7, "raises the tab's OWN window (id 7)");
ok(/front/.test(said(r2)), `result mentions raising the window: "${said(r2)}"`);

console.log("== #35: refuses tabs outside the MCP group ==");
const r3 = await H.H_set_tab_focus.set_tab_focus({ tabId: 4242 });
ok(/not in the MCP group/.test(said(r3)), "out-of-group tab rejected");

console.log("== config: default vs per-tab layering ==");
ok(H.effectiveConfig(100).humanize === false, "default humanize is false (opt-in)");
await H.writeConfig("humanize", true, undefined);
ok(H.effectiveConfig(100).humanize === true, "setting the default applies to a tab");
await H.writeConfig("humanize", false, 100);
ok(
  H.effectiveConfig(100).humanize === false && H.effectiveConfig(200).humanize === true,
  "per-tab override wins for tab 100 while tab 200 keeps the default",
);
await H.writeConfig("humanize", null, 100);
ok(H.effectiveConfig(100).humanize === true, "clearing the per-tab override falls back to the default");

console.log("== config: storage scoping ==");
api.length = 0;
await H.writeConfig("humanize", true, undefined);
ok(
  api.some((c) => c.name === "storage.local.set"),
  "default persists to LOCAL storage (survives restart)",
);
api.length = 0;
await H.writeConfig("humanize", true, 100);
ok(
  api.some((c) => c.name === "storage.session.set"),
  "per-tab override persists to SESSION storage (dies with the browser)",
);

console.log("== get_config reports the schema ==");
/** What get_config reports, as far as these checks read it. */
interface ConfigReport {
  recognizedKeys?: Record<string, unknown>;
  effectiveForTab?: { tabId?: unknown };
  activeHand?: { seed?: unknown; typeTempo?: unknown };
}
const g = JSON.parse(said(await H.H_get_config.get_config({ tabId: 100 }))) as ConfigReport;
ok(!!g.recognizedKeys && !!g.recognizedKeys.humanize, "recognizedKeys catalog returned");
ok(!!g.effectiveForTab && g.effectiveForTab.tabId === 100, "effective config reported for the requested tab");
ok(
  !!g.activeHand && g.activeHand.seed === 12345 && typeof g.activeHand.typeTempo === "number",
  "the live humanization hand is reported, so a study can prove it was held constant",
);

console.log("== pinning a seed takes effect immediately, not on the next click ==");
primedWith = null;
const seedRes = await H.H_set_config.set_config({ key: "humanize_seed", value: 4242 });
ok(
  lastPrimed()?.seed === 4242,
  "set_config rebuilds the hand right away (lazy building would leave a pinned seed unobservable until something is clicked)",
);
// The seed VALUE echoed here comes from a module-level variable the real
// extension reassigns inside human(); the harness passes it as a parameter, so
// it cannot model that rebinding. What matters, and what is asserted above, is
// that human() was primed with the new seed. Here we only check the result
// actually reports a built persona rather than staying silent.
ok(
  /Active hand \(seed .+\): \{"speed":/.test(said(seedRes)),
  `the result reports the persona it just built: "${said(seedRes).split("\n").pop()}"`,
);
primedWith = null;
await H.H_set_config.set_config({ key: "nonsense2", value: 1 });
ok(lastPrimed() === null, "an unrelated setting does NOT rebuild the hand");

console.log("== set_config flags unknown keys instead of silently accepting ==");
const sc = await H.H_set_config.set_config({ key: "nonsense", value: 1 });
ok(/not a recognized setting/.test(said(sc)), "unknown key is called out");

console.log(fail === 0 ? "\nALL HANDLER TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
