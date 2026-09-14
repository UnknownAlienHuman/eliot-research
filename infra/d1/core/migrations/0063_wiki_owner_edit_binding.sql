PRAGMA foreign_keys = ON;

-- An owner edit binding records the immutable relationship between a new
-- proposal and the published page revision it was derived from.  The
-- proposal/revision rows and the publication head remain the authoritative
-- objects; this row is the transaction witness used by the owner-edit path.
CREATE TABLE IF NOT EXISTS wiki_owner_edit_binding (
  proposal_id TEXT NOT NULL CHECK(length(proposal_id) BETWEEN 1 AND 256),
  proposal_revision INTEGER NOT NULL DEFAULT 1 CHECK(proposal_revision = 1),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  request_sha256 TEXT NOT NULL CHECK(
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  proposal_page_sha256 TEXT NOT NULL CHECK(
    length(proposal_page_sha256) = 64 AND proposal_page_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  base_proposal_id TEXT NOT NULL CHECK(length(base_proposal_id) BETWEEN 1 AND 256),
  base_proposal_revision INTEGER NOT NULL DEFAULT 1 CHECK(base_proposal_revision = 1),
  base_page_id TEXT NOT NULL CHECK(length(base_page_id) BETWEEN 1 AND 256),
  base_page_revision INTEGER NOT NULL CHECK(base_page_revision > 0),
  base_page_sha256 TEXT NOT NULL CHECK(
    length(base_page_sha256) = 64 AND base_page_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (proposal_id, proposal_revision),
  UNIQUE (principal_ref, idempotency_key),
  FOREIGN KEY (proposal_id, proposal_revision)
    REFERENCES wiki_publication_proposal(proposal_id, proposal_revision),
  FOREIGN KEY (base_proposal_id, base_proposal_revision)
    REFERENCES wiki_publication_proposal(proposal_id, proposal_revision),
  FOREIGN KEY (base_page_id, base_page_revision)
    REFERENCES wiki_publication_revision(page_id, revision)
) STRICT;

CREATE INDEX IF NOT EXISTS wiki_owner_edit_binding_base_idx
  ON wiki_owner_edit_binding(base_proposal_id, base_proposal_revision, principal_ref);

CREATE TRIGGER IF NOT EXISTS wiki_owner_edit_binding_immutable_update
BEFORE UPDATE ON wiki_owner_edit_binding
BEGIN
  SELECT RAISE(ABORT, 'WIKI_OWNER_EDIT_BINDING_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS wiki_owner_edit_binding_immutable_delete
BEFORE DELETE ON wiki_owner_edit_binding
BEGIN
  SELECT RAISE(ABORT, 'WIKI_OWNER_EDIT_BINDING_IMMUTABLE');
END;

-- The target proposal is the owner DRAFT for the next page revision and its
-- stored proposal hash must be the value carried by the binding.
CREATE TRIGGER IF NOT EXISTS wiki_owner_edit_binding_target_guard
BEFORE INSERT ON wiki_owner_edit_binding
BEGIN
  SELECT RAISE(ABORT, 'WIKI_OWNER_EDIT_PROPOSAL_STALE')
  WHERE NOT EXISTS (
    SELECT 1
    FROM wiki_publication_proposal p
    WHERE p.proposal_id = NEW.proposal_id
      AND p.proposal_revision = NEW.proposal_revision
      AND p.principal_ref = NEW.principal_ref
      AND p.idempotency_key = NEW.idempotency_key
      AND p.page_id = NEW.base_page_id
      AND p.page_revision = NEW.base_page_revision + 1
      AND p.page_sha256 = NEW.proposal_page_sha256
      AND p.risk_class = 'D2_ANALYTICAL'
      AND p.state = 'PROPOSED'
      AND json_valid(p.page_json) = 1
  );
END;

-- Page identity, DRAFT status, and supersession are checked from the stored
-- canonical page JSON as well as from the proposal columns above.
CREATE TRIGGER IF NOT EXISTS wiki_owner_edit_binding_page_guard
BEFORE INSERT ON wiki_owner_edit_binding
BEGIN
  SELECT RAISE(ABORT, 'WIKI_OWNER_EDIT_PAGE_INVALID')
  WHERE NOT EXISTS (
    SELECT 1
    FROM wiki_publication_proposal p
    WHERE p.proposal_id = NEW.proposal_id
      AND p.proposal_revision = NEW.proposal_revision
      AND json_valid(p.page_json) = 1
      AND json_extract(p.page_json, '$.status') IS 'DRAFT'
      AND json_type(p.page_json, '$.page_ref') = 'object'
      AND (SELECT count(*) FROM json_each(json_extract(p.page_json, '$.page_ref'))) = 2
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(p.page_json, '$.page_ref')) field
        WHERE field.key NOT IN ('id', 'revision')
      )
      AND json_type(p.page_json, '$.page_ref.id') = 'text'
      AND json_type(p.page_json, '$.page_ref.revision') = 'integer'
      AND json_extract(p.page_json, '$.page_ref.id') IS NEW.base_page_id
      AND json_extract(p.page_json, '$.page_ref.revision') IS NEW.base_page_revision + 1
      AND json_type(p.page_json, '$.supersedes_ref') = 'object'
      AND (SELECT count(*) FROM json_each(json_extract(p.page_json, '$.supersedes_ref'))) = 2
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(p.page_json, '$.supersedes_ref')) field
        WHERE field.key NOT IN ('id', 'revision')
      )
      AND json_type(p.page_json, '$.supersedes_ref.id') = 'text'
      AND json_type(p.page_json, '$.supersedes_ref.revision') = 'integer'
      AND json_extract(p.page_json, '$.supersedes_ref.id') IS NEW.base_page_id
      AND json_extract(p.page_json, '$.supersedes_ref.revision') IS NEW.base_page_revision
  );
