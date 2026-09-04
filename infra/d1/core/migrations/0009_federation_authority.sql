PRAGMA foreign_keys = ON;

-- This is an additive shadow schema. The Core schema generation remains at v8 until
-- ER-24 composes and exposes the federation runtime, at which point a later migration
-- advances the required generation atomically with that composition.
CREATE TABLE federation_reference_manifest (
  manifest_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  manifest_json TEXT NOT NULL CHECK (
    json_valid(manifest_json)
    AND length(CAST(manifest_json AS BLOB)) <= 524288
  ),
  manifest_digest TEXT NOT NULL CHECK (
    length(manifest_digest) = 64
    AND manifest_digest NOT GLOB '*[^0-9a-f]*'
  ),
  scope_snapshot_id TEXT NOT NULL,
  scope_snapshot_revision INTEGER NOT NULL CHECK (scope_snapshot_revision > 0),
  client_fence_ref TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (manifest_id, revision),
  CHECK (json_extract(manifest_json, '$.manifest_ref.id') = manifest_id),
  CHECK (json_extract(manifest_json, '$.manifest_ref.revision') = revision),
  CHECK (json_extract(manifest_json, '$.manifest_digest') = manifest_digest),
  CHECK (json_extract(manifest_json, '$.scope_snapshot_ref.id') = scope_snapshot_id),
  CHECK (json_extract(manifest_json, '$.scope_snapshot_ref.revision') = scope_snapshot_revision),
  CHECK (json_extract(manifest_json, '$.expires_at') = expires_at),
  CHECK (
    (client_fence_ref IS NULL AND json_type(manifest_json, '$.client_fence_ref') IS NULL)
    OR
    (client_fence_ref IS NOT NULL
      AND json_extract(manifest_json, '$.client_fence_ref') = client_fence_ref)
  )
) STRICT;
CREATE INDEX federation_manifest_expiry_idx
  ON federation_reference_manifest(expires_at, manifest_id, revision);
CREATE INDEX federation_manifest_scope_idx
  ON federation_reference_manifest(scope_snapshot_id, scope_snapshot_revision);
CREATE INDEX federation_manifest_fence_idx
  ON federation_reference_manifest(client_fence_ref)
  WHERE client_fence_ref IS NOT NULL;

CREATE TABLE federation_job (
  job_id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64
    AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  request_json TEXT NOT NULL CHECK (
    json_valid(request_json)
    AND length(CAST(request_json AS BLOB)) <= 262144
  ),
  requester_principal_ref TEXT NOT NULL,
  requester_credential_generation TEXT NOT NULL,
  server_principal_ref TEXT NOT NULL,
  server_credential_generation TEXT NOT NULL,
  bridge_generation TEXT NOT NULL,
  client_fence_ref TEXT NOT NULL,
  allowed_manifest_id TEXT NOT NULL,
  allowed_manifest_revision INTEGER NOT NULL CHECK (allowed_manifest_revision > 0),
  origin_trace_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  transport_state TEXT NOT NULL CHECK (transport_state IN (
    'ACCEPTED','RUNNING','PARTIAL','BLOCKED','CANCELLED','COMPLETED','FAILED'
  )),
  status_json TEXT NOT NULL CHECK (
    json_valid(status_json)
    AND length(CAST(status_json AS BLOB)) <= 262144
  ),
  observed_completion_disposition TEXT CHECK (
    observed_completion_disposition IS NULL
    OR observed_completion_disposition IN (
      'ANSWERED_WITH_SUPPORTED_RESULT','NO_MATCH_IN_COMPLETE_SCOPE',
      'NO_NEW_USEFUL_EVIDENCE','SOURCE_UNAVAILABLE','STALE_SOURCE_OR_INDEX',
      'POLICY_OR_DISCLOSURE_DENIED','INCOMPLETE_COVERAGE','INCONCLUSIVE','CANCELLED'
    )
  ),
  result_json TEXT CHECK (
    result_json IS NULL
    OR (
      json_valid(result_json)
      AND length(CAST(result_json AS BLOB)) <= 1048576
    )
  ),
  cancellation_reason TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (exchange_id, idempotency_key),
  FOREIGN KEY (allowed_manifest_id, allowed_manifest_revision)
    REFERENCES federation_reference_manifest(manifest_id, revision),
  CHECK (json_extract(request_json, '$.protocol') = 'eliotr.federation.v1'),
  CHECK (json_extract(request_json, '$.exchange_id') = exchange_id),
  CHECK (json_extract(request_json, '$.idempotency_key') = idempotency_key),
  CHECK (json_extract(request_json, '$.requester_principal_ref') = requester_principal_ref),
  CHECK (json_extract(request_json, '$.bridge_generation') = bridge_generation),
  CHECK (json_extract(request_json, '$.client_fence_ref') = client_fence_ref),
  CHECK (json_extract(status_json, '$.exchange_id') = exchange_id),
  CHECK (json_extract(status_json, '$.idempotency_key') = idempotency_key),
  CHECK (json_extract(status_json, '$.job_id') = job_id),
  CHECK (json_extract(status_json, '$.attempt') = attempt),
  CHECK (json_extract(status_json, '$.transport_state') = transport_state),
  CHECK (
    (transport_state = 'CANCELLED'
      AND observed_completion_disposition = 'CANCELLED'
      AND json_extract(status_json, '$.completion_disposition') = 'CANCELLED'
      AND cancellation_reason IS NOT NULL
      AND cancelled_at IS NOT NULL
      AND result_json IS NULL)
    OR
    (transport_state <> 'CANCELLED'
      AND cancellation_reason IS NULL
      AND cancelled_at IS NULL)
  )
) STRICT;
CREATE INDEX federation_job_principal_idx
  ON federation_job(requester_principal_ref, exchange_id, idempotency_key);
CREATE INDEX federation_job_state_idx
  ON federation_job(transport_state, updated_at, job_id);
CREATE INDEX federation_job_manifest_idx
  ON federation_job(allowed_manifest_id, allowed_manifest_revision);
