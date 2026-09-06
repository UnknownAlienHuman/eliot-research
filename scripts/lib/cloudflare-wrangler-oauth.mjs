// Browser-authorized Wrangler OAuth credential seam for deploy/provision ordonnance.
//
// Design: ELIOTR_CLOUDFLARE_AUTH_MODE=wrangler-oauth resolves the short-lived
// bearer from the official Wrangler browser-OAuth profile file, verifies the
// active account via official `wrangler whoami`, and injects the bearer ONLY
// into child-process memory (cloned env). The bearer is never printed,
// interpolated into argv, written to the repo/receipts/logs, or exposed in
// errors. Refresh happens through `wrangler login` (browser); this module
// never creates or stores a persistent API token.
//
// Static CLOUDFLARE_API_TOKEN compatibility remains for CI/non-interactive
// runs (auth mode unset). That path is intentionally not documented here.

import { join } from "node:path";

export const AUTH_MODE_ENV = "ELIOTR_CLOUDFLARE_AUTH_MODE";
export const WRANGLER_OAUTH_MODE = "wrangler-oauth";
export const API_TOKEN_MODE = "api-token";

export const LOGIN_INSTRUCTION =
  "Wrangler browser OAuth is required: run `wrangler login` in a browser, then retry. " +
  "wrangler-oauth never creates or stores a persistent API token.";

const TOKEN_MAX_LENGTH = 4096;
const EXPIRY_SKEW_MS = 60_000;
const PROFILE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export class WranglerOAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WranglerOAuthError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new WranglerOAuthError(code, message);
}

// Auth-mode resolution. Unknown values fail closed before any gate runs.
export function resolveAuthMode(env = process.env) {
  const raw = env?.[AUTH_MODE_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === "") return API_TOKEN_MODE;
  const mode = String(raw).trim();
  if (mode === WRANGLER_OAUTH_MODE) return WRANGLER_OAUTH_MODE;
  if (mode === API_TOKEN_MODE) return API_TOKEN_MODE;
  fail("AUTH_MODE_INVALID", `Unknown ${AUTH_MODE_ENV}=${JSON.stringify(mode)}. Expected ${JSON.stringify(WRANGLER_OAUTH_MODE)} or unset (CI API-token mode).`);
}

function profileName(env) {
  const raw = env?.ELIOTR_WRANGLER_PROFILE ?? env?.WRANGLER_PROFILE ?? "default";
  const profile = String(raw).trim();
  if (!PROFILE_PATTERN.test(profile)) fail("OAUTH_INVALID", `Wrangler profile name is invalid. ${LOGIN_INSTRUCTION}`);
  return profile;
}

// Ordered candidate credential locations. The verified Windows `default`
// location is %APPDATA%/wrangler/config/<profile>.toml.
export function resolveWranglerConfigCandidates(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? "";
  const profile = options.profile ?? profileName(env);
  if (!PROFILE_PATTERN.test(profile)) fail("OAUTH_INVALID", `Wrangler profile name is invalid. ${LOGIN_INSTRUCTION}`);
  const explicit = env?.ELIOTR_WRANGLER_CONFIG_FILE ?? env?.WRANGLER_CONFIG_FILE;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== "") {
    return [String(explicit).trim()];
  }
  const fileName = `${profile}.toml`;
  if (env?.WRANGLER_HOME !== undefined && String(env.WRANGLER_HOME).trim() !== "") {
    return [join(String(env.WRANGLER_HOME).trim(), "config", fileName)];
  }
  if (platform === "win32") {
    const appData = options.appData ?? env.APPDATA ?? (home ? join(home, "AppData", "Roaming") : "");
    if (!appData) fail("OAUTH_UNAVAILABLE", `Wrangler config location cannot be resolved on Windows. ${LOGIN_INSTRUCTION}`);
    return [join(appData, "wrangler", "config", fileName)];
  }
  const xdg = options.xdgConfigHome ?? env.XDG_CONFIG_HOME ?? (home ? join(home, ".config") : "");
  const candidates = [];
  if (xdg) candidates.push(join(xdg, "wrangler", "config", fileName));
  if (home) candidates.push(join(home, ".wrangler", "config", fileName));
  if (candidates.length === 0) {
    fail("OAUTH_UNAVAILABLE", `Wrangler config location cannot be resolved. ${LOGIN_INSTRUCTION}`);
  }
  return candidates;
}

