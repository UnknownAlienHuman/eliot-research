#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOGIN_INSTRUCTION,
  loadWranglerOAuthCredential,
  scrubTokenEnv,
  verifyWranglerOAuthAccount,
  WRANGLER_OAUTH_MODE,
} from "./lib/cloudflare-wrangler-oauth.mjs";
import { createCloudflareD1HttpDatabase } from "./lib/cloudflare-d1-http.mjs";
import { loadCompiledWorkspaceModule } from "./lib/compiled-workspace-module.mjs";
import { GatewayBrowserOAuthError, readGatewayBrowserOAuthBearer } from "./lib/cloudflare-gateway-browser-oauth.mjs";
import {
  ResearchQualificationRuntimeError,
  withResearchQualificationRuntime,
} from "./lib/research-qualification-runtime.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_INPUT_BYTES = 1024 * 1024;
const ACCOUNT_ID = /^[a-f0-9]{32}$/iu;
const usage = [
  "Usage:",
  "  node scripts/install-research-model-authority.mjs prepare --input FILE [--config FILE]",
  "  node scripts/install-research-model-authority.mjs install --input FILE [--config FILE]",
  "  node scripts/install-research-model-authority.mjs adopt --input PLAN.json --provider-route-id ID [--config FILE] [--gateway-oauth-client-id ID]",
  "  node scripts/install-research-model-authority.mjs qualify --input REQUEST.json [--config FILE] [--gateway-oauth-client-id ID]",
  "",
  "prepare provisions the explicit route and pricing snapshot, without promotion.",
  "install requires the same explicit request plus independently verified LIVE qualification.",
  "adopt binds an already deployed dashboard route by live API readback; it does not call a model or approve pricing.",
  "qualify performs one observed model qualification against the prepared route; it does not install or promote.",
  "Cloudflare account and CORE_DB are read from the generated Wrangler config; auth uses Wrangler browser OAuth.",
  "If Wrangler lacks AI Gateway Read, adopt and qualify accept a private PKCE client ID; its callback is http://127.0.0.1:8977/oauth/callback.",
  "Use account-private visibility, Authorization Code and token authentication None (PKCE); no client secret.",
  "The optional gateway OAuth credential stays in memory; D1 still uses the existing Wrangler session.",
].join("\n");

class InstallerCliError extends Error {
  constructor(message, code = "MODEL_AUTHORITY_INSTALL_INPUT_INVALID") {
    super(message);
    this.name = "InstallerCliError";
    this.code = code;
  }
}

function plainObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InstallerCliError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InstallerCliError(`${label} must be a plain object`);
  }
  return value;
}

function parseArguments(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return Object.freeze({ help: true });
  }
  const command = argv[0];
  if (command !== "prepare" && command !== "install" && command !== "adopt" && command !== "qualify") {
    throw new InstallerCliError("command must be prepare, install, adopt or qualify; use --help");
  }
  let inputPath;
  let providerRouteId;
  let gatewayOAuthClientId;
  let configPath = "apps/eliotr-core/wrangler.deploy.jsonc";
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--input" || option === "--config" || option === "--provider-route-id" || option === "--gateway-oauth-client-id") {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
        throw new InstallerCliError(`${option} requires a value`);
      }
      if (option === "--input") inputPath = value;
      else if (option === "--config") configPath = value;
      else if (option === "--provider-route-id") providerRouteId = value;
      else gatewayOAuthClientId = value;
      index += 1;
      continue;
    }
    throw new InstallerCliError(`unknown option ${option}`);
  }
  if (inputPath === undefined) throw new InstallerCliError("--input is required");
  if ((command === "adopt") !== (providerRouteId !== undefined)) {
    throw new InstallerCliError("--provider-route-id is required only for adopt");
  }
  if (gatewayOAuthClientId !== undefined && command !== "adopt" && command !== "qualify") {
    throw new InstallerCliError("--gateway-oauth-client-id is supported only for read-only route adoption or qualification");
  }
  return Object.freeze({
    help: false,
    command,
    providerRouteId,
    gatewayOAuthClientId,
    inputPath: resolve(repositoryRoot, inputPath),
    configPath: resolve(repositoryRoot, configPath),
  });
}

async function readJsonFile(path, label) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    throw new InstallerCliError(`${label} cannot be read`);
  }
  if (bytes.byteLength > MAX_INPUT_BYTES) {
    throw new InstallerCliError(`${label} exceeds 1 MiB`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InstallerCliError(`${label} is not valid UTF-8`);
  }
  try {
    return plainObject(JSON.parse(text), label);
  } catch (error) {
    if (error instanceof InstallerCliError) throw error;
    throw new InstallerCliError(`${label} is not valid JSON`);
  }
}

