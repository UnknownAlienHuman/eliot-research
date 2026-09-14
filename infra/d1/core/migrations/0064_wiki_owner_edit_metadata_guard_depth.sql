PRAGMA foreign_keys = ON;

-- The original metadata guard in 0063 was logically correct but exceeded
-- Cloudflare D1's expression-depth limit.  Keep the same closed protocol
-- checks while evaluating them in bounded trigger predicates.
DROP TRIGGER IF EXISTS wiki_owner_edit_binding_metadata_guard;

CREATE TRIGGER IF NOT EXISTS wiki_owner_edit_binding_metadata_shape_guard
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
  );
END;

CREATE TRIGGER IF NOT EXISTS wiki_owner_edit_binding_metadata_identity_guard
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
      AND json_type(p.page_json, '$.publication_metadata.base_page_sha256') = 'text'
      AND length(json_extract(p.page_json, '$.publication_metadata.base_page_sha256')) = 64
      AND json_extract(p.page_json, '$.publication_metadata.base_page_sha256') NOT GLOB '*[^0-9a-f]*'
      AND json_extract(p.page_json, '$.publication_metadata.base_page_sha256') IS NEW.base_page_sha256
      AND json_type(p.page_json, '$.publication_metadata.edit_note') = 'text'
      AND length(json_extract(p.page_json, '$.publication_metadata.edit_note')) BETWEEN 0 AND 4096
      AND json_type(p.page_json, '$.publication_metadata.expected_head_revision') = 'integer'
      AND json_extract(p.page_json, '$.publication_metadata.expected_head_revision') IS NEW.base_page_revision
  );
END;

CREATE TRIGGER IF NOT EXISTS wiki_owner_edit_binding_metadata_coverage_guard
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
  );
END;

CREATE TRIGGER IF NOT EXISTS wiki_owner_edit_binding_metadata_proposal_guard
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
  );
END;

CREATE TRIGGER IF NOT EXISTS wiki_owner_edit_binding_metadata_page_guard
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