END;

-- Owner-edit metadata is a closed protocol.  The nested references are exact
-- VersionedRef objects, so no alternate base can be hidden in JSON.
CREATE TRIGGER IF NOT EXISTS wiki_owner_edit_binding_metadata_guard
BEFORE INSERT ON wiki_owner_edit_binding
BEGIN
  SELECT RAISE(ABORT, 'WIKI_OWNER_EDIT_METADATA_INVALID')
  WHERE NOT EXISTS (
    SELECT 1
    FROM wiki_publication_proposal p
    WHERE p.proposal_id = NEW.proposal_id
      AND p.proposal_revision = NEW.proposal_revision
      AND json_valid(p.page_json) = 1
      AND json_type(p.page_json, '$.publication_metadata') = 'object'
      AND (SELECT count(*) FROM json_each(json_extract(p.page_json, '$.publication_metadata'))) = 12
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(p.page_json, '$.publication_metadata')) field
        WHERE field.key NOT IN (
          'base_body_sha256', 'base_coverage_receipt_ref',
          'base_dependency_refs_sha256', 'base_evidence_map_ref',
          'base_evidence_map_sha256', 'base_page_ref', 'base_page_sha256',
          'base_proposal_ref', 'edit_note', 'edit_request_sha256',
          'expected_head_revision', 'protocol'
        )
      )
      AND json_extract(p.page_json, '$.publication_metadata.protocol') IS 'eliotr.wiki-owner-edit.v1'
      AND json_type(p.page_json, '$.publication_metadata.edit_request_sha256') = 'text'
      AND json_extract(p.page_json, '$.publication_metadata.edit_request_sha256') IS NEW.request_sha256
      AND json_type(p.page_json, '$.publication_metadata.base_body_sha256') = 'text'
      AND length(json_extract(p.page_json, '$.publication_metadata.base_body_sha256')) = 64
      AND json_extract(p.page_json, '$.publication_metadata.base_body_sha256') NOT GLOB '*[^0-9a-f]*'
      AND json_type(p.page_json, '$.publication_metadata.base_dependency_refs_sha256') = 'text'
      AND length(json_extract(p.page_json, '$.publication_metadata.base_dependency_refs_sha256')) = 64
      AND json_extract(p.page_json, '$.publication_metadata.base_dependency_refs_sha256') NOT GLOB '*[^0-9a-f]*'
      AND json_type(p.page_json, '$.publication_metadata.base_evidence_map_ref') = 'text'
      AND length(json_extract(p.page_json, '$.publication_metadata.base_evidence_map_ref')) BETWEEN 1 AND 512
      AND json_type(p.page_json, '$.publication_metadata.base_evidence_map_sha256') = 'text'
      AND length(json_extract(p.page_json, '$.publication_metadata.base_evidence_map_sha256')) = 64
      AND json_extract(p.page_json, '$.publication_metadata.base_evidence_map_sha256') NOT GLOB '*[^0-9a-f]*'
      AND json_type(p.page_json, '$.publication_metadata.edit_note') = 'text'
      AND length(json_extract(p.page_json, '$.publication_metadata.edit_note')) BETWEEN 0 AND 4096
      AND json_type(p.page_json, '$.publication_metadata.expected_head_revision') = 'integer'
      AND json_extract(p.page_json, '$.publication_metadata.expected_head_revision') IS NEW.base_page_revision
      AND json_type(p.page_json, '$.publication_metadata.base_page_sha256') = 'text'
      AND json_extract(p.page_json, '$.publication_metadata.base_page_sha256') IS NEW.base_page_sha256
      AND json_type(p.page_json, '$.publication_metadata.base_coverage_receipt_ref') = 'object'
      AND (SELECT count(*) FROM json_each(json_extract(
            p.page_json, '$.publication_metadata.base_coverage_receipt_ref'
          ))) = 2
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(p.page_json, '$.publication_metadata.base_coverage_receipt_ref')) field
        WHERE field.key NOT IN ('id', 'revision')
      )
      AND json_type(p.page_json, '$.publication_metadata.base_coverage_receipt_ref.id') = 'text'
      AND length(json_extract(p.page_json, '$.publication_metadata.base_coverage_receipt_ref.id')) BETWEEN 1 AND 512
      AND json_type(p.page_json, '$.publication_metadata.base_coverage_receipt_ref.revision') = 'integer'
      AND json_extract(p.page_json, '$.publication_metadata.base_coverage_receipt_ref.revision') > 0
      AND json_type(p.page_json, '$.publication_metadata.base_proposal_ref') = 'object'
      AND (SELECT count(*) FROM json_each(json_extract(
            p.page_json, '$.publication_metadata.base_proposal_ref'
          ))) = 2
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(p.page_json, '$.publication_metadata.base_proposal_ref')) field
        WHERE field.key NOT IN ('id', 'revision')
      )
      AND json_type(p.page_json, '$.publication_metadata.base_proposal_ref.id') = 'text'
      AND json_type(p.page_json, '$.publication_metadata.base_proposal_ref.revision') = 'integer'
      AND json_extract(p.page_json, '$.publication_metadata.base_proposal_ref.id') IS NEW.base_proposal_id
      AND json_extract(p.page_json, '$.publication_metadata.base_proposal_ref.revision') IS NEW.base_proposal_revision
      AND json_type(p.page_json, '$.publication_metadata.base_page_ref') = 'object'
      AND (SELECT count(*) FROM json_each(json_extract(
            p.page_json, '$.publication_metadata.base_page_ref'
          ))) = 2
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(p.page_json, '$.publication_metadata.base_page_ref')) field
        WHERE field.key NOT IN ('id', 'revision')
      )
      AND json_type(p.page_json, '$.publication_metadata.base_page_ref.id') = 'text'
      AND json_type(p.page_json, '$.publication_metadata.base_page_ref.revision') = 'integer'
      AND json_extract(p.page_json, '$.publication_metadata.base_page_ref.id') IS NEW.base_page_id
      AND json_extract(p.page_json, '$.publication_metadata.base_page_ref.revision') IS NEW.base_page_revision
  );