function qualificationRequest(input, cloudflareAi, research) {
  const keys = Object.keys(input).sort().join(",");
  if (keys !== "probe,prompt,protocol" || input.protocol !== "eliotr.research-model-qualification-request.v1") {
    throw new InstallerCliError(
      "qualification input must contain exactly protocol, probe and prompt",
      "RESEARCH_QUALIFICATION_INPUT_INVALID",
    );
  }
  if (typeof cloudflareAi.parseDynamicRouteQualificationProbeInput !== "function") {
    throw new InstallerCliError(
      "qualification probe decoder is unavailable",
      "RESEARCH_QUALIFICATION_INPUT_VALIDATOR_UNAVAILABLE",
    );
  }
  if (typeof research.parseResearchQualificationPromptConfig !== "function") {
    throw new InstallerCliError(
      "qualification prompt decoder is unavailable",
      "RESEARCH_QUALIFICATION_INPUT_VALIDATOR_UNAVAILABLE",
    );
  }
  let probe;
  let promptConfig;
  try {
    probe = cloudflareAi.parseDynamicRouteQualificationProbeInput(input.probe);
    promptConfig = research.parseResearchQualificationPromptConfig(input.prompt);
  } catch {
    throw new InstallerCliError(
      "qualification input failed its strict probe or prompt schema",
      "RESEARCH_QUALIFICATION_INPUT_INVALID",
    );
  }
  return Object.freeze({ protocol: input.protocol, probe, promptConfig });
}

function accountFromGatewayUrl(value) {
  if (typeof value !== "string") return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "gateway.ai.cloudflare.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  return parts.length >= 2 && ACCOUNT_ID.test(parts[1]) ? parts[1].toLowerCase() : null;
}

function deploymentConfig(config) {
  const vars = config.vars === undefined ? {} : plainObject(config.vars, "Wrangler vars");
  const configuredAccounts = [];
  if (config.account_id !== undefined) configuredAccounts.push(config.account_id);
  for (const key of ["AI_GATEWAY_REASONING_URL", "AI_GATEWAY_RETRIEVAL_URL"]) {
    const account = accountFromGatewayUrl(vars[key]);
    if (account !== null) configuredAccounts.push(account);
  }
  const accounts = [...new Set(configuredAccounts)];
  if (accounts.length !== 1 || typeof accounts[0] !== "string" || !ACCOUNT_ID.test(accounts[0])) {
    throw new InstallerCliError("Wrangler config has no single account identity");
  }
  if (!Array.isArray(config.d1_databases)) {
    throw new InstallerCliError("Wrangler config has no D1 bindings");
  }
  const coreBindings = config.d1_databases.filter(
    (entry) => entry && typeof entry === "object" && entry.binding === "CORE_DB",
  );
  if (coreBindings.length !== 1 || typeof coreBindings[0].database_id !== "string" ||
      coreBindings[0].database_id.length === 0) {
    throw new InstallerCliError("Wrangler config must contain one resolved CORE_DB database_id");
  }
  return Object.freeze({ accountId: accounts[0].toLowerCase(), databaseId: coreBindings[0].database_id });
}

async function readWranglerBearer(accountId) {
  const env = { ...process.env, ELIOTR_CLOUDFLARE_AUTH_MODE: WRANGLER_OAUTH_MODE };
  const scrubbed = scrubTokenEnv(env);
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "whoami"],
    {
      cwd: repositoryRoot,
      env: scrubbed,
      encoding: "utf8",
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0) {
    throw new InstallerCliError("Wrangler browser OAuth account verification failed", "WRANGLER_OAUTH_UNAVAILABLE");
  }
  try {
    await verifyWranglerOAuthAccount({
      expectedAccountId: accountId,
      getWhoamiOutput: async () => result.stdout ?? "",
    });
  } catch (error) {
    throw new InstallerCliError(error?.message ?? "Wrangler browser OAuth account mismatch", "WRANGLER_OAUTH_ACCOUNT_MISMATCH");
  }
  // whoami may refresh the official OAuth cache; load the resulting credential.
  try {
    return (await loadWranglerOAuthCredential({ env, now: Date.now() })).bearer;
  } catch (error) {
    throw new InstallerCliError(error?.message ?? LOGIN_INSTRUCTION, "WRANGLER_OAUTH_UNAVAILABLE");
  }
}

