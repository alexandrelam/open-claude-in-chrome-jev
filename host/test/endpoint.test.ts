#!/usr/bin/env node
//
// Cross-platform checks for the rendezvous address.
//
// The socket path is the one piece of this that genuinely differs between
// Windows and POSIX, and whichever machine you develop on, half of it never
// runs. So both branches are exercised here by forcing process.platform, which
// catches the failures that would otherwise only show up on someone else's
// laptop — a unix path over the 104-byte sun_path limit, a missing uid, a
// Windows pipe name that picked up a path separator.
//
// Run: node host/test/endpoint.test.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { errorMessage } from "../errors.ts";

// Point HOME at an empty directory before endpoint.ts is imported.
//
// getPipePath() honours a `pipe` override from
// ~/.config/open-claude-in-chrome/config.json ahead of the platform default
// (endpoint.ts L50), and the native host writes that key on a real install. So
// on a developer machine that has actually run the extension, the forced-win32
// branch below would read the POSIX socket path out of the real config and
// fail — a false negative about code that is fine. os.homedir() reads $HOME on
// POSIX and %USERPROFILE% on Windows, so overriding both isolates the test from
// whatever the machine happens to have configured.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-endpoint-test-"));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const results: Array<{ name: string; ok: boolean; err?: string }> = [];
function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: errorMessage(err) });
    console.log(`  FAIL  ${name} — ${errorMessage(err)}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const realPlatform = process.platform;
function asPlatform<T>(p: NodeJS.Platform, fn: () => T): T {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", {
      value: realPlatform,
      configurable: true,
    });
  }
}

// Re-import per platform: the module reads process.platform at call time, not
// import time, so one import is enough — but the cache key must not be reused
// across a mutated env, so env overrides are cleared first.
delete process.env.OCIC_PIPE;
const { getPipePath, socketDir } = await import("../endpoint.ts");

console.log("\nRendezvous address\n");

check("windows: a pipe under \\\\.\\pipe\\, no separators in the name", () => {
  const p = asPlatform("win32", () => getPipePath());
  assert(p.startsWith("\\\\.\\pipe\\"), `not a pipe name: ${p}`);
  const leaf = p.slice("\\\\.\\pipe\\".length);
  assert(leaf.length > 0, "empty pipe name");
  assert(!leaf.includes("\\") && !leaf.includes("/"), `separator in pipe name: ${leaf}`);
});

check("posix: an absolute .sock path inside the socket dir", () => {
  const p = asPlatform("linux", () => getPipePath());
  assert(path.isAbsolute(p), `not absolute: ${p}`);
  assert(p.endsWith(".sock"), `not a socket path: ${p}`);
  const dir = asPlatform("linux", () => socketDir());
  assert(p.startsWith(dir), `socket ${p} is not inside ${dir}`);
});

check("posix: path fits in sun_path (104 bytes) with room to spare", () => {
  // A unix socket path longer than sun_path is silently truncated or refused
  // with ENAMETOOLONG. macOS tmpdir is a long per-user /var/folders/... path,
  // so this is the realistic place for it to break.
  for (const platform of ["linux", "darwin"] as const) {
    const p = asPlatform(platform, () => getPipePath());
    const bytes = Buffer.byteLength(p, "utf8");
    assert(bytes < 104, `${platform}: ${bytes} bytes, over the sun_path limit: ${p}`);
  }
});

check("posix: still fits when tmpdir is a long macOS-style path", () => {
  // Simulate the real shape of a macOS temp dir rather than trusting this
  // machine's short one.
  const realTmp = os.tmpdir;
  os.tmpdir = () => "/var/folders/1x/8m0hpq_x5rz0000gn/T";
  try {
    const p = asPlatform("darwin", () => getPipePath());
    const bytes = Buffer.byteLength(p, "utf8");
    assert(bytes < 104, `${bytes} bytes with a macOS tmpdir: ${p}`);
  } finally {
    os.tmpdir = realTmp;
  }
});

check("both platforms: a username with separators or spaces is sanitised", () => {
  const realUserInfo = os.userInfo;
  // A passwd entry with no uid, as some containers report.
  os.userInfo = (() => ({ username: "DOMAIN\\Some User/x", uid: undefined })) as unknown as typeof os.userInfo;
  try {
    const win = asPlatform("win32", () => getPipePath());
    const leaf = win.slice("\\\\.\\pipe\\".length);
    assert(!/[\\/ ]/.test(leaf), `unsanitised windows pipe name: ${leaf}`);
    const posix = asPlatform("linux", () => getPipePath());
    assert(path.basename(posix) === "bridge.sock", `unexpected posix socket name: ${posix}`);
    // Only the directory segment we generate is ours to sanitise — the tmpdir
    // prefix comes from the OS and on Windows legitimately holds backslashes.
    const dirLeaf = path.basename(asPlatform("linux", () => socketDir()));
    assert(!/[\\/ ]/.test(dirLeaf), `unsanitised socket dir name: ${dirLeaf}`);
  } finally {
    os.userInfo = realUserInfo;
  }
});

check("both platforms: a passwd-less account still resolves an address", () => {
  // os.userInfo() throws, not returns null, when there is no passwd entry —
  // routine in containers. Both sides must still compute the SAME address.
  const realUserInfo = os.userInfo;
  os.userInfo = () => {
    throw new Error("uv_os_get_passwd failed");
  };
  try {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      const a = asPlatform(platform, () => getPipePath());
      const b = asPlatform(platform, () => getPipePath());
      assert(a && a === b, `${platform}: unstable or empty address (${a} vs ${b})`);
    }
  } finally {
    os.userInfo = realUserInfo;
  }
});

check("env override wins on every platform", () => {
  process.env.OCIC_PIPE = "/tmp/scratch-bridge.sock";
  try {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      assert(asPlatform(platform, () => getPipePath()) === "/tmp/scratch-bridge.sock", `${platform} ignored OCIC_PIPE`);
    }
  } finally {
    delete process.env.OCIC_PIPE;
  }
});

try {
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
} catch {}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n",
);
process.exit(failed.length ? 1 : 0);