// Minimal TOML-subset parser: top-level key = value lines only. Sections and
// comments are ignored. Values support double-quoted, single-quoted literal,
// and integer forms. Anything else fails closed without echoing the value.
function parseTomlValue(raw) {
  if (raw.startsWith('"')) {
    const match = raw.match(/^"((?:[^"\\]|\\.)*)"\s*$/u);
    if (!match) fail("OAUTH_INVALID", `Wrangler OAuth profile is malformed. ${LOGIN_INSTRUCTION}`);
    return match[1].replace(/\\(u[0-9a-fA-F]{4}|.)/gsu, (escape) => {
      if (escape[1] === "u") return String.fromCharCode(parseInt(escape.slice(2), 16));
      const table = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };
      return table[escape[1]] ?? escape[1];
    });
  }
  if (raw.startsWith("'")) {
    const match = raw.match(/^'([^']*)'\s*$/u);
    if (!match) fail("OAUTH_INVALID", `Wrangler OAuth profile is malformed. ${LOGIN_INSTRUCTION}`);
    return match[1];
  }
  if (/^[+-]?\d+\s*$/u.test(raw)) return Number.parseInt(raw.trim(), 10);
  fail("OAUTH_INVALID", `Wrangler OAuth profile is malformed. ${LOGIN_INSTRUCTION}`);
}

export function parseWranglerOAuthConfig(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 64 * 1024) {
    fail("OAUTH_INVALID", `Wrangler OAuth profile is malformed. ${LOGIN_INSTRUCTION}`);
  }
  const fields = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.+?)\s*(?:#.*)?$/u);
    if (!match) fail("OAUTH_INVALID", `Wrangler OAuth profile is malformed. ${LOGIN_INSTRUCTION}`);
    fields.set(match[1], parseTomlValue(match[2]));
  }
  const token = fields.get("oauth_token");
  if (typeof token !== "string" || token.length < 1 || token.length > TOKEN_MAX_LENGTH || /[\r\n]/u.test(token)) {
    fail("OAUTH_INVALID", `Wrangler OAuth profile has no usable oauth_token. ${LOGIN_INSTRUCTION}`);
  }
  const refresh = fields.get("refresh_token");
  if (refresh !== undefined && (typeof refresh !== "string" || refresh.length > TOKEN_MAX_LENGTH || /[\r\n]/u.test(refresh))) {
    fail("OAUTH_INVALID", `Wrangler OAuth profile is malformed. ${LOGIN_INSTRUCTION}`);
  }
  return { oauthToken: token, refreshToken: refresh ?? null, expiration: fields.get("expiration_time") ?? null };
}

