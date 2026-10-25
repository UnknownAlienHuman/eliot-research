-- K4 Agents in: substring search over claim cards for the find_claims and search tools (trigram handles Russian).
-- DistillWorkflow writes a claim_fts row for every new claim from K4 on; this backfills claims distilled before.

CREATE VIRTUAL TABLE claim_fts USING fts5(claim_id UNINDEXED, body, tokenize = 'trigram');

INSERT INTO claim_fts (claim_id, body)
SELECT id, statement || ' ' || quote || ' ' || coalesce(task, '') || ' ' || coalesce(metric, '') || ' ' || coalesce(dataset, '')
FROM claim;
