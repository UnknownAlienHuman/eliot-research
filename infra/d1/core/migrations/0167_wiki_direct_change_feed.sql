-- Remove the Wiki publication pseudo-outbox. It never had a delivery worker;
-- its only effect was an insert trigger into research_change_feed.
-- Existing change_ref values remain stable so acknowledged publication
-- identities and same-identity readback continue to resolve after the table is gone.
--
-- Existing WIKI_PUBLISHED rows are first rebound to their owner directly and
-- detached from historical scope replay. The migration then removes outbox_ref
-- from the Wiki head and drops the outbox table. Forward-only: a failed guard
-- aborts this migration file, so its temporary trigger removal and visibility
-- update roll back before any destructive DROP is retained.

-- The immutable-feed trigger is temporarily removed so old Wiki rows can be
-- converted from scope-derived visibility to direct owner visibility.
DROP TRIGGER IF EXISTS research_change_feed_no_update;

UPDATE research_change_feed AS c
SET visibility_principal_ref = (
      SELECT p.principal_ref
      FROM wiki_publication_outbox o
      JOIN wiki_publication_revision r
        ON r.page_id = o.page_id
       AND r.revision = o.revision
       AND r.manifest_ref = o.manifest_ref
       AND r.page_sha256 = o.payload_sha256
      JOIN wiki_publication_proposal p
        ON p.proposal_id = r.proposal_id
       AND p.proposal_revision = r.proposal_revision
      WHERE c.change_ref = 'wiki:' || o.outbox_ref
        AND c.subject_ref = 'wiki-page:' || r.page_id
        AND c.subject_revision = r.revision
        AND c.payload_ref = r.manifest_ref
        AND c.payload_sha256 = r.page_sha256
      LIMIT 1
    ),
    visibility_snapshot_id = NULL,
    visibility_snapshot_revision = NULL
WHERE c.kind = 'WIKI_PUBLISHED';

DROP TABLE IF EXISTS wiki_publication_change_guard_0167;
CREATE TABLE wiki_publication_change_guard_0167 (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
INSERT INTO wiki_publication_change_guard_0167(ok)
SELECT CASE WHEN NOT EXISTS (
  SELECT 1
  FROM research_change_feed c
  LEFT JOIN wiki_publication_outbox o
    ON c.change_ref = 'wiki:' || o.outbox_ref
  LEFT JOIN wiki_publication_revision r
    ON r.page_id = o.page_id
   AND r.revision = o.revision
   AND r.manifest_ref = o.manifest_ref
   AND r.page_sha256 = o.payload_sha256
  LEFT JOIN wiki_publication_proposal p
    ON p.proposal_id = r.proposal_id
   AND p.proposal_revision = r.proposal_revision
  WHERE c.kind = 'WIKI_PUBLISHED'
    AND (
      o.outbox_ref IS NULL
      OR r.page_id IS NULL
      OR p.proposal_id IS NULL
      OR c.subject_ref IS NOT ('wiki-page:' || r.page_id)
      OR c.subject_revision IS NOT r.revision
      OR c.payload_ref IS NOT r.manifest_ref
      OR c.payload_sha256 IS NOT r.page_sha256
      OR c.visibility_principal_ref IS NOT p.principal_ref
      OR c.visibility_snapshot_id IS NOT NULL
      OR c.visibility_snapshot_revision IS NOT NULL
    )
) THEN 1 ELSE 0 END;
DROP TABLE wiki_publication_change_guard_0167;

CREATE TRIGGER research_change_feed_no_update
BEFORE UPDATE ON research_change_feed
BEGIN
  SELECT RAISE(ABORT, 'RESEARCH_CHANGE_IMMUTABLE');
END;

DROP TRIGGER IF EXISTS wiki_publication_outbox_change_feed;
DROP INDEX IF EXISTS idx_wiki_publication_outbox_pending;

ALTER TABLE wiki_publication_head DROP COLUMN outbox_ref;
DROP TABLE wiki_publication_outbox;
