import {
  AI_SEARCH_GENERATION_REGISTRY_MAX_BYTES,
  aiSearchGenerationRegistryFailure,
  type AiSearchGenerationRegistryCasCommand,
  type AiSearchGenerationRegistrySnapshot,
  type AiSearchGenerationRegistryStorePort,
  type AiSearchGenerationRegistryStoreReceipt,
} from "./ai-search-generation-registry-contract.js";
import {
  decodeAiSearchGenerationRegistrySnapshot,
  sameAiSearchGenerationRegistrySnapshot,
} from "./ai-search-generation-registry-codec.js";
import { canonicalModelGatewayJson } from "./model-gateway-request.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMAND_KEYS = new Set([
  "artifact",
  "artifact_sha256",
  "expected_artifact_sha256",
  "expected_revision",
  "namespace",
]);
const ROW_KEYS = new Set([
  "artifact_json",
  "artifact_sha256",
  "namespace",
  "revision",
]);
const SELECT_COLUMNS =
  "namespace, revision, artifact_sha256, artifact_json";
const SELECT_REGISTRY =
  `SELECT ${SELECT_COLUMNS} FROM ai_search_generation_registry ` +
  "WHERE namespace = ?1 LIMIT 1";

interface RegistryRow {
  readonly namespace: unknown;
  readonly revision: unknown;
  readonly artifact_sha256: unknown;
  readonly artifact_json: unknown;
}

interface DecodedCommand {
  readonly namespace: string;
  readonly expected_revision: number | null;
  readonly expected_artifact_sha256: string | null;
  readonly snapshot: AiSearchGenerationRegistrySnapshot;
  readonly artifact_json: string;
}

type Failure = (message: string, cause?: unknown) => never;

function inputFailure(message: string, cause?: unknown): never {
  aiSearchGenerationRegistryFailure(
    "AI_SEARCH_REGISTRY_INPUT_INVALID",
    message,
    cause === undefined ? {} : { cause },
  );
}

function readbackFailure(message: string, cause?: unknown): never {
  aiSearchGenerationRegistryFailure(
    "AI_SEARCH_REGISTRY_READBACK_INVALID",
    message,
    cause === undefined ? {} : { cause },
  );
}

function writeFailure(message: string, cause?: unknown): never {
  aiSearchGenerationRegistryFailure(
    "AI_SEARCH_REGISTRY_WRITE_FAILED",
    message,
    cause === undefined ? {} : { cause },
  );
}

function exactObject(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
  fail: Failure,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.has(key)) fail(`${label} contains unsupported field ${key}`);
  }
  return record;
}

function identifier(value: unknown, label: string, fail: Failure): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail(`${label} is not a bounded identifier`);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  label: string,
  fail: Failure,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function digest(value: unknown, label: string, fail: Failure): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function artifactJson(value: unknown, label: string): string {
  if (typeof value !== "string") {
    readbackFailure(`${label} must be a string`);
  }
  if (
    new TextEncoder().encode(value).byteLength >
    AI_SEARCH_GENERATION_REGISTRY_MAX_BYTES
  ) {
    readbackFailure(`${label} exceeds the 256 KiB registry envelope`);
  }
  return value;
}

async function decodeStoredRow(
  raw: unknown,
  expectedNamespace: string,
): Promise<AiSearchGenerationRegistrySnapshot> {
  const row = exactObject(raw, ROW_KEYS, "D1 generation registry row", readbackFailure);
  const namespace = identifier(
    row.namespace,
    "D1 generation registry namespace",
    readbackFailure,
  );
  if (namespace !== expectedNamespace) {
    readbackFailure("D1 generation registry row belongs to another namespace");
  }
  const revision = positiveInteger(
    row.revision,
    "D1 generation registry revision",
    readbackFailure,
  );
  const artifactSha256 = digest(
    row.artifact_sha256,
    "D1 generation registry digest",
    readbackFailure,
  );
  const json = artifactJson(
    row.artifact_json,
    "D1 generation registry artifact_json",
  );
  let artifact: unknown;
  try {
    artifact = JSON.parse(json) as unknown;
  } catch (cause) {
    readbackFailure("D1 generation registry artifact_json is invalid JSON", cause);
  }
  const snapshot = await decodeAiSearchGenerationRegistrySnapshot(
    { artifact, artifact_sha256: artifactSha256 },
    expectedNamespace,
  );
  if (snapshot.artifact.revision !== revision) {
    readbackFailure(
      "D1 generation registry row revision differs from artifact revision",
    );
  }
  if (canonicalModelGatewayJson(snapshot.artifact) !== json) {
    readbackFailure("D1 generation registry artifact_json is not canonical");
  }
  return snapshot;
}

