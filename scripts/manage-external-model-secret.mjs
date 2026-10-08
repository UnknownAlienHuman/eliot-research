#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOGIN_INSTRUCTION,
  loadWranglerOAuthCredential,
  resolveAuthMode,
  scrubTokenEnv,
  verifyWranglerOAuthAccount,
  WRANGLER_OAUTH_MODE,
} from "./lib/cloudflare-wrangler-oauth.mjs";
import {
  externalModelProviderAccount,
} from "./lib/external-model-provider-install.mjs";
import {
  ExternalModelSecretStoreError,
  manageExternalModelSecret,
} from "./lib/external-model-secret-store.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_SECRET_BYTES = 65_536;
const usage = [
  "Usage:",
  "  printf %s \"$PROVIDER_API_KEY\" | node scripts/manage-external-model-secret.mjs --input FILE [--config FILE]",
  "",
  "Creates or rotates the ai_gateway-scoped Secrets Store key used by one external",
  "model provider. The key is read only from non-interactive UTF-8 stdin; it is never",
  "accepted in JSON or argv and is excluded from receipts and errors.",
  "",
  "Input:",
  "  { protocol: \"eliotr.external-model-secret.v1\", operation: \"CREATE\",",
  "    operation_id, provider_slug: \"custom-<slug>\", alias }",
  "  { protocol: \"eliotr.external-model-secret.v1\", operation: \"ROTATE\",",
  "    operation_id, provider_slug: \"custom-<slug>\", alias, secret_id }",
  "",
  "Use a new stable operation_id for each distinct key value. After CREATE, copy",
  "receipt.secret_reference into connect-external-model-provider.mjs input.",
].join("\n");

class CliError extends Error {
  constructor(message, code = "EXTERNAL_MODEL_SECRET_CLI_INVALID") {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

function parseArguments(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return Object.freeze({ help: true });
  }
  let inputPath;
  let configPath = "apps/eliotr-core/wrangler.deploy.jsonc";
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== "--input" && option !== "--config") {
      throw new CliError(`unknown option ${option}; use --help`);
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new CliError(`${option} requires a value`);
    }
    if (option === "--input") inputPath = value;
    else configPath = value;
    index += 1;
  }
  if (inputPath === undefined) throw new CliError("--input is required");
  return Object.freeze({
    help: false,
    inputPath: resolve(repositoryRoot, inputPath),
    configPath: resolve(repositoryRoot, configPath),
  });
}

async function readJsonFile(path, label) {
  let bytes;
  try { bytes = await readFile(path); }
  catch { throw new CliError(`${label} cannot be read`); }
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new CliError(`${label} exceeds 1 MiB`);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new CliError(`${label} is not valid UTF-8`); }
  try {
    const value = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new CliError(`${label} must contain one JSON object`);
    }
    return value;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`${label} is not valid JSON`);
  }
}

async function readSecretStdin() {
  if (process.stdin.isTTY) {
    throw new CliError("provider key must be piped through non-interactive stdin");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_SECRET_BYTES) {
      throw new CliError("provider key exceeds 65536 UTF-8 bytes");
    }
    chunks.push(bytes);
  }
  let value;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new CliError("provider key is not valid UTF-8"); }
  if (value.length === 0) throw new CliError("provider key is empty");
  return value;
}

async function readCloudflareBearer(accountId) {
  let mode;
  try { mode = resolveAuthMode(process.env); }
  catch (error) {
    throw new CliError(error?.message ?? "Cloudflare authentication mode is invalid", "AUTH_MODE_INVALID");
  }
  if (mode !== WRANGLER_OAUTH_MODE) {
    if (process.env.CLOUDFLARE_ACCOUNT_ID !== accountId) {
      throw new CliError(
        "CLOUDFLARE_ACCOUNT_ID must equal the generated Wrangler account",
        "CLOUDFLARE_ACCOUNT_MISMATCH",
      );
    }
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (typeof token !== "string" || token.length < 1 || token.length > 4096 ||
        token !== token.trim() || /\s/u.test(token) || token.toLowerCase().startsWith("bearer")) {
      throw new CliError(
        "CLOUDFLARE_API_TOKEN is required and invalid",
        "CLOUDFLARE_API_TOKEN_INVALID",
      );
    }
    return token;
  }

  const env = { ...process.env, ELIOTR_CLOUDFLARE_AUTH_MODE: WRANGLER_OAUTH_MODE };
  const scrubbed = scrubTokenEnv(env);
  const result = spawnSync("pnpm", ["exec", "wrangler", "whoami"], {
    cwd: repositoryRoot,
    env: scrubbed,
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new CliError(
      "Wrangler browser OAuth account verification failed",
      "WRANGLER_OAUTH_UNAVAILABLE",
    );
  }
  try {
    await verifyWranglerOAuthAccount({
      expectedAccountId: accountId,
      getWhoamiOutput: async () => result.stdout ?? "",
    });
  } catch (error) {
    throw new CliError(
      error?.message ?? "Wrangler browser OAuth account mismatch",
      "WRANGLER_OAUTH_ACCOUNT_MISMATCH",
    );
  }
  try { return (await loadWranglerOAuthCredential({ env, now: Date.now() })).bearer; }
  catch (error) {
    throw new CliError(error?.message ?? LOGIN_INSTRUCTION, "WRANGLER_OAUTH_UNAVAILABLE");
  }
}

function safeError(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(error.code)
    ? error.code
    : "EXTERNAL_MODEL_SECRET_FAILED";
  if (error instanceof CliError || error instanceof ExternalModelSecretStoreError) {
    return `${code}: ${error.message}`;
  }
  return `${code}: external model secret operation failed`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const [input, config, value] = await Promise.all([
    readJsonFile(options.inputPath, "external model secret input"),
    readJsonFile(options.configPath, "Wrangler config"),
    readSecretStdin(),
  ]);
  const accountId = externalModelProviderAccount(config);
  const token = await readCloudflareBearer(accountId);
  const receipt = await manageExternalModelSecret({
    input,
    secretValue: value,
    accountId,
    bearer: token,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

try { await main(); }
catch (error) {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 2;
}
