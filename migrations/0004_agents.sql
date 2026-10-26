-- K4 Agents in: substring search over claim cards for the find_claims and search tools (trigram handles Russian).
-- K4 writers/queries use only the current ordinal prefix; retained old trailing rows are not searchable.

CREATE VIRTUAL TABLE claim_fts USING fts5(claim_id UNINDEXED, body, tokenize = 'trigram');

INSERT INTO claim_fts (claim_id, body)
SELECT c.id, c.statement || ' ' || c.quote || ' ' || coalesce(c.task, '') || ' ' || coalesce(c.metric, '') || ' ' || coalesce(c.dataset, '')
FROM claim c JOIN source_revision r ON r.id=c.source_revision_id
WHERE c.ordinal<r.claim_count;
