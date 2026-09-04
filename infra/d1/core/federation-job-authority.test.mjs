import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDirectory = resolve(root, "infra/d1/core/migrations");
const database = new DatabaseSync(":memory:");

for (const name of (await readdir(migrationsDirectory)).filter((entry) => entry.endsWith(".sql")).sort()) {
  database.exec(await readFile(resolve(migrationsDirectory, name), "utf8"));
}

assert.equal(
  database.prepare("SELECT value FROM schema_state WHERE key='schema_generation'").get()?.value,
  "core-v9-federation-job-authority",
);
const strictTables = new Map(
  database.prepare("PRAGMA table_list").all().map((row) => [row.name, row.strict]),
);
assert.equal(strictTables.get("federation_job"), 1, "federation_job must be STRICT");

const authority = {
  requester_principal_ref: "client-principal",
  requester_credential_generation: "client-credential-generation-1",
  server_principal_ref: "server-principal",
  server_credential_generation: "server-credential-generation-1",
  bridge_generation: "bridge-generation-1",
  client_fence_ref: "client-fence-1",
  allowed_reference_manifest_id: "allowed-reference-manifest",
  allowed_reference_manifest_revision: 1,
  exchange_id: "exchange-1",
  idempotency_key: "idempotency-1",
};
const request = {
  protocol: "eliotr.federation.v1",
  exchange_id: authority.exchange_id,
  bridge_generation: authority.bridge_generation,
  idempotency_key: authority.idempotency_key,
  requester_principal_ref: authority.requester_principal_ref,
  client_fence_ref: authority.client_fence_ref,
};
const status = {
  exchange_id: authority.exchange_id,
  idempotency_key: authority.idempotency_key,
  job_id: "federation-job-1",
  attempt: 1,
  transport_state: "ACCEPTED",
  completion_disposition: null,
  completed_obligation_refs: [],
  partial_bundle_refs: [],
  open_research_debt_refs: [],
};
const digest = "a".repeat(64);
const now = "2026-09-04T13:10:00.000Z";

const columns = [
  "requester_principal_ref",
  "requester_credential_generation",
  "server_principal_ref",
  "server_credential_generation",
  "bridge_generation",
  "client_fence_ref",
  "allowed_reference_manifest_id",
  "allowed_reference_manifest_revision",
  "exchange_id",
  "idempotency_key",
  "request_digest",
  "request_json",
  "job_id",
  "attempt",
  "transport_state",
  "completion_disposition",
  "status_json",
  "observed_completion_disposition",
  "result_json",
  "cancellation_reason",
  "state_version",
  "created_at",
  "updated_at",
];
const insert = database.prepare(
  `INSERT INTO federation_job(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
);

function values(overrides = {}) {
  const row = {
    ...authority,
    request_digest: digest,
    request_json: JSON.stringify(request),
    job_id: status.job_id,
    attempt: 1,
    transport_state: "ACCEPTED",
    completion_disposition: null,
    status_json: JSON.stringify(status),
    observed_completion_disposition: null,
    result_json: null,
    cancellation_reason: null,
    state_version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  return columns.map((column) => row[column]);
}

insert.run(...values());
const readback = database.prepare(
  "SELECT request_digest, job_id, transport_state, state_version FROM federation_job " +
    "WHERE requester_principal_ref=? AND exchange_id=? AND idempotency_key=?",
).get(authority.requester_principal_ref, authority.exchange_id, authority.idempotency_key);
assert.deepEqual(readback, {
  request_digest: digest,
  job_id: status.job_id,
  transport_state: "ACCEPTED",
  state_version: 1,
});

assert.throws(
  () => insert.run(...values({ request_digest: "b".repeat(64), job_id: "federation-job-2" })),
  /UNIQUE constraint failed|PRIMARY KEY/u,
  "one exact authority and idempotency identity cannot reserve two jobs",
);

const foreignRequest = { ...request, exchange_id: "other-exchange" };
assert.throws(
  () => insert.run(...values({
    exchange_id: "exchange-2",
    idempotency_key: "idempotency-2",
    job_id: "federation-job-2",
    request_json: JSON.stringify(foreignRequest),
    status_json: JSON.stringify({
      ...status,
      exchange_id: "exchange-2",
      idempotency_key: "idempotency-2",
      job_id: "federation-job-2",
    }),
  })),
  /CHECK constraint failed/u,
  "request bytes cannot claim another exchange identity",
);

const activeWithOutcome = {
  ...status,
  exchange_id: "exchange-3",
  idempotency_key: "idempotency-3",
  job_id: "federation-job-3",
  completion_disposition: "INCONCLUSIVE",
};
assert.throws(
  () => insert.run(...values({
    exchange_id: activeWithOutcome.exchange_id,
    idempotency_key: activeWithOutcome.idempotency_key,
    job_id: activeWithOutcome.job_id,
    request_json: JSON.stringify({
      ...request,
      exchange_id: activeWithOutcome.exchange_id,
      idempotency_key: activeWithOutcome.idempotency_key,
    }),
    completion_disposition: "INCONCLUSIVE",
    status_json: JSON.stringify(activeWithOutcome),
  })),
  /CHECK constraint failed/u,
  "active transport cannot expose a terminal research outcome",
);

const completedWithoutObserved = {
  ...status,
  exchange_id: "exchange-4",
  idempotency_key: "idempotency-4",
  job_id: "federation-job-4",
  transport_state: "COMPLETED",
  completion_disposition: "INCONCLUSIVE",
};
assert.throws(
  () => insert.run(...values({
    exchange_id: completedWithoutObserved.exchange_id,
    idempotency_key: completedWithoutObserved.idempotency_key,
    job_id: completedWithoutObserved.job_id,
    request_json: JSON.stringify({
      ...request,
      exchange_id: completedWithoutObserved.exchange_id,
      idempotency_key: completedWithoutObserved.idempotency_key,
    }),
    transport_state: "COMPLETED",
    completion_disposition: "INCONCLUSIVE",
    status_json: JSON.stringify(completedWithoutObserved),
  })),
  /CHECK constraint failed/u,
  "completed transport requires an independently observed disposition",
);

const cancelled = {
  ...status,
  exchange_id: "exchange-5",
  idempotency_key: "idempotency-5",
  job_id: "federation-job-5",
  transport_state: "CANCELLED",
  completion_disposition: "CANCELLED",
  cancellation_receipt_ref: "cancellation-receipt-5",
};
assert.throws(
  () => insert.run(...values({
    exchange_id: cancelled.exchange_id,
    idempotency_key: cancelled.idempotency_key,
    job_id: cancelled.job_id,
    request_json: JSON.stringify({
      ...request,
      exchange_id: cancelled.exchange_id,
      idempotency_key: cancelled.idempotency_key,
    }),
    transport_state: "CANCELLED",
    completion_disposition: "CANCELLED",
    observed_completion_disposition: "CANCELLED",
    status_json: JSON.stringify(cancelled),
  })),
  /CHECK constraint failed/u,
  "cancelled transport requires a bounded cancellation reason",
);

console.log(
  "Federation job authority migration: PASS (strict identity, request/status binding, terminal-state guards).",
);