async function decodeCommand(
  raw: AiSearchGenerationRegistryCasCommand,
): Promise<DecodedCommand> {
  const command = exactObject(
    raw,
    COMMAND_KEYS,
    "D1 generation registry CAS command",
    inputFailure,
  );
  const namespace = identifier(
    command.namespace,
    "D1 generation registry command namespace",
    inputFailure,
  );
  const hasExpectedRevision = command.expected_revision !== null;
  const hasExpectedDigest = command.expected_artifact_sha256 !== null;
  if (hasExpectedRevision !== hasExpectedDigest) {
    inputFailure(
      "D1 generation registry expected revision and digest must both be null or both be present",
    );
  }
  const expectedRevision = hasExpectedRevision
    ? positiveInteger(
        command.expected_revision,
        "D1 generation registry expected revision",
        inputFailure,
      )
    : null;
  const expectedArtifactSha256 = hasExpectedDigest
    ? digest(
        command.expected_artifact_sha256,
        "D1 generation registry expected digest",
        inputFailure,
      )
    : null;
  const snapshot = await decodeAiSearchGenerationRegistrySnapshot(
    {
      artifact: command.artifact,
      artifact_sha256: command.artifact_sha256,
    },
    namespace,
  );
  const expectedNextRevision = (expectedRevision ?? 0) + 1;
  if (snapshot.artifact.revision !== expectedNextRevision) {
    inputFailure(
      "D1 generation registry desired revision must immediately follow the expected revision",
    );
  }
  return Object.freeze({
    namespace,
    expected_revision: expectedRevision,
    expected_artifact_sha256: expectedArtifactSha256,
    snapshot,
    artifact_json: canonicalModelGatewayJson(snapshot.artifact),
  });
}

async function readStoredRegistry(
  database: D1Database,
  namespace: string,
): Promise<AiSearchGenerationRegistrySnapshot | null> {
  const raw = await database
    .prepare(SELECT_REGISTRY)
    .bind(namespace)
    .first<RegistryRow>();
  return raw === null ? null : decodeStoredRow(raw, namespace);
}

function receipt(
  outcome: AiSearchGenerationRegistryStoreReceipt["outcome"],
  snapshot: AiSearchGenerationRegistrySnapshot,
): AiSearchGenerationRegistryStoreReceipt {
  return Object.freeze({
    outcome,
    namespace: snapshot.artifact.namespace,
    revision: snapshot.artifact.revision,
    artifact_sha256: snapshot.artifact_sha256,
  });
}

async function applyCas(
  database: D1Database,
  command: DecodedCommand,
): Promise<RegistryRow | null> {
  if (command.expected_revision === null) {
    return database
      .prepare(
        "INSERT INTO ai_search_generation_registry(" +
          "namespace, revision, artifact_sha256, artifact_json" +
          ") VALUES (?1, ?2, ?3, ?4) " +
          "ON CONFLICT(namespace) DO NOTHING RETURNING " +
          SELECT_COLUMNS,
      )
      .bind(
        command.namespace,
        command.snapshot.artifact.revision,
        command.snapshot.artifact_sha256,
        command.artifact_json,
      )
      .first<RegistryRow>();
  }
  return database
    .prepare(
      "UPDATE ai_search_generation_registry SET " +
        "revision = ?4, artifact_sha256 = ?5, artifact_json = ?6 " +
        "WHERE namespace = ?1 AND revision = ?2 AND artifact_sha256 = ?3 " +
        "RETURNING " +
        SELECT_COLUMNS,
    )
    .bind(
      command.namespace,
      command.expected_revision,
      command.expected_artifact_sha256,
      command.snapshot.artifact.revision,
      command.snapshot.artifact_sha256,
      command.artifact_json,
    )
    .first<RegistryRow>();
}

/**
 * Stores the complete generation registry in one SEARCH_DB row. Every write
 * is one namespace + revision + digest fenced D1 statement; the service above
 * this port remains responsible for the final authoritative readback.
 */
export function createD1AiSearchGenerationRegistryStore(
  database: D1Database,
): AiSearchGenerationRegistryStorePort {
  if (
    typeof database !== "object" ||
    database === null ||
    typeof database.prepare !== "function"
  ) {
    inputFailure("D1 generation registry database binding is invalid");
  }

  return Object.freeze({
    async read(namespace: string): Promise<unknown | null> {
      const boundedNamespace = identifier(
        namespace,
        "D1 generation registry namespace",
        inputFailure,
      );
      return readStoredRegistry(database, boundedNamespace);
    },

    async compareAndSwap(
      rawCommand: AiSearchGenerationRegistryCasCommand,
    ): Promise<unknown> {
      const command = await decodeCommand(rawCommand);
      const appliedRaw = await applyCas(database, command);
      if (appliedRaw !== null) {
        const applied = await decodeStoredRow(appliedRaw, command.namespace);
        if (
          !sameAiSearchGenerationRegistrySnapshot(applied, command.snapshot)
        ) {
          writeFailure(
            "D1 generation registry mutation returned different authority bytes",
          );
        }
        return receipt("APPLIED", applied);
      }

      const current = await readStoredRegistry(database, command.namespace);
      if (current === null) {
        writeFailure(
          "D1 generation registry CAS returned no row and no authoritative state",
        );
      }
      if (
        sameAiSearchGenerationRegistrySnapshot(current, command.snapshot)
      ) {
        return receipt("REPLAY", current);
      }
      return receipt("CONFLICT", current);
    },
  });
}
