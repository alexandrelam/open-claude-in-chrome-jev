#!/usr/bin/env node
//
// A bare tool-runtime process, used by ownership.test.ts to stand in for a
// Claude Code session. It does nothing but init() and stay alive, so the test
// can watch a real session join the bridge the native host is serving.

import { init } from "../tool-runtime.ts";

await init();
setInterval(() => {}, 1 << 30);
