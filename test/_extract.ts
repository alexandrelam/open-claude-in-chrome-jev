// Pull a named function or object-method body out of a source file by
// brace-matching, so tests exercise the SHIPPED code in extension/background.ts
// rather than a copy that can drift out of sync with it.
//
// background.ts is a service-worker script: its top level touches chrome.*
// immediately, so it cannot be imported in Node. Extracting the pieces under
// test and injecting their dependencies is what makes it testable. Its types
// are stripped first (Node's own type stripper, which blanks them out in
// place), so what is extracted is the JavaScript that actually ships.

import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BACKGROUND = path.join(ROOT, "extension", "background.ts");

const sources = new Map<string, string>();

/** The file as JavaScript: its type annotations replaced by whitespace. */
function javascriptOf(file: string): string {
  let src = sources.get(file);
  if (src === undefined) {
    src = stripTypeScriptTypes(fs.readFileSync(file, "utf8"), { mode: "strip" });
    sources.set(file, src);
  }
  return src;
}

function matchBraces(src: string, from: number): number {
  let depth = 0;
  const i = src.indexOf("{", from);
  for (let k = i; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  throw new Error("unbalanced braces from index " + from);
}

/** Top-level `function foo(...) {...}` (keeps a leading `async`). */
export function extractFunction(name: string, file = BACKGROUND): string {
  const src = javascriptOf(file);
  let i = src.indexOf(`function ${name}(`);
  if (i === -1) throw new Error(`function ${name} not found in ${file}`);
  if (src.slice(Math.max(0, i - 6), i) === "async ") i -= 6;
  // Past the parameter list: a parameter's default can itself contain braces.
  return src.slice(i, matchBraces(src, src.indexOf(")", i)));
}

/** Object method `async foo(...) {...}`, returned as `async foo(...) {...}`. */
export function extractMethod(name: string, file = BACKGROUND): string {
  const src = javascriptOf(file);
  const i = src.indexOf(`  async ${name}(`);
  if (i === -1) throw new Error(`method ${name} not found in ${file}`);
  return src.slice(i, matchBraces(src, src.indexOf(")", i))).trim();
}

/** Build a callable from extracted source with dependencies injected. */
export function compile(source: string, deps: Record<string, unknown>, returnExpr: string): unknown {
  const names = Object.keys(deps);
  const fn = new Function(...names, `${source}\nreturn ${returnExpr};`) as (...args: unknown[]) => unknown;
  return fn(...names.map((n) => deps[n]));
}
