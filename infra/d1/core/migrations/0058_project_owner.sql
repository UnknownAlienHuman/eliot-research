PRAGMA foreign_keys = ON;

-- Owner-owned project metadata.  The principal is durable and is never
-- inferred from a project request after this row has been created.
CREATE TABLE project_owner (
  project_id TEXT PRIMARY KEY REFERENCES project(project_id),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL CHECK(
    created_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(created_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  updated_at TEXT NOT NULL CHECK(
    updated_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(updated_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at
  )
) STRICT;

CREATE INDEX project_owner_principal_idx
  ON project_owner(principal_ref, project_id);

-- A D1 batch has no conditional statement flow.  This transaction-local
-- sentinel turns the first CAS result into a rollback before memberships or
-- the receipt can be touched.  The service inserts it immediately after the
-- project INSERT/UPDATE; its trigger observes the preceding statement's
-- changes() value and aborts when the CAS did not change exactly one row.
CREATE TABLE project_mutation_guard (
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  operation TEXT NOT NULL CHECK(operation IN ('CREATE','UPDATE')),
  project_id TEXT NOT NULL REFERENCES project(project_id),
  expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
  next_revision INTEGER NOT NULL CHECK(next_revision > 0),
  created_at TEXT NOT NULL CHECK(
    created_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(created_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  PRIMARY KEY(principal_ref, idempotency_key)
) STRICT;

CREATE TRIGGER project_mutation_guard_requires_cas
BEFORE INSERT ON project_mutation_guard
WHEN changes() <> 1
BEGIN
  SELECT RAISE(ABORT, 'project mutation compare-and-set did not change exactly one row');
END;

CREATE TRIGGER project_mutation_guard_immutable_update
BEFORE UPDATE ON project_mutation_guard
BEGIN
  SELECT RAISE(ABORT, 'project mutation guards are immutable');
END;

CREATE TRIGGER project_owner_principal_immutable
BEFORE UPDATE ON project_owner
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.principal_ref IS NOT OLD.principal_ref
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'project owner identity is immutable');
END;

CREATE TRIGGER project_owner_delete_forbidden
BEFORE DELETE ON project_owner
BEGIN
  SELECT RAISE(ABORT, 'project owner identity cannot be deleted');
END;

-- The response is the durable idempotency receipt.  It is deliberately
-- separate from project rows so a lost response can be replayed byte-for-byte
-- without using a request body as authority.
CREATE TABLE project_mutation_receipt (
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  operation TEXT NOT NULL CHECK(operation IN ('CREATE','UPDATE')),
  project_id TEXT NOT NULL REFERENCES project(project_id),
  request_sha256 TEXT NOT NULL CHECK(
    length(request_sha256) = 64
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  response_json TEXT NOT NULL CHECK(
    json_valid(response_json)
    AND length(CAST(response_json AS BLOB)) BETWEEN 1 AND 262144
  ),
  response_sha256 TEXT NOT NULL CHECK(
    length(response_sha256) = 64
    AND response_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  project_revision INTEGER NOT NULL CHECK(project_revision > 0),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL CHECK(
    created_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(created_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  PRIMARY KEY(principal_ref, idempotency_key)
) STRICT;

CREATE INDEX project_mutation_receipt_project_idx
  ON project_mutation_receipt(project_id, project_revision);

CREATE TRIGGER project_mutation_receipt_owner_guard
BEFORE INSERT ON project_mutation_receipt
BEGIN
  SELECT RAISE(ABORT, 'project mutation receipt owner mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM project_owner o
    WHERE o.project_id = NEW.project_id
      AND o.principal_ref = NEW.principal_ref
  );
  SELECT RAISE(ABORT, 'project mutation receipt revision mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM project p
    WHERE p.project_id = NEW.project_id
      AND p.generation = NEW.project_revision
  );
  SELECT RAISE(ABORT, 'project mutation receipt deployment mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM project_owner o
    WHERE o.project_id = NEW.project_id
      AND o.principal_ref = NEW.principal_ref
      AND o.deployment_generation = NEW.deployment_generation
  );
  SELECT RAISE(ABORT, 'project mutation receipt membership mismatch')
  WHERE (
    SELECT COUNT(*) FROM project_source_membership m
    WHERE m.project_id = NEW.project_id AND m.valid_to IS NULL
  ) <> json_array_length(json_extract(NEW.response_json, '$.source_ids'))
    OR json_type(json_extract(NEW.response_json, '$.source_ids')) IS NOT 'array';
END;

CREATE TRIGGER project_mutation_receipt_immutable_update
BEFORE UPDATE ON project_mutation_receipt
BEGIN
  SELECT RAISE(ABORT, 'project mutation receipts are immutable');
END;

CREATE TRIGGER project_mutation_receipt_immutable_delete
BEFORE DELETE ON project_mutation_receipt
BEGIN
  SELECT RAISE(ABORT, 'project mutation receipts cannot be deleted');
END;
