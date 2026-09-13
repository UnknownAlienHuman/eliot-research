import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE_DIRECTORY = resolve(ROOT, ".eliotr-state");
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/iu;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const MAX_TEXT_LENGTH = 512;
const MAX_FLAGS = 64;
const AMBIENT_AUTH_ENV_KEYS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CLOUDFLARE_TOKEN",
];

export class ResearchQualificationRuntimeError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchQualificationRuntimeError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new ResearchQualificationRuntimeError(code, message, cause);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredText(value, field, maximum = MAX_TEXT_LENGTH) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    fail("RESEARCH_QUALIFICATION_RUNTIME_CONFIG_INVALID", `${field} is invalid`);
  }
  return value;
}

function requiredId(value, field, pattern) {
  const text = requiredText(value, field);
  if (!pattern.test(text)) {
    fail("RESEARCH_QUALIFICATION_RUNTIME_CONFIG_INVALID", `${field} is invalid`);
  }
  return text;
}

function assertUnique(values, field) {
  if (new Set(values).size !== values.length) {
    fail("RESEARCH_QUALIFICATION_RUNTIME_CONFIG_INVALID", `${field} is not unique`);
  }
}

function selectExactlyOne(entries, binding, field) {
  if (!Array.isArray(entries) || entries.some((entry) => !isPlainObject(entry))) {
    fail("RESEARCH_QUALIFICATION_RUNTIME_CONFIG_INVALID", `${field} is invalid`);
  }
  const matches = entries.filter((entry) => entry.binding === binding);
  if (matches.length !== 1) {
    fail(
      "RESEARCH_QUALIFICATION_RUNTIME_CONFIG_INVALID",
      `${field}.${binding} must have exactly one entry`,
    );
  }
  return matches[0];
}

function readProductionBindings(config) {
  const core = selectExactlyOne(config.d1_databases, "CORE_DB", "d1_databases");
  const search = selectExactlyOne(config.d1_databases, "SEARCH_DB", "d1_databases");
  const work = selectExactlyOne(config.r2_buckets, "WORK_BUCKET", "r2_buckets");
  const evidence = selectExactlyOne(
    config.r2_buckets,
    "EVIDENCE_BUCKET",
    "r2_buckets",
  );

  const d1 = [core, search].map((entry, index) => ({
    binding: index === 0 ? "CORE_DB" : "SEARCH_DB",
    database_name: requiredText(entry.database_name, `d1_databases.${index}.database_name`),
    database_id: requiredId(
      entry.database_id,
      `d1_databases.${index}.database_id`,
      UUID_PATTERN,
    ),
    remote: true,
  }));
  assertUnique(d1.map((entry) => entry.database_id), "D1 database_id");
  assertUnique(d1.map((entry) => entry.database_name), "D1 database_name");

  const r2 = [work, evidence].map((entry, index) => ({
    binding: index === 0 ? "WORK_BUCKET" : "EVIDENCE_BUCKET",
    bucket_name: requiredText(entry.bucket_name, `r2_buckets.${index}.bucket_name`),
    remote: true,
  }));
  assertUnique(r2.map((entry) => entry.bucket_name), "R2 bucket_name");

  if (!isPlainObject(config.ai) || config.ai.binding !== "AI") {
    fail("RESEARCH_QUALIFICATION_RUNTIME_CONFIG_INVALID", "ai binding is invalid");
  }

  return { d1, r2, ai: { binding: "AI", remote: true } };
}

