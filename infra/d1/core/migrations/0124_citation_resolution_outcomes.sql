-- R00 #209: retain typed V2 citation outcomes on the existing immutable receipt row.
-- Historical V1 receipt bytes and digests remain untouched and keep outcomes_json NULL.
ALTER TABLE citation_resolution_receipt
  ADD COLUMN outcomes_json TEXT
  CHECK (outcomes_json IS NULL OR json_valid(outcomes_json));

-- The compatibility codec is inferred from receipt_json. V1 has no schema_version;
-- V2 stores the canonical outcomes projection both in receipt_json and this column.
CREATE TRIGGER citation_resolution_guard_outcomes_alignment
BEFORE INSERT ON citation_resolution_guard
BEGIN
  SELECT RAISE(ABORT, 'CITATION_OUTCOMES_MISMATCH')
  WHERE NOT EXISTS (
    SELECT 1
    FROM citation_resolution_receipt receipt
    WHERE receipt.receipt_id = NEW.receipt_id
      AND receipt.revision = NEW.receipt_revision
      AND (
        (
          json_type(receipt.receipt_json, '$.schema_version') IS NULL
          AND receipt.outcomes_json IS NULL
        )
        OR
        (
          json_type(receipt.receipt_json, '$.schema_version') = 'integer'
          AND json_extract(receipt.receipt_json, '$.schema_version') = 2
          AND receipt.outcomes_json IS NOT NULL
          AND json_type(receipt.outcomes_json) = 'array'
          AND json(receipt.outcomes_json) =
            json(json_extract(receipt.receipt_json, '$.outcomes'))
          AND json_array_length(receipt.outcomes_json) = receipt.requested_count
          AND json_type(receipt.requested_handle_refs_json) = 'array'
          AND json_type(receipt.resolved_json) = 'array'
          AND json_type(receipt.rejected_json) = 'array'
          AND receipt.requested_count = json_array_length(receipt.requested_handle_refs_json)
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(receipt.outcomes_json) outcome
            WHERE COALESCE(json_type(outcome.value), '') <> 'object'
              OR (SELECT COUNT(*) FROM json_each(outcome.value)) <>
                CASE WHEN json_extract(outcome.value, '$.outcome') = 'RESOLVED' THEN 4 ELSE 2 END
              OR COALESCE(json_extract(outcome.value, '$.outcome'), '') NOT IN (
                'RESOLVED','INVALID_REFERENCE','AUTHORITY_REVOKED','SOURCE_QUARANTINED',
                'CONTENT_MISMATCH','VERIFY_UNAVAILABLE','STORAGE_UNAVAILABLE','EFFECT_UNKNOWN'
              )
              OR COALESCE(json_type(outcome.value, '$.handle_ref'), '') <> 'object'
              OR (SELECT COUNT(*) FROM json_each(json_extract(outcome.value, '$.handle_ref'))) <> 2
              OR COALESCE(json_type(outcome.value, '$.handle_ref.id'), '') <> 'text'
              OR length(json_extract(outcome.value, '$.handle_ref.id')) NOT BETWEEN 1 AND 256
              OR COALESCE(json_type(outcome.value, '$.handle_ref.revision'), '') <> 'integer'
              OR json_extract(outcome.value, '$.handle_ref.revision') < 1
              OR (
                json_extract(outcome.value, '$.outcome') = 'RESOLVED'
                AND (
                  COALESCE(json_type(outcome.value, '$.excerpt_sha256'), '') <> 'text'
                  OR length(json_extract(outcome.value, '$.excerpt_sha256')) <> 64
                  OR json_extract(outcome.value, '$.excerpt_sha256') GLOB '*[^a-f0-9]*'
                  OR COALESCE(json_type(outcome.value, '$.verification_receipt_ref'), '') <> 'text'
                  OR length(json_extract(outcome.value, '$.verification_receipt_ref')) NOT BETWEEN 1 AND 256
                )
              )
              OR (
                json_extract(outcome.value, '$.outcome') <> 'RESOLVED'
                AND (
                  json_type(outcome.value, '$.excerpt_sha256') IS NOT NULL
                  OR json_type(outcome.value, '$.verification_receipt_ref') IS NOT NULL
                )
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(receipt.requested_handle_refs_json) requested
            WHERE COALESCE(json_type(requested.value), '') <> 'object'
              OR (SELECT COUNT(*) FROM json_each(requested.value)) <> 2
              OR COALESCE(json_type(requested.value, '$.id'), '') <> 'text'
              OR length(json_extract(requested.value, '$.id')) NOT BETWEEN 1 AND 256
              OR COALESCE(json_type(requested.value, '$.revision'), '') <> 'integer'
              OR json_extract(requested.value, '$.revision') < 1
              OR (
                SELECT COUNT(*)
                FROM json_each(receipt.outcomes_json) outcome
                WHERE json_extract(outcome.value, '$.handle_ref.id') =
                    json_extract(requested.value, '$.id')
                  AND json_extract(outcome.value, '$.handle_ref.revision') =
                    json_extract(requested.value, '$.revision')
              ) <> 1
          )
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(receipt.requested_handle_refs_json) requested
            GROUP BY json_extract(requested.value, '$.id'),
              json_extract(requested.value, '$.revision')
            HAVING COUNT(*) <> 1
          )
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(receipt.resolved_json) projection
            WHERE COALESCE(json_type(projection.value), '') <> 'object'
              OR (SELECT COUNT(*) FROM json_each(projection.value)) <> 3
              OR COALESCE(json_type(projection.value, '$.handle_ref'), '') <> 'object'
              OR (SELECT COUNT(*) FROM json_each(json_extract(projection.value, '$.handle_ref'))) <> 2
              OR COALESCE(json_type(projection.value, '$.handle_ref.id'), '') <> 'text'
              OR length(json_extract(projection.value, '$.handle_ref.id')) NOT BETWEEN 1 AND 256
              OR COALESCE(json_type(projection.value, '$.handle_ref.revision'), '') <> 'integer'
              OR json_extract(projection.value, '$.handle_ref.revision') < 1
              OR COALESCE(json_type(projection.value, '$.excerpt_sha256'), '') <> 'text'
              OR length(json_extract(projection.value, '$.excerpt_sha256')) <> 64
              OR json_extract(projection.value, '$.excerpt_sha256') GLOB '*[^a-f0-9]*'
              OR COALESCE(json_type(projection.value, '$.verification_receipt_ref'), '') <> 'text'
              OR length(json_extract(projection.value, '$.verification_receipt_ref')) NOT BETWEEN 1 AND 256
              OR (
                SELECT COUNT(*)
                FROM json_each(receipt.outcomes_json) outcome
                WHERE json_extract(outcome.value, '$.outcome') = 'RESOLVED'
                  AND json_extract(outcome.value, '$.handle_ref.id') =
                    json_extract(projection.value, '$.handle_ref.id')
                  AND json_extract(outcome.value, '$.handle_ref.revision') =
                    json_extract(projection.value, '$.handle_ref.revision')
                  AND json_extract(outcome.value, '$.excerpt_sha256') =
                    json_extract(projection.value, '$.excerpt_sha256')
                  AND json_extract(outcome.value, '$.verification_receipt_ref') =
                    json_extract(projection.value, '$.verification_receipt_ref')
              ) <> 1
          )
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(receipt.outcomes_json) outcome
            WHERE json_extract(outcome.value, '$.outcome') = 'RESOLVED'
              AND (
                SELECT COUNT(*)
                FROM json_each(receipt.resolved_json) projection
                WHERE json_extract(projection.value, '$.handle_ref.id') =
                    json_extract(outcome.value, '$.handle_ref.id')
                  AND json_extract(projection.value, '$.handle_ref.revision') =
                    json_extract(outcome.value, '$.handle_ref.revision')
                  AND json_extract(projection.value, '$.excerpt_sha256') =
                    json_extract(outcome.value, '$.excerpt_sha256')
                  AND json_extract(projection.value, '$.verification_receipt_ref') =
                    json_extract(outcome.value, '$.verification_receipt_ref')
              ) <> 1
          )
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(receipt.rejected_json) projection
            WHERE COALESCE(json_type(projection.value), '') <> 'object'
              OR (SELECT COUNT(*) FROM json_each(projection.value)) <> 2
              OR COALESCE(json_type(projection.value, '$.handle_ref'), '') <> 'object'
              OR (SELECT COUNT(*) FROM json_each(json_extract(projection.value, '$.handle_ref'))) <> 2
              OR COALESCE(json_type(projection.value, '$.handle_ref.id'), '') <> 'text'
              OR length(json_extract(projection.value, '$.handle_ref.id')) NOT BETWEEN 1 AND 256
              OR COALESCE(json_type(projection.value, '$.handle_ref.revision'), '') <> 'integer'
              OR json_extract(projection.value, '$.handle_ref.revision') < 1
              OR COALESCE(json_type(projection.value, '$.reason_code'), '') <> 'text'
              OR json_extract(projection.value, '$.reason_code') NOT IN (
                'INVALID_REFERENCE','AUTHORITY_REVOKED','CONTENT_MISMATCH'
              )
              OR (
                SELECT COUNT(*)
                FROM json_each(receipt.outcomes_json) outcome
                WHERE json_extract(outcome.value, '$.outcome') =
                    json_extract(projection.value, '$.reason_code')
                  AND json_extract(outcome.value, '$.handle_ref.id') =
                    json_extract(projection.value, '$.handle_ref.id')
                  AND json_extract(outcome.value, '$.handle_ref.revision') =
                    json_extract(projection.value, '$.handle_ref.revision')
              ) <> 1
          )
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(receipt.outcomes_json) outcome
            WHERE json_extract(outcome.value, '$.outcome') IN (
                'INVALID_REFERENCE','AUTHORITY_REVOKED','CONTENT_MISMATCH'
              )
              AND (
                SELECT COUNT(*)
                FROM json_each(receipt.rejected_json) projection
                WHERE json_extract(projection.value, '$.handle_ref.id') =
                    json_extract(outcome.value, '$.handle_ref.id')
                  AND json_extract(projection.value, '$.handle_ref.revision') =
                    json_extract(outcome.value, '$.handle_ref.revision')
                  AND json_extract(projection.value, '$.reason_code') =
                    json_extract(outcome.value, '$.outcome')
              ) <> 1
          )
          AND receipt.resolved_count = json_array_length(receipt.resolved_json)
          AND receipt.resolved_count = (
            SELECT COUNT(*)
            FROM json_each(receipt.outcomes_json) outcome
            WHERE json_extract(outcome.value, '$.outcome') = 'RESOLVED'
          )
          AND receipt.all_material_citations_resolved = CASE
            WHEN EXISTS (
              SELECT 1
              FROM json_each(receipt.outcomes_json) outcome
              WHERE json_extract(outcome.value, '$.outcome') <> 'RESOLVED'
            ) THEN 0 ELSE 1 END
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(receipt.rejected_json) rejection
            WHERE COALESCE(json_extract(rejection.value, '$.reason_code'), '') NOT IN (
              'INVALID_REFERENCE','AUTHORITY_REVOKED','CONTENT_MISMATCH'
            )
          )
        )
      )
  );
END;