END;

-- An owner edit is a deliberately conservative DRAFT: every statement label
-- is unresolved and the page carries at least one non-empty limitation.
CREATE TRIGGER IF NOT EXISTS wiki_owner_edit_binding_draft_guard
BEFORE INSERT ON wiki_owner_edit_binding
BEGIN
  SELECT RAISE(ABORT, 'WIKI_OWNER_EDIT_DRAFT_INVALID')
  WHERE NOT EXISTS (
    SELECT 1
    FROM wiki_publication_proposal p
    WHERE p.proposal_id = NEW.proposal_id
      AND p.proposal_revision = NEW.proposal_revision
      AND json_valid(p.page_json) = 1
      AND json_type(p.page_json, '$.statement_labels') = 'object'
      AND EXISTS (
        SELECT 1
        FROM json_each(json_extract(p.page_json, '$.statement_labels'))
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(p.page_json, '$.statement_labels')) label
        WHERE label.type IS NOT 'text'
           OR label.value IS NOT 'UNRESOLVED'
      )
      AND json_type(p.page_json, '$.limitations') = 'array'
      AND json_array_length(json_extract(p.page_json, '$.limitations')) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(p.page_json, '$.limitations')) limitation
        WHERE limitation.type IS NOT 'text'
           OR length(trim(CAST(limitation.value AS TEXT))) = 0
      )
  );
