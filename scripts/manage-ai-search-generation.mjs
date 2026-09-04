import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createCloudflareD1HttpDatabase } from "./lib/cloudflare-d1-http.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMANDS = new Set(["status", "declare", "observe", "promote"]);
const MUTATING_COMMANDS = new Set(["declare", "observe", "promote"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const COMMON_VALUE_OPTIONS = new Set([
  "account-id",
  "api-base-url",
  "database-id",
  "deploy-config",
  "desired-state",
  "state-directory",
  "timeout-ms",
]);
const COMMAND_VALUE_OPTIONS = Object.freeze({
  status: new Set(),
  declare: new Set(["declared-at", "expected-item-count"]),
  observe: new Set([
    "failed-item-count",
    "golden-set-result-ref",
    "indexed-item-count",
    "mismatch-count",
    "observed-at",
    "readback-item-count",
  ]),
  promote: new Set([
    "confirm-generation",
    "expected-active-head",
    "promoted-at",
  ]),
});

class OperatorInputError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OperatorInputError";
    this.code = "AI_SEARCH_GENERATION_OPERATOR_INPUT_INVALID";
  }
}

function inputFailure(message, cause) {
  throw new OperatorInputError(
    message,
    cause === undefined ? {} : { cause },
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function usage() {
  return `Usage:
  node scripts/manage-ai-search-generation.mjs status [common options]
  node scripts/manage-ai-search-generation.mjs declare --expected-item-count N --declared-at ISO --confirm-live [common options]
  node scripts/manage-ai-search-generation.mjs observe --indexed-item-count N --readback-item-count N --failed-item-count N --mismatch-count N --observed-at ISO [--golden-set-result-ref REF] --confirm-live [common options]
  node scripts/manage-ai-search-generation.mjs promote --expected-active-head none|GENERATION --promoted-at ISO --confirm-generation GENERATION --confirm-live [common options]

Common options:
  --account-id ID       Cloudflare account ID; defaults to CLOUDFLARE_ACCOUNT_ID
  --database-id ID      SEARCH_DB ID; defaults to ELIOTR_SEARCH_DATABASE_ID or generated deploy config
  --api-base-url URL    Defaults to CLOUDFLARE_API_BASE_URL or Cloudflare v4 API
  --deploy-config PATH  Defaults to apps/eliotr-core/wrangler.deploy.jsonc
  --desired-state PATH  Defaults to infra/ai-search/instances.json
  --state-directory PATH Defaults to ELIOTR_STATE_DIRECTORY or .eliotr-state
  --timeout-ms N        D1 HTTP timeout in milliseconds

CLOUDFLARE_API_TOKEN is accepted only through the environment. Mutating commands require
--confirm-live. Promotion additionally requires --confirm-generation to equal the desired generation.`;
}

function parseArguments(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { help: true };
  }
  const command = argv[0];
  if (!COMMANDS.has(command)) inputFailure(`unsupported command ${command}`);
  const options = Object.create(null);
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (token === "--confirm-live") {
      if (options["confirm-live"] !== undefined) inputFailure("duplicate option --confirm-live");
      options["confirm-live"] = true;
      continue;
    }
    if (!token.startsWith("--") || token.length < 3) {
      inputFailure(`unexpected positional argument ${token}`);
    }
    const name = token.slice(2);
    if (
      !COMMON_VALUE_OPTIONS.has(name) &&
      !COMMAND_VALUE_OPTIONS[command].has(name)
    ) {
      inputFailure(`unsupported option --${name} for ${command}`);
    }
    if (options[name] !== undefined) inputFailure(`duplicate option --${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      inputFailure(`option --${name} requires a value`);
    }
    options[name] = value;
    index += 1;
  }
  return { help: false, command, options };
}

function boundedIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    inputFailure(`${label} is not a bounded identifier`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string") inputFailure(`${label} is required`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    inputFailure(`${label} must be a canonical UTC timestamp with milliseconds`);
  }
  return value;
}

function integerOption(options, name, maximum = 1_000_000_000) {
  const raw = options[name];
  if (typeof raw !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    inputFailure(`--${name} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    inputFailure(`--${name} exceeds ${maximum}`);
  }
  return value;
}

function positiveIntegerOption(options, name) {
  const value = integerOption(options, name);
  if (value < 1) inputFailure(`--${name} must be positive`);
  return value;
}

function pathOption(options, name, fallback) {
  const value = options[name] ?? fallback;
  if (typeof value !== "string" || value.length < 1 || /[\u0000\r\n]/u.test(value)) {
    inputFailure(`--${name} is invalid`);
  }
  return resolve(root, value);
}

function exactObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputFailure(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    inputFailure(`${label} must be a plain object`);
  }
  return value;
}

