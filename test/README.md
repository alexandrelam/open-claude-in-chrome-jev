# Tests

Plain Node, no framework, no dependencies. Node runs the TypeScript directly.
Run them all, with the host tests, from the repository root:

```bash
npm test
```

| File | Covers |
|---|---|
| `humanize-planners.test.ts` | The pure planners in `extension/humanize/`. Asserts the invariants that make humanization safe: a click always lands exactly on its target (including 8×8px targets), typed text reassembles byte-identically (incl. unicode/emoji), scroll deltas sum to exactly the requested amount, key hold stays below the OS typematic initial delay, and a deliberate long hold renders the real auto-repeat sequence. |
| `humanize-executor.test.ts` | The plan→CDP seam: runs the shipped `dispatchPlan` against a mock CDP layer and asserts the exact calls, their order (`keydown → insertText → keyup` per character), and per-tab cursor continuity. This is the layer that caught the missing shifted-digit key mappings. |
| `handlers.test.ts` | Tool handlers against a mocked `chrome.*` API: that creating a tab never selects it or raises a window (#28), that `set_tab_focus` is quiet unless `focus_window` is set (#35), and the layered default/per-tab config with its storage scoping. |

`_extract.ts` pulls the functions under test out of `extension/background.ts` by
brace-matching, and strips their types with Node's `stripTypeScriptTypes`. That
indirection is deliberate: `background.ts` is a service
worker with no exports whose top level touches `chrome.*` immediately, so this
lets the tests exercise the shipped source instead of a copy that could drift.
