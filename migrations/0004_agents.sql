-- K4 Agents in: automatically maintained trigram FTS over accepted claims.
-- Trigram is chosen for substring/identifier matching and reasonable Russian
-- fallback; K5 separately measures AI Search lexical/semantic quality.

PRAGMA foreign_keys = ON;

CREATE VIRTUAL TABLE claim_fts USING fts5(
  claim_id UNINDEXED,
  source_revision_id UNINDEXED,
  body,
  tokenize = 'trigram'
);

CREATE TRIGGER claim_fts_insert AFTER INSERT ON claim BEGIN
  INSERT INTO claim_fts (claim_id, source_revision_id, body)
  VALUES (
    NEW.id,
    NEW.source_revision_id,
    NEW.statement || ' ' || NEW.quote || ' ' ||
      coalesce(NEW.subject, '') || ' ' || coalesce(NEW.task, '') || ' ' ||
      coalesce(NEW.metric, '') || ' ' || coalesce(NEW.dataset, '') || ' ' ||
      coalesce(NEW.split, '') || ' ' || coalesce(NEW.protocol, '')
  );
END;

CREATE TRIGGER claim_fts_delete AFTER DELETE ON claim BEGIN
  DELETE FROM claim_fts WHERE claim_id = OLD.id;
END;

CREATE TRIGGER claim_fts_update AFTER UPDATE ON claim BEGIN
  DELETE FROM claim_fts WHERE claim_id = OLD.id;
  INSERT INTO claim_fts (claim_id, source_revision_id, body)
  VALUES (
    NEW.id,
    NEW.source_revision_id,
    NEW.statement || ' ' || NEW.quote || ' ' ||
      coalesce(NEW.subject, '') || ' ' || coalesce(NEW.task, '') || ' ' ||
      coalesce(NEW.metric, '') || ' ' || coalesce(NEW.dataset, '') || ' ' ||
      coalesce(NEW.split, '') || ' ' || coalesce(NEW.protocol, '')
  );
END;

INSERT INTO claim_fts (claim_id, source_revision_id, body)
SELECT
  id,
  source_revision_id,
  statement || ' ' || quote || ' ' ||
    coalesce(subject, '') || ' ' || coalesce(task, '') || ' ' ||
    coalesce(metric, '') || ' ' || coalesce(dataset, '') || ' ' ||
    coalesce(split, '') || ' ' || coalesce(protocol, '')
FROM claim;