function desiredProfile(desired) {
  if (desired.protocol !== "eliotr.ai-search-generation.v1") {
    inputFailure("AI Search desired-state protocol is unsupported");
  }
  const namespace = boundedIdentifier(desired.namespace, "desired namespace");
  const generation = boundedIdentifier(desired.generation, "desired generation");
  if (!Array.isArray(desired.instances) || desired.instances.length < 1) {
    inputFailure("AI Search desired state has no instances");
  }
  const primary = desired.instances.filter(
    (instance) =>
      instance?.purpose === "private natural-language source sections",
  );
  if (primary.length !== 1) {
    inputFailure("AI Search desired state must contain exactly one primary prose instance");
  }
  const instance = exactObject(primary[0], "primary AI Search instance");
  const create = exactObject(instance.create, "primary AI Search create request");
  const indexMethod = exactObject(create.index_method, "primary index_method");
  const indexing = exactObject(create.indexing_options, "primary indexing_options");
  const retrieval = exactObject(create.retrieval_options, "primary retrieval_options");
  if (!Array.isArray(create.custom_metadata)) {
    inputFailure("primary custom_metadata must be an array");
  }
  const metadataFields = create.custom_metadata.map((raw, index) => {
    const definition = exactObject(raw, `primary custom_metadata[${index}]`);
    if (definition.data_type !== "text") {
      inputFailure(`primary custom_metadata[${index}] must use text`);
    }
    return boundedIdentifier(
      definition.field_name,
      `primary custom_metadata[${index}].field_name`,
    );
  });
  const profile = Object.freeze({
    id: boundedIdentifier(instance.id, "primary instance id"),
    generation,
    index_method: Object.freeze({
      vector: indexMethod.vector,
      keyword: indexMethod.keyword,
    }),
    ...(create.fusion_method === undefined
      ? {}
      : { fusion_method: create.fusion_method }),
    ...(indexing.keyword_tokenizer === undefined
      ? {}
      : { keyword_tokenizer: indexing.keyword_tokenizer }),
    ...(retrieval.keyword_match_mode === undefined
      ? {}
      : { keyword_match_mode: retrieval.keyword_match_mode }),
    ...(create.embedding_model === undefined
      ? {}
      : { embedding_model: create.embedding_model }),
    reranking: create.reranking,
    max_num_results: create.max_num_results,
    metadata_fields: Object.freeze(metadataFields),
  });
  return Object.freeze({ namespace, generation, profile });
}

async function loadDesiredState(path) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    inputFailure(
      `cannot read AI Search desired state: ${errorMessage(cause)}`,
      cause,
    );
  }
  let desired;
  try {
    desired = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    inputFailure(
      `AI Search desired state is invalid JSON: ${errorMessage(cause)}`,
      cause,
    );
  }
  return Object.freeze({
    bytes,
    desired,
    ...desiredProfile(exactObject(desired, "AI Search desired state")),
  });
}

async function loadCloudflareAiModule() {
  try {
    return await import(
      new URL("../packages/cloudflare-ai/dist/index.js", import.meta.url)
    );
  } catch (cause) {
    throw new OperatorInputError(
      "@eliotr/cloudflare-ai is not built; run `pnpm exec tsc -b packages/cloudflare-ai/tsconfig.json --pretty false` first",
      { cause },
    );
  }
}

async function databaseIdFromConfig(path) {
  let document;
  try {
    document = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new OperatorInputError(
      `cannot read generated deploy config; set ELIOTR_SEARCH_DATABASE_ID or --database-id (${errorMessage(cause)})`,
      { cause },
    );
  }
  const matches = Array.isArray(document.d1_databases)
    ? document.d1_databases.filter((entry) => entry?.binding === "SEARCH_DB")
    : [];
  if (
    matches.length !== 1 ||
    typeof matches[0].database_id !== "string"
  ) {
    inputFailure("generated deploy config must contain exactly one SEARCH_DB database_id");
  }
  return matches[0].database_id;
}