function expirationToMs(expiration) {
  if (expiration === null || expiration === undefined) return null;
  if (typeof expiration === "number" && Number.isFinite(expiration)) {
    return expiration > 1e12 ? Math.trunc(expiration) : Math.trunc(expiration * 1000);
  }
  if (typeof expiration === "string" && expiration.trim() !== "") {
    const parsed = Date.parse(expiration.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Local-only credential load: file reads plus clock comparison. No network,
// no logging, no token material in errors.
export async function loadWranglerOAuthCredential(options = {}) {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? (await import("node:fs/promises")).readFile;
  const now = options.now ?? Date.now();
  const candidates = options.configPaths ?? resolveWranglerConfigCandidates({ env });
  const tried = [];
  for (const configPath of candidates) {
    let text;
    try {
      text = await readFile(configPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") { tried.push(configPath); continue; }
      fail("OAUTH_UNAVAILABLE", `Wrangler OAuth profile at ${configPath} cannot be read (${error?.code ?? "error"}). ${LOGIN_INSTRUCTION}`);
    }
    const parsed = parseWranglerOAuthConfig(String(text));
    const expiresAtMs = expirationToMs(parsed.expiration);
    if (expiresAtMs === null || !(expiresAtMs - EXPIRY_SKEW_MS > now)) {
      fail("OAUTH_EXPIRED", `Wrangler OAuth token is expired or has no usable expiration (profile at ${configPath}). Run \`wrangler login\` in a browser, then retry.`);
    }
    return { bearer: parsed.oauthToken, expiresAtMs, configPath, hasRefreshToken: parsed.refreshToken !== null };
  }
  fail("OAUTH_UNAVAILABLE", `Wrangler OAuth profile not found${tried.length > 0 ? ` at ${tried[0]}` : ""}. ${LOGIN_INSTRUCTION}`);
}

// Verify the active official profile matches the deployment account.
// getWhoamiOutput must return stdout of `wrangler whoami` run WITHOUT any
// injected API token so the profile itself (not the bearer) is verified.
//
// Structural identity: the ACTIVE account identifier is extracted with strict
// patterns matching Wrangler's documented `whoami` shape
// (`Account <id> via browser OAuth`, the `account <id> active` seam shape,
// `id <id> ok`, or a single unambiguous 32-hex account token under an
// `Account ID` table header). Exact equality with the expected account is
// required. Substring presence is never sufficient: an expected ID mentioned
// in unrelated text, a query/fragment-style token, multiple distinct IDs, or
// unparseable output all fail closed with OAUTH_ACCOUNT_MISMATCH.
const WHOAMI_ACTIVE_PATTERNS = [
  /Account\s+([A-Za-z0-9_-]+)\s+via\s+browser\s+OAuth/u,
  /account\s+([A-Za-z0-9_-]+)\s+active/u,
  /\bid\s+([A-Za-z0-9_-]+)\s+ok\b/u,
];

export function extractActiveAccountId(output) {
  if (typeof output !== "string" || output === "") return null;
  const candidates = [];
  for (const pattern of WHOAMI_ACTIVE_PATTERNS) {
    const global = new RegExp(pattern.source, `${pattern.flags.includes("g") ? "" : "g"}${pattern.flags}`);
    for (const match of output.matchAll(global)) {
      if (typeof match[1] === "string" && match[1] !== "") candidates.push(match[1]);
    }
  }
  if (/Account ID/u.test(output)) {
    const tokens = output.match(/\b[0-9a-fA-F]{32}\b/gu) ?? [];
    for (const token of tokens) candidates.push(token);
  }
  if (candidates.length === 0) return null;
  if (new Set(candidates).size !== 1) return null;
  return candidates[0];
}
export async function verifyWranglerOAuthAccount(options = {}) {
  const expectedAccountId = options.expectedAccountId;
  if (typeof expectedAccountId !== "string" || expectedAccountId.trim() === "") {
    fail("OAUTH_INVALID", `Expected Cloudflare account is missing. ${LOGIN_INSTRUCTION}`);
  }
  let output;
  try {
    output = await options.getWhoamiOutput();
  } catch (error) {
    if (error instanceof WranglerOAuthError) throw error;
    fail("OAUTH_UNAVAILABLE", `Wrangler verification (wrangler whoami) failed. ${LOGIN_INSTRUCTION}`);
  }
  if (typeof output !== "string" || extractActiveAccountId(output) !== expectedAccountId) {
    fail("OAUTH_ACCOUNT_MISMATCH", `Wrangler OAuth account mismatch: the active browser profile does not match account ${JSON.stringify(expectedAccountId)}. Run \`wrangler login\` with the correct account, then retry.`);
  }
  return { accountId: expectedAccountId };
}

// Child-process memory injection only. Returns a cloned env; the caller must
// never log it, spread it into argv, or persist it.
export function injectOAuthBearer(env, bearer) {
  if (typeof bearer !== "string" || bearer.length < 1) {
    fail("OAUTH_INVALID", `Wrangler OAuth bearer is unavailable. ${LOGIN_INSTRUCTION}`);
  }
  return { ...env, CLOUDFLARE_API_TOKEN: bearer };
}

// Scrubbed env for official-profile verification: whoami must authenticate
// via the browser-OAuth profile file, never via an injected token.
export function scrubTokenEnv(env = {}) {
  const scrubbed = { ...env };
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CLOUDFLARE_TOKEN"]) {
    delete scrubbed[key];
  }
  return scrubbed;
}