END;

-- The base proposal must be owned by the same principal and must already be
-- published.  Its stored proposal page is the original DRAFT; the published
-- page hash is checked against wiki_publication_revision below.
CREATE TRIGGER IF NOT EXISTS wiki_owner_edit_binding_base_proposal_guard
BEFORE INSERT ON wiki_owner_edit_binding
BEGIN
  SELECT RAISE(ABORT, 'WIKI_OWNER_EDIT_BASE_PROPOSAL_STALE')
  WHERE NOT EXISTS (
    SELECT 1
    FROM wiki_publication_proposal p
    WHERE p.proposal_id = NEW.base_proposal_id
      AND p.proposal_revision = NEW.base_proposal_revision
      AND p.principal_ref = NEW.principal_ref
      AND p.page_id = NEW.base_page_id
      AND p.page_revision = NEW.base_page_revision
      AND p.state = 'PUBLISHED'
  );
END;

-- The immutable published revision must be the revision produced by that
-- proposal and must carry the exact published page hash and page reference.
CREATE TRIGGER IF NOT EXISTS wiki_owner_edit_binding_base_revision_guard
BEFORE INSERT ON wiki_owner_edit_binding
BEGIN
  SELECT RAISE(ABORT, 'WIKI_OWNER_EDIT_BASE_REVISION_STALE')
  WHERE NOT EXISTS (
    SELECT 1
    FROM wiki_publication_revision r
    JOIN wiki_publication_proposal p
      ON p.proposal_id = r.proposal_id
     AND p.proposal_revision = r.proposal_revision
    WHERE r.page_id = NEW.base_page_id
      AND r.revision = NEW.base_page_revision
      AND r.proposal_id = NEW.base_proposal_id
      AND r.proposal_revision = NEW.base_proposal_revision
      AND r.page_sha256 = NEW.base_page_sha256
      AND p.principal_ref = NEW.principal_ref
      AND p.state = 'PUBLISHED'
      AND json_valid(r.page_json) = 1
      AND json_extract(r.page_json, '$.status') IS 'PUBLISHED'
      AND json_extract(r.page_json, '$.page_ref.id') IS NEW.base_page_id
      AND json_extract(r.page_json, '$.page_ref.revision') IS NEW.base_page_revision
  );
END;

-- The publication head is the final compare-and-swap fence.  A binding for an
-- older page revision cannot be inserted after another publication advanced
-- the head.
CREATE TRIGGER IF NOT EXISTS wiki_owner_edit_binding_head_guard
BEFORE INSERT ON wiki_owner_edit_binding
BEGIN
  SELECT RAISE(ABORT, 'WIKI_OWNER_EDIT_HEAD_STALE')
  WHERE NOT EXISTS (
    SELECT 1
    FROM wiki_publication_head h
    JOIN wiki_publication_revision r
      ON r.page_id = h.page_id
     AND r.revision = h.revision
    WHERE h.page_id = NEW.base_page_id
      AND h.revision = NEW.base_page_revision
      AND h.manifest_ref = r.manifest_ref
  );
END;