function bindingStore(research, database) {
  const factory = research.createD1DynamicRouteRestBindingStore;
  if (typeof factory !== "function") {
    throw new InstallerCliError(
      "D1 Dynamic Route binding store is unavailable; install its durable adapter before running the installer",
      "DYNAMIC_ROUTE_BINDING_STORE_UNAVAILABLE",
    );
  }
  const store = factory(database);
  if (store === null || typeof store !== "object" ||
      typeof store.get !== "function" || typeof store.putImmutable !== "function") {
    throw new InstallerCliError(
      "D1 Dynamic Route binding store does not implement get and putImmutable",
      "DYNAMIC_ROUTE_BINDING_STORE_INVALID",
    );
  }
  return store;
}

async function execute(options) {
  const input = await readJsonFile(options.inputPath, "installer input");
  let cloudflareAi;
  let research;
  let qualification;
  if (options.command === "qualify") {
    [cloudflareAi, research] = await Promise.all([
      loadCompiledWorkspaceModule("packages/cloudflare-ai/dist/index.js"),
      loadCompiledWorkspaceModule("packages/cloudflare-research/dist/index.js"),
    ]);
    qualification = qualificationRequest(input, cloudflareAi, research);
  }
  const config = await readJsonFile(options.configPath, "Wrangler config");
  const { accountId, databaseId } = deploymentConfig(config);
  // Finish the optional browser handoff before taking the short-lived D1 bearer.
  const gatewayOAuthBearer = options.gatewayOAuthClientId === undefined
    ? undefined : await readGatewayBrowserOAuthBearer(options.gatewayOAuthClientId);
  const bearer = await readWranglerBearer(accountId);
  const database = createCloudflareD1HttpDatabase({
    account_id: accountId,
    database_id: databaseId,
    api_token: bearer,
  });
  if (cloudflareAi === undefined || research === undefined) {
    [cloudflareAi, research] = await Promise.all([
      loadCompiledWorkspaceModule("packages/cloudflare-ai/dist/index.js"),
      loadCompiledWorkspaceModule("packages/cloudflare-research/dist/index.js"),
    ]);
  }
  const bindings = bindingStore(research, database);
  const gatewayBearer = gatewayOAuthBearer ?? bearer;
  const controlPlane = cloudflareAi.createCloudflareDynamicRouteRestControlPlane({
    account_id: accountId,
    fetch: Object.freeze({
      fetch: (url, init) => globalThis.fetch(url, init),
    }),
    credentials: Object.freeze({ readApiToken: async () => gatewayBearer }),
    bindings,
  });
  if (options.command === "qualify") {
    const result = await withResearchQualificationRuntime({ config, accountId }, async (env) => {
      const compiler = await research.createResearchQualificationPromptCompiler({
        core_database: env.CORE_DB,
        search_database: env.SEARCH_DB,
        evidence_bucket: env.EVIDENCE_BUCKET,
        work_bucket: env.WORK_BUCKET,
        probe: qualification.probe,
        config: qualification.promptConfig,
      });
      const service = research.createResearchModelQualification({
        database: env.CORE_DB,
        work_bucket: env.WORK_BUCKET,
        control_plane: controlPlane,
        gateway: {
          reasoning_gateway_base_url: config.vars.AI_GATEWAY_REASONING_URL,
          ai_gateway_binding: env.AI,
        },
        prompt_compiler: compiler,
        now: () => new Date().toISOString(),
      });
      await compiler.compile(
        qualification.probe.model_call,
        qualification.probe.provisioning.deployment,
      );
      return service.qualify(qualification.probe);
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const service = research.createResearchModelInstallationService({
    database,
    control_plane: controlPlane,
  });
  if (options.command === "adopt") {
    if (input.protocol !== "eliotr.research-model-route-plan.v1") throw new InstallerCliError("adopt requires a generated route plan");
    const desired = await cloudflareAi.compileDynamicRouteDesired(input.provisioning);
    const result = await controlPlane.adopt(options.providerRouteId, desired.create_request);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const result = options.command === "prepare"
    ? await service.prepare(input)
    : await service.install(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function safeError(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(error.code)
    ? error.code
    : "MODEL_AUTHORITY_INSTALL_FAILED";
  if (error instanceof InstallerCliError || error instanceof GatewayBrowserOAuthError) return `${code}: ${error.message}`;
  if (error instanceof ResearchQualificationRuntimeError) return `${code}: qualification runtime operation failed`;
  if (code === "DYNAMIC_ROUTE_REST_HTTP_FAILED" &&
      /^Cloudflare control plane returned HTTP [1-5][0-9]{2}$/u.test(error?.message ?? "")) {
    return `${code}: ${error.message}`;
  }
  return `${code}: model authority operation failed`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  await execute(options);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 2;
}