async function resolveConnection(options) {
  const accountId = options["account-id"] ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (typeof accountId !== "string" || accountId.length < 1) {
    inputFailure("CLOUDFLARE_ACCOUNT_ID or --account-id is required");
  }
  if (typeof apiToken !== "string" || apiToken.length < 1) {
    inputFailure("CLOUDFLARE_API_TOKEN is required in the environment");
  }
  const deployConfig = pathOption(
    options,
    "deploy-config",
    "apps/eliotr-core/wrangler.deploy.jsonc",
  );
  const databaseId =
    options["database-id"] ??
    process.env.ELIOTR_SEARCH_DATABASE_ID ??
    await databaseIdFromConfig(deployConfig);
  const timeout = options["timeout-ms"] === undefined
    ? 30_000
    : positiveIntegerOption(options, "timeout-ms");
  return Object.freeze({
    account_id: accountId,
    database_id: databaseId,
    api_token: apiToken,
    api_base_url:
      options["api-base-url"] ??
      process.env.CLOUDFLARE_API_BASE_URL ??
      "https://api.cloudflare.com/client/v4",
    timeout_ms: timeout,
  });
}

function requireMutationConfirmation(command, options, generation) {
  if (!MUTATING_COMMANDS.has(command)) return;
  if (options["confirm-live"] !== true) {
    inputFailure(`${command} requires --confirm-live`);
  }
  if (command === "promote") {
    if (options["confirm-generation"] !== generation) {
      inputFailure(
        `promotion requires --confirm-generation ${generation}`,
      );
    }
  }
}

function expectedActiveHead(value) {
  if (value === "none" || value === "null") return null;
  return boundedIdentifier(value, "--expected-active-head");
}

function operationInput(command, options, desired) {
  switch (command) {
    case "declare":
      return Object.freeze({
        namespace: desired.namespace,
        profile: desired.profile,
        expected_item_count: positiveIntegerOption(
          options,
          "expected-item-count",
        ),
        declared_at: canonicalTimestamp(
          options["declared-at"],
          "--declared-at",
        ),
      });
    case "observe": {
      const golden = options["golden-set-result-ref"];
      if (golden !== undefined) {
        boundedIdentifier(golden, "--golden-set-result-ref");
      }
      return Object.freeze({
        generation: desired.generation,
        indexed_item_count: integerOption(options, "indexed-item-count"),
        readback_item_count: integerOption(options, "readback-item-count"),
        failed_item_count: integerOption(options, "failed-item-count"),
        mismatch_count: integerOption(options, "mismatch-count"),
        ...(golden === undefined ? {} : { golden_set_result_ref: golden }),
        observed_at: canonicalTimestamp(
          options["observed-at"],
          "--observed-at",
        ),
      });
    }
    case "promote":
      if (options["expected-active-head"] === undefined) {
        inputFailure("--expected-active-head is required");
      }
      return Object.freeze({
        expected_active_head_generation: expectedActiveHead(
          options["expected-active-head"],
        ),
        target_generation: desired.generation,
        promoted_at: canonicalTimestamp(
          options["promoted-at"],
          "--promoted-at",
        ),
      });
    default:
      return null;
  }
}

function requireCompiledPrimaryProfile(cloudflareAi, desired) {
  if (
    typeof cloudflareAi.assertCloudflareAiSearchInstanceProfile !== "function" ||
    typeof cloudflareAi.assertImmutableAiSearchProfile !== "function" ||
    typeof cloudflareAi.createAiSearchGenerationRegistryService !== "function" ||
    typeof cloudflareAi.createD1AiSearchGenerationRegistryStore !== "function" ||
    typeof cloudflareAi.AI_SEARCH_PRIMARY_NAMESPACE !== "string" ||
    typeof cloudflareAi.AI_SEARCH_PRIMARY_GENERATION !== "string" ||
    typeof cloudflareAi.AI_SEARCH_PRIMARY_INSTANCE_ID !== "string" ||
    typeof cloudflareAi.AI_SEARCH_PRIMARY_PROJECTION_PROFILE !== "object" ||
    cloudflareAi.AI_SEARCH_PRIMARY_PROJECTION_PROFILE === null
  ) {
    inputFailure("built @eliotr/cloudflare-ai omits the required generation authority surface");
  }
  if (cloudflareAi.AI_SEARCH_PRIMARY_NAMESPACE !== desired.namespace) {
    inputFailure("desired namespace differs from the compiled primary namespace");
  }
  if (cloudflareAi.AI_SEARCH_PRIMARY_GENERATION !== desired.generation) {
    inputFailure("desired generation differs from the compiled primary generation");
  }
  if (cloudflareAi.AI_SEARCH_PRIMARY_INSTANCE_ID !== desired.profile.id) {
    inputFailure("desired primary instance differs from the compiled primary instance");
  }
  try {
    cloudflareAi.assertCloudflareAiSearchInstanceProfile(desired.profile);
    cloudflareAi.assertImmutableAiSearchProfile(
      cloudflareAi.AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
      desired.profile,
    );
  } catch (cause) {
    throw new OperatorInputError(
      "desired primary profile differs from the compiled immutable profile",
      { cause },
    );
  }
}

