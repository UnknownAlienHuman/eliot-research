import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  type DynamicRouteQualificationObservationClaimInput,
  type DynamicRouteQualificationObservationReceipt,
  type DynamicRouteQualificationObservationStorePort,
  type DynamicRouteQualificationObservationWriteInput,
  type ModelGatewayOutputStorePort,
} from "@eliotr/cloudflare-ai";
import { bufferBounded } from "@eliotr/platform-cloudflare";

const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PROTOCOL = "eliotr.dynamic-route-qualification-observation.v1" as const;
const COLUMNS = "probe_idempotency_key, probe_input_sha256, claim_ref, execution_probe_ref, observation_sha256, observation_json";

interface ProbeRow {
  probe_idempotency_key: string;
  probe_input_sha256: string;
  claim_ref: string;
  execution_probe_ref: string | null;
  observation_sha256: string | null;
  observation_json: string | null;
}

function requireString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid qualification ${label}`);
  return value;
}

async function receipt(row: ProbeRow): Promise<DynamicRouteQualificationObservationReceipt | null> {
  if (row.execution_probe_ref === null) {
    if (row.observation_sha256 !== null || row.observation_json !== null) throw new Error("Incomplete qualification observation");
    return null;
  }
  if (typeof row.observation_json !== "string" || new TextEncoder().encode(row.observation_json).length > 32768) {
    throw new Error("Invalid stored qualification observation");
  }
  const observation = JSON.parse(row.observation_json) as DynamicRouteQualificationObservationWriteInput;
  const json = canonicalModelGatewayJson(observation);
  const digest = await modelGatewaySha256(json);
  if (json !== row.observation_json || digest !== row.observation_sha256 ||
      row.execution_probe_ref !== `dynamic-route-probe-${digest}` || observation.protocol !== PROTOCOL ||
      observation.probe_idempotency_key !== row.probe_idempotency_key || observation.probe_input_sha256 !== row.probe_input_sha256) {
    throw new Error("Qualification observation readback does not match its claim");
  }
  return Object.freeze({ protocol: PROTOCOL, execution_probe_ref: row.execution_probe_ref,
    observation_sha256: digest, observation });
}

/** A completed receipt can be read repeatedly; an unfinished call cannot be retried. */
export function createD1ResearchModelQualificationObservationStore(
  database: D1Database,
  now: () => string = () => new Date().toISOString(),
): DynamicRouteQualificationObservationStorePort {
  async function byKey(key: string): Promise<ProbeRow | null> {
    requireString(key, IDENTIFIER, "idempotency key");
    return database.prepare(`SELECT ${COLUMNS} FROM model_route_qualification_probe WHERE probe_idempotency_key = ?`)
      .bind(key).first<ProbeRow>();
  }
  return Object.freeze({
    async claim(input: DynamicRouteQualificationObservationClaimInput) {
      const key = requireString(input.probe_idempotency_key, IDENTIFIER, "idempotency key");
      const hash = requireString(input.probe_input_sha256, SHA256, "input digest");
      const claimRef = requireString(input.claim_ref, IDENTIFIER, "claim reference");
      const startedAt = now();
      if (!Number.isFinite(Date.parse(startedAt)) || new Date(startedAt).toISOString() !== startedAt) throw new Error("Invalid qualification clock");
      // Do not reconcile a thrown INSERT into call authority. Its outcome may
      // be ambiguous even if a subsequent read finds this same claim.
      const inserted = await database.prepare("INSERT INTO model_route_qualification_probe (probe_idempotency_key, probe_input_sha256, claim_ref, started_at) VALUES (?, ?, ?, ?) ON CONFLICT(probe_idempotency_key) DO NOTHING")
        .bind(key, hash, claimRef, startedAt).run();
      if (!inserted.success) throw new Error("Qualification claim write is uncertain");
      const row = await byKey(key);
      if (row === null || row.probe_input_sha256 !== hash) throw new Error("Qualification claim conflicts with requested input");
      requireString(row.claim_ref, IDENTIFIER, "stored claim reference");
      if (inserted.meta.changes === 1 && row.claim_ref !== claimRef) throw new Error("Qualification claim readback changed");
      const status = row.execution_probe_ref !== null ? "COMPLETED" as const
        : inserted.meta.changes === 1 && row.claim_ref === claimRef ? "CLAIMED" as const : "IN_PROGRESS" as const;
      return Object.freeze({ status, probe_idempotency_key: key, probe_input_sha256: hash, claim_ref: row.claim_ref });
    },
    async readByIdempotencyKey(key: string) {
      const row = await byKey(key);
      return row === null ? null : receipt(row);
    },
    async putImmutable(input: DynamicRouteQualificationObservationWriteInput, claimRef: string) {
      const json = canonicalModelGatewayJson(input);
      if (new TextEncoder().encode(json).length > 32768) throw new Error("Qualification observation exceeds 32 KiB");
      const observation = JSON.parse(json) as DynamicRouteQualificationObservationWriteInput;
      const key = requireString(observation.probe_idempotency_key, IDENTIFIER, "idempotency key");
      const hash = requireString(observation.probe_input_sha256, SHA256, "input digest");
      requireString(claimRef, IDENTIFIER, "claim reference");
      if (observation.protocol !== PROTOCOL) throw new Error("Invalid qualification observation protocol");
      const digest = await modelGatewaySha256(json);
      const ref = `dynamic-route-probe-${digest}`;
      const existing = await byKey(key);
      if (existing === null || existing.probe_input_sha256 !== hash || existing.claim_ref !== claimRef) {
        throw new Error("Qualification observation has no matching claim");
      }
      if (existing.execution_probe_ref === null) {
        try {
          const updated = await database.prepare("UPDATE model_route_qualification_probe SET execution_probe_ref = ?, observation_sha256 = ?, observation_json = ? WHERE probe_idempotency_key = ? AND probe_input_sha256 = ? AND claim_ref = ? AND execution_probe_ref IS NULL")
            .bind(ref, digest, json, key, hash, claimRef).run();
          if (!updated.success) throw new Error("Qualification observation write failed");
        } catch {
          // Readback may reconcile only the observation write, never a model call.
        }
      }
      const persisted = await byKey(key);
      if (persisted === null || persisted.claim_ref !== claimRef || persisted.observation_json !== json || persisted.execution_probe_ref !== ref) {
        throw new Error("Qualification observation persistence is uncertain or conflicts");
      }
      const result = await receipt(persisted);
      if (result === null) throw new Error("Qualification observation receipt is missing");
      return result;
    },
    async read(ref: string) {
      requireString(ref, IDENTIFIER, "execution reference");
      const row = await database.prepare(`SELECT ${COLUMNS} FROM model_route_qualification_probe WHERE execution_probe_ref = ?`)
        .bind(ref).first<ProbeRow>();
      return row === null ? null : receipt(row);
    },
  });
}

/** Private bootstrap output; does not invent workflow attempts or report authority. */
export function createR2ResearchModelQualificationOutputStore(
  bucket: R2Bucket,
  options: { readonly object_ref: string; readonly max_output_bytes: number },
): ModelGatewayOutputStorePort {
  const match = /^model-qualification-output-([a-f0-9]{64})$/u.exec(options.object_ref);
  if (match === null || !Number.isSafeInteger(options.max_output_bytes) || options.max_output_bytes < 1 || options.max_output_bytes > 262144) {
    throw new Error("Invalid qualification output configuration");
  }
  const expectedRef = options.object_ref;
  const maxBytes = options.max_output_bytes;
  const key = `research/model-qualification/${match[1]}.json`;
  return Object.freeze({
    async putImmutable(ref: string, body: ReadableStream<Uint8Array>, expectedSha256: string) {
      if (ref !== expectedRef) throw new Error("Qualification output reference differs from prepared call");
      requireString(expectedSha256, SHA256, "output digest");
      const bytes = await bufferBounded(body, maxBytes);
      if (await modelGatewaySha256(bytes) !== expectedSha256) throw new Error("Qualification output digest mismatch");
      try {
        await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: "application/json" }, customMetadata: { sha256: expectedSha256 } });
      } catch {
        // An existing, identical object is sufficient after an ambiguous put.
      }
      const stored = await bucket.get(key);
      if (stored === null) throw new Error("Qualification output is not readable");
      const actual = await bufferBounded(stored.body, maxBytes);
      if (await modelGatewaySha256(actual) !== expectedSha256) throw new Error("Qualification output readback differs");
      return Object.freeze({ object_ref: ref, readback_sha256: expectedSha256 });
    },
  });
}
