// Resolved configuration for the Jev decision layer.
//
// Three sources, highest first: process.env, the `jev` object in
// ~/.config/open-claude-in-chrome/config.json, then the defaults below. The
// config file is read with the same tolerance as host/endpoint.ts — any failure
// yields {}, because a malformed config should degrade the Jev tools, not stop
// the 26 passthrough tools from coming up.
//
// Deliberately NOT wired into the get_config/set_config catalog: that catalog
// is CONFIG_SCHEMA in extension/background.ts, and this feature ships without
// touching the extension.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { JevConfig } from "./types.ts";

/** The `jev` object of config.json, as a user may have written it. */
interface JevFileConfig {
  provider?: string;
  typesafe_api_key?: string;
  openrouter_api_key?: string;
  typesafe_base_url?: string;
  openrouter_base_url?: string;
  model?: string;
  max_steps?: unknown;
  max_ms?: unknown;
  min_confidence?: unknown;
  max_rows?: unknown;
  budget_usd?: unknown;
  sensitive_threshold?: unknown;
  allowed_domains?: unknown;
  blocked_domains?: unknown;
}

export interface ConfigFile {
  jev?: JevFileConfig;
  [key: string]: unknown;
}

export const CONFIG_DIR = path.join(os.homedir(), ".config", "open-claude-in-chrome");

export function readConfigFile(): ConfigFile {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "config.json"), "utf-8")) as ConfigFile;
  } catch {
    return {};
  }
}

const DEFAULTS: {
  provider: string;
  openrouter_base_url: string;
  typesafe_base_url: string;
  model: string;
  max_steps: number;
  max_ms: number;
  min_confidence: number;
  max_rows: number;
  budget_usd: number;
  sensitive_threshold: number;
  allowed_domains: string[] | null;
  blocked_domains: string[];
} = {
  provider: "openrouter",
  openrouter_base_url: "https://openrouter.ai/api/alpha",
  typesafe_base_url: "https://api.typesafe.ai/v1",
  // ~typesafe/jev-latest tracks the newest release and can move under us; the
  // resolved id is written into every run trace so a silent bump is visible
  // after the fact. Pin a versioned slug (typesafe/jev-1.13) in production.
  model: "~typesafe/jev-latest",
  max_steps: 20,
  max_ms: 60_000,
  min_confidence: 0.6,
  // The row count at which shortlisting kicks in. The token estimate against
  // Jev's 32k window is meant to be the real gate; this is a secondary cap on
  // how many options one Choice question should carry.
  //
  // Measured on a full Wikipedia article (2026-09-25): 401 usable rows
  // serialized to 1,142 tokens — 3.6% of the window. At 120 this cap bound
  // ~28x earlier than the token budget, cutting 281 rows that would have fit
  // comfortably and forcing the extra scoring round trip, which made that page
  // 3x slower and 7x more expensive than a single request.
  //
  // The provider caps a Choice at 255 options (MAX_CHOICES), so that — not the
  // token budget — is the real ceiling for the target question. 240 leaves a
  // little headroom under it. A page bigger than this still gets shortlisted,
  // which is correct: past a couple of hundred options probability mass spreads
  // thin enough that the min_confidence gate starts firing anyway.
  max_rows: 240,
  budget_usd: 0.5,
  sensitive_threshold: 0.5,
  allowed_domains: null,
  blocked_domains: [],
};

// Hard ceiling from the PRD: a caller may lower max_steps, never raise it past
// this. Runaway loops on someone's logged-in banking tab are the failure mode
// that matters, so the cap is not configurable.
export const MAX_STEPS_CEILING = 50;

// A hard provider limit, not a preference: the Decisions API rejects a Choice
// question with more than 255 options ("Too many choices. Must have at most 255
// choices.", HTTP 400). Found by exceeding it against the live API on
// 2026-09-25; it is not in the published docs. max_rows is clamped to it, so a
// user raising JEV_MAX_ROWS gets a smaller action space rather than a 400.
export const MAX_CHOICES = 255;

function num(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function list<F>(raw: unknown, fallback: F): string[] | F {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string" && raw.trim())
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return fallback;
}

/**
 * Resolve the effective Jev config. `env` and `file` are injectable so the
 * tests can exercise precedence without touching the real environment.
 */
export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  file: ConfigFile | null = readConfigFile(),
): JevConfig {
  const j: JevFileConfig = (file && typeof file.jev === "object" && file.jev) || {};
  const provider = env.JEV_PROVIDER || j.provider || DEFAULTS.provider;

  return {
    provider,
    apiKey:
      provider === "typesafe"
        ? env.TYPESAFE_API_KEY || j.typesafe_api_key || ""
        : env.OPENROUTER_API_KEY || j.openrouter_api_key || "",
    baseUrl:
      provider === "typesafe"
        ? env.TYPESAFE_BASE_URL || j.typesafe_base_url || DEFAULTS.typesafe_base_url
        : env.OPENROUTER_BASE_URL || j.openrouter_base_url || DEFAULTS.openrouter_base_url,
    model: env.JEV_MODEL || j.model || DEFAULTS.model,
    maxSteps: Math.min(num(env.JEV_MAX_STEPS, num(j.max_steps, DEFAULTS.max_steps)), MAX_STEPS_CEILING),
    maxMs: num(env.JEV_MAX_MS, num(j.max_ms, DEFAULTS.max_ms)),
    minConfidence: num(env.JEV_MIN_CONFIDENCE, num(j.min_confidence, DEFAULTS.min_confidence)),
    maxRows: Math.min(num(env.JEV_MAX_ROWS, num(j.max_rows, DEFAULTS.max_rows)), MAX_CHOICES),
    budgetUsd: num(env.JEV_BUDGET_USD, num(j.budget_usd, DEFAULTS.budget_usd)),
    sensitiveThreshold: num(env.JEV_SENSITIVE_THRESHOLD, num(j.sensitive_threshold, DEFAULTS.sensitive_threshold)),
    // null means "no allowlist" — every domain is permitted. An empty ARRAY is
    // a different thing and permits nothing, so don't collapse the two.
    allowedDomains: list(env.JEV_ALLOWED_DOMAINS, list(j.allowed_domains, DEFAULTS.allowed_domains)),
    blockedDomains: list(env.JEV_BLOCKED_DOMAINS, list(j.blocked_domains, DEFAULTS.blocked_domains)),
    tracesDir: path.join(CONFIG_DIR, "jev-runs"),
  };
}

/** Why the Jev tools can't run, or null if they can. */
export function configError(cfg: Pick<JevConfig, "apiKey" | "provider">): string | null {
  if (!cfg.apiKey) {
    const key = cfg.provider === "typesafe" ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY";
    return `${key} is not set. The Jev tools need it; the other tools on this server work without it. Set it in the MCP server's env, or put "jev": { "${key.toLowerCase()}": "..." } in ~/.config/open-claude-in-chrome/config.json.`;
  }
  return null;
}
