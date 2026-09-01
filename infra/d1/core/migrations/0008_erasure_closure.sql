PRAGMA foreign_keys = ON;

CREATE TABLE erasure_execution (
  erasure_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN (
    'REQUESTED','QUARANTINE_AND_REVOKE','ENUMERATE_DEPENDENCY_CLOSURE',
    'CHECK_RETENTION_AND_HOLDS','PURGE_EACH_LOCATION','VERIFY_ABSENCE_OR_BLOCK',
    'APPEND_PURGE_LEDGER','INVALIDATE_DEPENDENTS','COMPLETE','BLOCKED','FAILED'
  )),
  lease_owner TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_until INTEGER,
  closure_digest TEXT CHECK (
    closure_digest IS NULL OR (
      length(closure_digest) = 64 AND closure_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  terminal_receipt_json TEXT CHECK (
    terminal_receipt_json IS NULL OR json_valid(terminal_receipt_json)
  ),
  terminal_receipt_sha256 TEXT CHECK (
    terminal_receipt_sha256 IS NULL OR (
      length(terminal_receipt_sha256) = 64 AND terminal_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  purge_ledger_revision INTEGER REFERENCES purge_ledger(ledger_revision),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(erasure_id, revision),
  FOREIGN KEY(erasure_id, revision) REFERENCES erasure_case(erasure_id, revision),
  CHECK (
    (lease_owner IS NULL AND lease_until IS NULL)
    OR
    (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
  ),
  CHECK (
    (state IN ('COMPLETE','BLOCKED') AND terminal_receipt_json IS NOT NULL
      AND terminal_receipt_sha256 IS NOT NULL AND purge_ledger_revision IS NOT NULL)
    OR
    (state NOT IN ('COMPLETE','BLOCKED') AND terminal_receipt_json IS NULL
      AND terminal_receipt_sha256 IS NULL)
  )
) STRICT;
CREATE UNIQUE INDEX erasure_request_digest_unique
  ON erasure_execution(request_sha256);
CREATE INDEX erasure_execution_claim_idx
  ON erasure_execution(state, lease_until, updated_at);
CREATE UNIQUE INDEX purge_ledger_erasure_receipt_unique
  ON purge_ledger(erasure_id, receipt_ref);

CREATE TABLE erasure_dependency_registry (
  dependency_id TEXT PRIMARY KEY,
  exact_subject_ref TEXT NOT NULL,
  location TEXT NOT NULL CHECK (location IN (
    'CanonicalPayload','Projection','Index','Blob','OperationalRecovery',
    'ProviderCopy','BackupRestorePath','RouteContinuation'
  )),
  canonical_ref TEXT NOT NULL,
  provider_ref TEXT,
  object_identity_digest TEXT NOT NULL CHECK (
    length(object_identity_digest) = 64 AND object_identity_digest NOT GLOB '*[^0-9a-f]*'
  ),
  shared_reference_key TEXT,
  retention_or_hold_ref TEXT,
  next_review_at TEXT,
  declassification_receipt_ref TEXT,
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','REDACTED','DELETED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(exact_subject_ref, location, canonical_ref)
) STRICT;
CREATE INDEX erasure_dependency_subject_idx
  ON erasure_dependency_registry(exact_subject_ref, state, location);
CREATE INDEX erasure_dependency_shared_idx
  ON erasure_dependency_registry(shared_reference_key, state)
  WHERE shared_reference_key IS NOT NULL;

CREATE TABLE erasure_hold (
  hold_ref TEXT PRIMARY KEY,
  exact_subject_ref TEXT,
  location TEXT CHECK (location IS NULL OR location IN (
    'CanonicalPayload','Projection','Index','Blob','OperationalRecovery',
    'ProviderCopy','BackupRestorePath','RouteContinuation'
  )),
  canonical_ref TEXT,
  policy_or_hold_ref TEXT NOT NULL,
  next_review_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','RELEASED')),
  created_at TEXT NOT NULL,
  released_at TEXT,
  CHECK (
    exact_subject_ref IS NOT NULL OR location IS NOT NULL OR canonical_ref IS NOT NULL
  )
) STRICT;
CREATE INDEX erasure_hold_match_idx
  ON erasure_hold(state, exact_subject_ref, location, canonical_ref);

CREATE TABLE erasure_target (
  erasure_id TEXT NOT NULL,
  erasure_revision INTEGER NOT NULL CHECK (erasure_revision > 0),
  target_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('OBJECT','LOCATION_EMPTY_PROOF')),
  exact_subject_ref TEXT NOT NULL,
  location TEXT NOT NULL CHECK (location IN (
    'CanonicalPayload','Projection','Index','Blob','OperationalRecovery',
    'ProviderCopy','BackupRestorePath','RouteContinuation'
  )),
  canonical_ref TEXT NOT NULL,
  provider_ref TEXT,
  identity_digest TEXT NOT NULL CHECK (
    length(identity_digest) = 64 AND identity_digest NOT GLOB '*[^0-9a-f]*'
  ),
  shared_live_reference_count INTEGER NOT NULL DEFAULT 0 CHECK (shared_live_reference_count >= 0),
  retention_or_hold_ref TEXT,
  next_review_at TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'ENUMERATED','QUARANTINED','BLOCKED','PURGE_REQUESTED','ABSENT','FAILED'
  )),
  delete_receipt_ref TEXT,
  absence_receipt_ref TEXT,
  last_error_code TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(erasure_id, erasure_revision, target_id),
  UNIQUE(erasure_id, erasure_revision, location, canonical_ref),
  FOREIGN KEY(erasure_id, erasure_revision)
    REFERENCES erasure_execution(erasure_id, revision)
) STRICT;
CREATE INDEX erasure_target_state_idx
  ON erasure_target(erasure_id, erasure_revision, state, location);

CREATE TABLE erasure_stage_receipt (
  erasure_id TEXT NOT NULL,
  erasure_revision INTEGER NOT NULL CHECK (erasure_revision > 0),
  stage TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  receipt_ref TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK (
    length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY(erasure_id, erasure_revision, stage),
  FOREIGN KEY(erasure_id, erasure_revision)
    REFERENCES erasure_execution(erasure_id, revision)
) STRICT;

CREATE TABLE erasure_dependent_invalidation (
  erasure_id TEXT NOT NULL,
  erasure_revision INTEGER NOT NULL CHECK (erasure_revision > 0),
  dependent_ref TEXT NOT NULL,
  dependent_kind TEXT NOT NULL CHECK (dependent_kind IN (
    'EvidenceHandle','ScopeSnapshot','WikiRevision','ArtifactRevision',
    'Investigation','ProjectionGeneration','RouteContinuation'
  )),
  disposition TEXT NOT NULL CHECK (disposition IN (
    'REDACTED','PENDING_REVALIDATION','RETIRED','REVOKED'
  )),
  receipt_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(erasure_id, erasure_revision, dependent_ref),
  FOREIGN KEY(erasure_id, erasure_revision)
    REFERENCES erasure_execution(erasure_id, revision)
) STRICT;

CREATE TABLE backup_purge_obligation (
  erasure_id TEXT NOT NULL,
  erasure_revision INTEGER NOT NULL CHECK (erasure_revision > 0),
  backup_epoch_id TEXT NOT NULL REFERENCES backup_epoch(backup_epoch_id),
  target_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','BLOCKED','ABSENT')),
  policy_or_hold_ref TEXT,
  next_review_at TEXT,
  delete_receipt_ref TEXT,
  absence_receipt_ref TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(erasure_id, erasure_revision, backup_epoch_id),
  FOREIGN KEY(erasure_id, erasure_revision, target_id)
    REFERENCES erasure_target(erasure_id, erasure_revision, target_id)
) STRICT;

CREATE TABLE erasure_terminal_guard (
  erasure_id TEXT NOT NULL,
  erasure_revision INTEGER NOT NULL CHECK (erasure_revision > 0),
  closure_digest TEXT NOT NULL CHECK (
    length(closure_digest) = 64 AND closure_digest NOT GLOB '*[^0-9a-f]*'
  ),
  requested_locations_json TEXT NOT NULL CHECK (json_valid(requested_locations_json)),
  completed_locations_json TEXT NOT NULL CHECK (json_valid(completed_locations_json)),
  blocked_locations_json TEXT NOT NULL CHECK (json_valid(blocked_locations_json)),
  terminal_state TEXT NOT NULL CHECK (terminal_state IN ('COMPLETE','BLOCKED')),
  receipt_sha256 TEXT NOT NULL CHECK (
    length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  purge_ledger_revision INTEGER NOT NULL REFERENCES purge_ledger(ledger_revision),
  verified INTEGER NOT NULL CHECK (verified = 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY(erasure_id, erasure_revision),
  FOREIGN KEY(erasure_id, erasure_revision)
    REFERENCES erasure_execution(erasure_id, revision),
  CHECK (
    (terminal_state = 'COMPLETE'
      AND requested_locations_json = completed_locations_json
      AND json_array_length(blocked_locations_json) = 0)
    OR
    (terminal_state = 'BLOCKED'
      AND json_array_length(blocked_locations_json) > 0)
  )
) STRICT;

UPDATE schema_state
SET value = 'core-v8-erasure-closure',
    updated_at = '2026-09-01T02:00:00Z'
WHERE key = 'schema_generation';