function buildOverlay(config, accountId) {
  if (!isPlainObject(config)) {
    fail("RESEARCH_QUALIFICATION_RUNTIME_CONFIG_INVALID", "config is invalid");
  }

  const resolvedAccountId = requiredId(accountId, "accountId", ACCOUNT_ID_PATTERN);
  if (Object.hasOwn(config, "account_id")) {
    const configuredAccountId = requiredId(
      config.account_id,
      "config.account_id",
      ACCOUNT_ID_PATTERN,
    );
    if (configuredAccountId !== resolvedAccountId) {
      fail(
        "RESEARCH_QUALIFICATION_RUNTIME_ACCOUNT_MISMATCH",
        "config.account_id does not match accountId",
      );
    }
  }

  requiredText(config.name, "config.name");
  const previewName = `eliotr-qualification-${randomUUID()}`;
  const compatibilityDate = requiredText(
    config.compatibility_date,
    "config.compatibility_date",
  );
  if (!DATE_PATTERN.test(compatibilityDate)) {
    fail(
      "RESEARCH_QUALIFICATION_RUNTIME_CONFIG_INVALID",
      "config.compatibility_date is invalid",
    );
  }

  let compatibilityFlags;
  if (Object.hasOwn(config, "compatibility_flags")) {
    if (
      !Array.isArray(config.compatibility_flags) ||
      config.compatibility_flags.length > MAX_FLAGS
    ) {
      fail(
        "RESEARCH_QUALIFICATION_RUNTIME_CONFIG_INVALID",
        "config.compatibility_flags is invalid",
      );
    }
    compatibilityFlags = config.compatibility_flags.map((flag, index) =>
      requiredText(flag, `config.compatibility_flags.${index}`, MAX_TEXT_LENGTH),
    );
    assertUnique(compatibilityFlags, "config.compatibility_flags");
  }

  const bindings = readProductionBindings(config);
  return {
    account_id: resolvedAccountId,
    name: previewName,
    compatibility_date: compatibilityDate,
    ...(compatibilityFlags === undefined
      ? {}
      : { compatibility_flags: [...compatibilityFlags] }),
    d1_databases: bindings.d1,
    r2_buckets: bindings.r2,
    ai: bindings.ai,
  };
}

async function writeOverlay(overlay) {
  await mkdir(STATE_DIRECTORY, { recursive: true });
  const overlayPath = resolve(
    STATE_DIRECTORY,
    `.research-qualification-${randomUUID()}.json`,
  );
  try {
    await writeFile(overlayPath, JSON.stringify(overlay), {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    fail(
      "RESEARCH_QUALIFICATION_RUNTIME_OVERLAY_WRITE_FAILED",
      "could not create the qualification runtime overlay",
      error,
    );
  }
  return overlayPath;
}

/**
 * Run a trusted qualification callback against the five production resources.
 * Wrangler resolves the saved OAuth profile internally. This helper rejects
 * ambient API-key/token authentication, suppresses Wrangler output while the
 * temporary preview proxy is created, and restores the prior logging setting.
 * It does not read, write, or expose bearer material.
 */
export async function withResearchQualificationRuntime(input, callback) {
  if (!isPlainObject(input)) {
    fail("RESEARCH_QUALIFICATION_RUNTIME_INPUT_INVALID", "input is invalid");
  }
  if (typeof callback !== "function") {
    fail("RESEARCH_QUALIFICATION_RUNTIME_INPUT_INVALID", "callback is invalid");
  }
  const ambientAuthKey = AMBIENT_AUTH_ENV_KEYS.find((key) =>
    Object.hasOwn(process.env, key),
  );
  if (ambientAuthKey !== undefined) {
    fail(
      "RESEARCH_QUALIFICATION_RUNTIME_AMBIENT_AUTH",
      `${ambientAuthKey} must be unset; use the Wrangler OAuth profile`,
    );
  }

  // Build the complete detached overlay before the first await. The callback
  // receives only the platform env; it cannot mutate the source configuration.
  const overlay = buildOverlay(input.config, input.accountId);
  const overlayPath = await writeOverlay(overlay);
  const hadWranglerLog = Object.hasOwn(process.env, "WRANGLER_LOG");
  const previousWranglerLog = process.env.WRANGLER_LOG;
  process.env.WRANGLER_LOG = "error";
  let platform;
  let operationError;
  try {
    const { getPlatformProxy } = await import("wrangler");
    platform = await getPlatformProxy({
      configPath: overlayPath,
      remoteBindings: true,
      envFiles: [],
      persist: false,
    });
    return await callback(platform.env);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let cleanupError;
    if (platform !== undefined) {
      try {
        await platform.dispose();
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      await unlink(overlayPath);
    } catch (error) {
      if (error?.code !== "ENOENT" && cleanupError === undefined) {
        cleanupError = error;
      }
    }
    if (hadWranglerLog && previousWranglerLog !== undefined) {
      process.env.WRANGLER_LOG = previousWranglerLog;
    } else {
      delete process.env.WRANGLER_LOG;
    }
    if (operationError === undefined && cleanupError !== undefined) {
      throw new ResearchQualificationRuntimeError(
        "RESEARCH_QUALIFICATION_RUNTIME_CLEANUP_FAILED",
        "qualification runtime cleanup failed",
        cleanupError,
      );
    }
  }
}
