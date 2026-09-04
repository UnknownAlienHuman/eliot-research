PRAGMA foreign_keys = ON;

CREATE TABLE federation_job (
  requester_principal_ref TEXT NOT NULL CHECK (
    length(requester_principal_ref) BETWEEN 1 AND 256
    AND substr(requester_principal_ref, 1, 1) GLOB '[A-Za-z0-9]'
    AND requester_principal_ref NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  requester_credential_generation TEXT NOT NULL CHECK (
    length(requester_credential_generation) BETWEEN 1 AND 256
    AND substr(requester_credential_generation, 1, 1) GLOB '[A-Za-z0-9]'
    AND requester_credential_generation NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  server_principal_ref TEXT NOT NULL CHECK (
    length(server_principal_ref) BETWEEN 1 AND 256
    AND substr(server_principal_ref, 1, 1) GLOB '[A-Za-z0-9]'
    AND server_principal_ref NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  server_credential_generation TEXT NOT NULL CHECK (
    length(server_credential_generation) BETWEEN 1 AND 256
    AND substr(server_credential_generation, 1, 1) GLOB '[A-Za-z0-9]'
    AND server_credential_generation NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  bridge_generation TEXT NOT NULL CHECK (
    length(bridge_generation) BETWEEN 1 AND 256
    AND substr(bridge_generation, 1, 1) GLOB '[A-Za-z0-9]'
    AND bridge_generation NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  client_fence_ref TEXT NOT NULL CHECK (
    length(client_fence_ref) BETWEEN 1 AND 256
    AND substr(client_fence_ref, 1, 1) GLOB '[A-Za-z0-9]'
    AND client_fence_ref NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  allowed_reference_manifest_id TEXT NOT NULL CHECK (
    length(allowed_reference_manifest_id) BETWEEN 1 AND 256
    AND substr(allowed_reference_manifest_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND allowed_reference_manifest_id NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  allowed_reference_manifest_revision INTEGER NOT NULL CHECK (
    allowed_reference_manifest_revision > 0
  ),
  exchange_id TEXT NOT NULL CHECK (
    length(exchange_id) BETWEEN 1 AND 256
    AND substr(exchange_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND exchange_id NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 256
    AND substr(idempotency_key, 1, 1) GLOB '[A-Za-z0-9]'
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64
    AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  request_json TEXT NOT NULL CHECK (
    length(CAST(request_json AS BLOB)) <= 262144
    AND json_valid(request_json)
    AND json_extract(request_json, '$.protocol') = 'eliotr.federation.v1'
    AND json_extract(request_json, '$.exchange_id') = exchange_id
    AND json_extract(request_json, '$.bridge_generation') = bridge_generation
    AND json_extract(request_json, '$.idempotency_key') = idempotency_key
    AND json_extract(request_json, '$.requester_principal_ref') = requester_principal_ref
    AND json_extract(request_json, '$.client_fence_ref') = client_fence_ref
  ),
  job_id TEXT NOT NULL UNIQUE CHECK (
    length(job_id) BETWEEN 1 AND 256
    AND substr(job_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND job_id NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  transport_state TEXT NOT NULL CHECK (
    transport_state IN (
      'ACCEPTED', 'RUNNING', 'PARTIAL', 'BLOCKED',
      'CANCELLED', 'COMPLETED', 'FAILED'
    )
  ),
  completion_disposition TEXT CHECK (
    completion_disposition IS NULL OR completion_disposition IN (
      'ANSWERED_WITH_SUPPORTED_RESULT',
      'ANSWERED_WITH_LIMITATIONS',
      'INCONCLUSIVE',
      'NO_QUALIFIED_EVIDENCE',
      'POLICY_BLOCKED',
      'BUDGET_EXHAUSTED',
      'DEADLINE_EXCEEDED',
      'CANCELLED',
      'FAILED'
    )
  ),
  status_json TEXT NOT NULL CHECK (
    length(CAST(status_json AS BLOB)) <= 262144
    AND json_valid(status_json)
    AND json_extract(status_json, '$.exchange_id') = exchange_id
    AND json_extract(status_json, '$.idempotency_key') = idempotency_key
    AND json_extract(status_json, '$.job_id') = job_id
    AND json_extract(status_json, '$.attempt') = attempt
    AND json_extract(status_json, '$.transport_state') = transport_state
    AND (
      (completion_disposition IS NULL
        AND json_type(status_json, '$.completion_disposition') = 'null')
      OR json_extract(status_json, '$.completion_disposition') = completion_disposition
    )
  ),
  observed_completion_disposition TEXT CHECK (
    observed_completion_disposition IS NULL OR observed_completion_disposition IN (
      'ANSWERED_WITH_SUPPORTED_RESULT',
      'ANSWERED_WITH_LIMITATIONS',
      'INCONCLUSIVE',
      'NO_QUALIFIED_EVIDENCE',
      'POLICY_BLOCKED',
      'BUDGET_EXHAUSTED',
      'DEADLINE_EXCEEDED',
      'CANCELLED',
      'FAILED'
    )
  ),
  result_json TEXT CHECK (
    result_json IS NULL OR (
      length(CAST(result_json AS BLOB)) <= 1048576
      AND json_valid(result_json)
      AND json_extract(result_json, '$.protocol') = 'eliotr.federation.v1'
      AND json_extract(result_json, '$.exchange_id') = exchange_id
      AND json_extract(result_json, '$.job_id') = job_id
      AND json_extract(result_json, '$.request_digest') = request_digest
    )
  ),
  cancellation_reason TEXT CHECK (
    cancellation_reason IS NULL OR (
      length(CAST(cancellation_reason AS BLOB)) BETWEEN 1 AND 4096
      AND cancellation_reason = trim(cancellation_reason)
    )
  ),
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 35),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 35),
  PRIMARY KEY (
    requester_principal_ref,
    requester_credential_generation,
    server_principal_ref,
    server_credential_generation,
    bridge_generation,
    client_fence_ref,
    exchange_id,
    idempotency_key
  ),
  CHECK (
    (transport_state IN ('ACCEPTED', 'RUNNING', 'PARTIAL', 'BLOCKED')
      AND completion_disposition IS NULL
      AND observed_completion_disposition IS NULL
      AND result_json IS NULL)
    OR (transport_state = 'FAILED'
      AND completion_disposition IS NULL
      AND observed_completion_disposition IS NULL
      AND result_json IS NULL)
    OR (transport_state = 'CANCELLED'
      AND completion_disposition = 'CANCELLED'
      AND observed_completion_disposition = 'CANCELLED'
      AND result_json IS NULL
      AND cancellation_reason IS NOT NULL)
    OR (transport_state = 'COMPLETED'
      AND completion_disposition IS NOT NULL
      AND observed_completion_disposition IS NOT NULL)
  )
) STRICT;

CREATE INDEX federation_job_transport_state_idx
ON federation_job(transport_state, updated_at, job_id);

UPDATE schema_state
SET value = 'core-v9-federation-job-authority',
    updated_at = '2026-09-04T13:10:00Z'
WHERE key = 'schema_generation';
