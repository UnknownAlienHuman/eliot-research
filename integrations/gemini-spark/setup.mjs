import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const WORKSPACE_EXTENSION_REF = "089927ead01433f38c65c12cdcd2ed9a18165277";
const GCLOUD_EXTENSION_REF = "ec545cd8252d33c83f02b97939690b8ae16888ef";
const WORKSPACE_EXTENSION_URL = "https://github.com/gemini-cli-extensions/workspace";
const GCLOUD_EXTENSION_URL = "https://github.com/gemini-cli-extensions/gcloud";
const TOOL_ALLOWLIST = [
  "eliotr_system_status",
  "eliotr_catalog",
  "eliotr_create_google_sync_plan",
  "eliotr_validate_google_sync_receipt",
];
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const extensionDirectory = resolve(scriptDirectory, "extension");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function flag(name) {
  return process.argv.includes(name);
}

function validateEndpoint(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("--endpoint is required");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("--endpoint must be an absolute HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/mcp" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("--endpoint must be one exact https://<host>/mcp URL without credentials, port, query, or fragment");
  }
  return url.toString();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSettings(path) {
  if (!existsSync(path)) return {};
  const text = await readFile(path, "utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`, { cause: error });
  }
  if (!isRecord(value)) throw new Error(`${path} must contain one JSON object`);
  return value;
}

function configuredSettings(existing, endpoint) {
  const mcpServers = isRecord(existing.mcpServers) ? { ...existing.mcpServers } : {};
  mcpServers["eliot-research"] = {
    httpUrl: endpoint,
    headers: {
      "CF-Access-Client-Id": "$ELIOTR_CF_ACCESS_CLIENT_ID",
      "CF-Access-Client-Secret": "$ELIOTR_CF_ACCESS_CLIENT_SECRET",
    },
    timeout: 600000,
    trust: false,
    includeTools: TOOL_ALLOWLIST,
  };

  let mcp = existing.mcp;
  if (isRecord(mcp)) {
    const excluded = Array.isArray(mcp.excluded) ? mcp.excluded : [];
    if (excluded.includes("eliot-research")) {
      throw new Error("settings.mcp.excluded contains eliot-research; remove that explicit block first");
    }
    if (Array.isArray(mcp.allowed) && !mcp.allowed.includes("eliot-research")) {
      mcp = { ...mcp, allowed: [...mcp.allowed, "eliot-research"] };
    }
  }

  return {
    ...existing,
    ...(mcp === undefined ? {} : { mcp }),
    mcpServers,
  };
}

async function writeAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function sanitizedEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/(TOKEN|SECRET|PASSWORD|KEY|AUTH|CREDENTIAL|COOKIE)/iu.test(key)) continue;
    environment[key] = value;
  }
  return environment;
}

function extensionInstallCommand(source, ref) {
  return [
    "extensions",
    "install",
    source,
    ...(ref === undefined ? [] : ["--ref", ref]),
    "--consent",
    "--skip-settings",
  ];
}

function runGemini(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "inherit",
    env: sanitizedEnvironment(),
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${String(result.status)}`);
  }
}

function extensionAlreadyInstalled(name) {
  return existsSync(join(homedir(), ".gemini", "extensions", name));
}

const endpoint = validateEndpoint(argumentValue("--endpoint"));
const settingsPath = resolve(argumentValue("--settings") ?? join(homedir(), ".gemini", "settings.json"));
const dryRun = flag("--dry-run");
const installExtensions = flag("--install-extensions");
const consent = flag("--consent");
const skipEliot = flag("--skip-eliot-extension");
const skipWorkspace = flag("--skip-workspace");
const skipGcloud = flag("--skip-gcloud");
const geminiCommand = argumentValue("--gemini-command") ?? "gemini";
const workspaceRef = argumentValue("--workspace-ref") ?? WORKSPACE_EXTENSION_REF;
const gcloudRef = argumentValue("--gcloud-ref") ?? GCLOUD_EXTENSION_REF;

if (installExtensions && !consent) {
  throw new Error("--install-extensions requires --consent because Gemini extension installation executes third-party code");
}

const existing = await readSettings(settingsPath);
const next = configuredSettings(existing, endpoint);
const installationPlan = [
  ...(skipEliot ? [] : [{ name: "eliot-research", source: extensionDirectory, ref: undefined }]),
  ...(skipWorkspace ? [] : [{ name: "google-workspace", source: WORKSPACE_EXTENSION_URL, ref: workspaceRef }]),
  ...(skipGcloud ? [] : [{ name: "gcloud", source: GCLOUD_EXTENSION_URL, ref: gcloudRef }]),
];

if (dryRun) {
  process.stdout.write(`${JSON.stringify({
    protocol: "eliotr.gemini-spark.setup-plan.v1",
    mode: "DRY_RUN_NO_MUTATION",
    settings_path: settingsPath,
    settings: next,
    extensions: installationPlan.map((item) => ({
      name: item.name,
      source: item.source,
      ref: item.ref ?? null,
      disposition: extensionAlreadyInstalled(item.name) ? "SKIP_INSTALLED" : "INSTALL",
    })),
  }, null, 2)}\n`);
  process.exit(0);
}

await writeAtomic(settingsPath, next);

if (installExtensions) {
  for (const item of installationPlan) {
    if (extensionAlreadyInstalled(item.name)) continue;
    runGemini(geminiCommand, extensionInstallCommand(item.source, item.ref));
  }
}

process.stdout.write(`${JSON.stringify({
  protocol: "eliotr.gemini-spark.setup-receipt.v1",
  settings_path: settingsPath,
  endpoint,
  secrets_written: false,
  extension_installation: installExtensions ? "REQUESTED" : "NOT_REQUESTED",
  workspace_ref: skipWorkspace ? null : workspaceRef,
  gcloud_ref: skipGcloud ? null : gcloudRef,
}, null, 2)}\n`);
