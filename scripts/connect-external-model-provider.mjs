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
import { loadCompiledWorkspaceModule } from "./lib/compiled-workspace-module.mjs";
import {
  connectExternalModelProvider,
  externalModelProviderAccount,
  ExternalModelProviderInstallError,
} from "./lib/external-model-provider-install.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_INPUT_BYTES = 1024 * 1024;
const usage = [
  "Usage:",
  "  node scripts/connect-external-model-provider.mjs --input FILE [--config FILE]",
  "",
  "Registers one Cloudflare AI Gateway Custom Provider and attaches one existing",
  "Secrets Store secret reference to eliotr-reasoning. It does not accept a raw",
  "provider key, create/rotate a secret, create a Dynamic Route or call a model.",
  "Auth: set ELIOTR_CLOUDFLARE_AUTH_MODE=wrangler-oauth for the verified",
  "browser profile, or leave it unset and provide CLOUDFLARE_ACCOUNT_ID plus",
  "CLOUDFLARE_API_TOKEN in the process environment. Tokens never enter input.",
  "After this succeeds, use plan-research-model-route.mjs and",
  "install-research-model-authority.mjs for route preparation/qualification/promotion.",
  "",
  "Input: { protocol: \"eliotr.external-model-provider.v1\", custom_provider:",
  "  { protocol: \"eliotr.custom-provider.v1\", name, slug, base_url, enable, beta },",
  "  provider_config: { protocol: \"eliotr.provider-config.v1\",",
  "    provider_slug: \"custom-<slug>\", alias, default_config },",
  "  secret_reference: { secret_id,",
  "    secret_name: \"eliotr-reasoning_custom-<slug>_<alias>\" } }",
].join("\n");

class CliError extends Error {
  constructor(message, code = "EXTERNAL_MODEL_PROVIDER_CLI_INVALID") {
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
    : "EXTERNAL_MODEL_PROVIDER_FAILED";
  if (error instanceof CliError || error instanceof ExternalModelProviderInstallError) {
    return `${code}: ${error.message}`;
  }
  if (/^(?:CUSTOM_PROVIDER|PROVIDER_CONFIG|EXTERNAL_MODEL_PROVIDER)_/u.test(code)) {
    return `${code}: external model provider operation failed`;
  }
  return `${code}: external model provider connection failed`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const [input, config, cloudflareAi] = await Promise.all([
    readJsonFile(options.inputPath, "external model provider input"),
    readJsonFile(options.configPath, "Wrangler config"),
    loadCompiledWorkspaceModule("packages/cloudflare-ai/dist/index.js"),
  ]);
  const accountId = externalModelProviderAccount(config);
  const bearer = await readCloudflareBearer(accountId);
  const receipt = await connectExternalModelProvider({
    cloudflareAi,
    input,
    accountId,
    bearer,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

try { await main(); }
catch (error) {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 2;
}
