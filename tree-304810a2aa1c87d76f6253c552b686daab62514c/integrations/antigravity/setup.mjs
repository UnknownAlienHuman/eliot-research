import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "eliot-research";
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateEndpoint(raw) {
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

function disabledTemplate(endpoint) {
  return {
    serverUrl: endpoint,
    disabled: true,
  };
}

function isSameDisabledTemplate(value, endpoint) {
  return isRecord(value) &&
    value.serverUrl === endpoint &&
    value.disabled === true &&
    Object.keys(value).length === 2;
}

export function prepareConfig(existing, endpoint) {
  if (!isRecord(existing)) throw new Error("Antigravity config must contain one JSON object");
  const mcpServers = existing.mcpServers === undefined ? {} : existing.mcpServers;
  if (!isRecord(mcpServers)) throw new Error("Antigravity config mcpServers must be one JSON object");

  const current = mcpServers[SERVER_NAME];
  if (current !== undefined && !isSameDisabledTemplate(current, endpoint)) {
    throw new Error(`mcpServers[${JSON.stringify(SERVER_NAME)}] already exists; refusing to overwrite it`);
  }
  if (current !== undefined) return existing;

  return {
    ...existing,
    mcpServers: {
      ...mcpServers,
      [SERVER_NAME]: disabledTemplate(endpoint),
    },
  };
}

async function readConfig(path) {
  if (!existsSync(path)) return {};
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  return value;
}

async function writeAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function hasFlag(args, name) {
  return args.includes(name);
}

export async function runSetup(args = process.argv.slice(2)) {
  const endpoint = validateEndpoint(argumentValue(args, "--endpoint"));
  const configPath = resolve(argumentValue(args, "--config") ?? join(process.cwd(), ".agents", "mcp_config.json"));
  const write = hasFlag(args, "--write");
  const dryRun = hasFlag(args, "--dry-run") || !write;
  if (write && hasFlag(args, "--dry-run")) throw new Error("--write and --dry-run cannot be used together");

  const existing = await readConfig(configPath);
  const next = prepareConfig(existing, endpoint);
  if (write && next !== existing) await writeAtomic(configPath, next);

  return {
    protocol: "eliotr.antigravity.setup.v1",
    mode: dryRun ? "DRY_RUN_NO_MUTATION" : "WRITE_DISABLED_TEMPLATE",
    config_path: configPath,
    server_name: SERVER_NAME,
    server: {
      serverUrl: endpoint,
      disabled: true,
    },
    auth: "PENDING_AUTH_QUALIFICATION",
    installed_client: false,
    secrets_written: false,
  };
}

if (resolve(process.argv[1] ?? "") === resolve(SCRIPT_PATH)) {
  try {
    process.stdout.write(`${JSON.stringify(await runSetup(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