async function persistReceipt(stateDirectory, document) {
  const receipt = document.persistence_receipt;
  if (receipt === undefined) return null;
  const suffix = `${receipt.revision}-${receipt.artifact_sha256.slice(0, 16)}`;
  const path = resolve(
    stateDirectory,
    `ai-search-generation-${document.operation.toLowerCase()}-${suffix}.json`,
  );
  const bytes = `${JSON.stringify(document, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (cause) {
    if (cause?.code !== "EEXIST") throw cause;
    const existing = await readFile(path, "utf8");
    if (existing !== bytes) {
      throw new Error(`receipt path already contains different bytes: ${path}`, {
        cause,
      });
    }
  }
  return path;
}

function publicError(error) {
  return {
    protocol: "eliotr.ai-search-generation-operator-error.v1",
    error: {
      name: error instanceof Error ? error.name : "UnknownError",
      code:
        error && typeof error === "object" && typeof error.code === "string"
          ? error.code
          : "AI_SEARCH_GENERATION_OPERATOR_FAILED",
      message: error instanceof Error ? error.message : String(error),
      ...(error && typeof error === "object" && typeof error.retryable === "boolean"
        ? { retryable: error.retryable }
        : {}),
      ...(error && typeof error === "object" && typeof error.ambiguous_effect === "string"
        ? { ambiguous_effect: error.ambiguous_effect }
        : {}),
      ...(process.env.ELIOTR_DEBUG === "1" && error instanceof Error
        ? { stack: error.stack }
        : {}),
    },
  };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    console.log(usage());
    return;
  }
  const { command, options } = parsed;
  const desiredPath = pathOption(
    options,
    "desired-state",
    "infra/ai-search/instances.json",
  );
  const desired = await loadDesiredState(desiredPath);
  requireMutationConfirmation(command, options, desired.generation);
  const input = operationInput(command, options, desired);
  const connection = await resolveConnection(options);
  const cloudflareAi = await loadCloudflareAiModule();
  requireCompiledPrimaryProfile(cloudflareAi, desired);

  const database = createCloudflareD1HttpDatabase(connection);
  const service = cloudflareAi.createAiSearchGenerationRegistryService(
    cloudflareAi.createD1AiSearchGenerationRegistryStore(database),
  );
  let persistenceReceipt;
  let snapshot;
  if (command === "status") {
    snapshot = await service.read(desired.namespace);
  } else if (command === "declare") {
    persistenceReceipt = await service.declare(input);
  } else if (command === "observe") {
    persistenceReceipt = await service.observe(desired.namespace, input);
  } else {
    persistenceReceipt = await service.promote(desired.namespace, input);
  }

  const document = Object.freeze({
    protocol: "eliotr.ai-search-generation-operator-receipt.v1",
    operation: command.toUpperCase(),
    namespace: desired.namespace,
    generation: desired.generation,
    desired_state_sha256: createHash("sha256").update(desired.bytes).digest("hex"),
    database_binding: "SEARCH_DB",
    ...(snapshot === undefined ? {} : { registry_snapshot: snapshot }),
    ...(persistenceReceipt === undefined
      ? {}
      : { persistence_receipt: persistenceReceipt }),
    live_provider_mutation: false,
  });
  const stateDirectory = pathOption(
    options,
    "state-directory",
    process.env.ELIOTR_STATE_DIRECTORY ?? ".eliotr-state",
  );
  const receiptPath = await persistReceipt(stateDirectory, document);
  console.log(JSON.stringify({
    ...document,
    ...(receiptPath === null ? {} : { local_receipt_path: receiptPath }),
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify(publicError(error), null, 2));
  process.exitCode = 1;
});
