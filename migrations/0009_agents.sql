-- K4 shared claim search and immutable proposal base; existing page revisions own proposals.
ALTER TABLE page_revision ADD COLUMN base_revision_id TEXT REFERENCES page_revision(id);
CREATE VIRTUAL TABLE claim_fts USING fts5(claim_id UNINDEXED, body, tokenize = 'trigram');
INSERT INTO claim_fts(claim_id,body)
SELECT c.id,c.statement || ' ' || c.quote || ' ' || coalesce(c.task,'') || ' ' || coalesce(c.metric,'') || ' ' || coalesce(c.dataset,'')
FROM claim c JOIN source_revision r ON r.id=c.source_revision_id WHERE c.ordinal<r.claim_count;
CREATE TRIGGER claim_fts_insert AFTER INSERT ON claim
WHEN NEW.ordinal<(SELECT claim_count FROM source_revision WHERE id=NEW.source_revision_id)
BEGIN
  INSERT INTO claim_fts(claim_id,body) VALUES(NEW.id,NEW.statement || ' ' || NEW.quote || ' ' || coalesce(NEW.task,'') || ' ' || coalesce(NEW.metric,'') || ' ' || coalesce(NEW.dataset,''));
END;
-- Checked recovery publishes its guarded head before upserts, so both insert and update maintenance are used.
CREATE TRIGGER claim_fts_update AFTER UPDATE ON claim
BEGIN
  DELETE FROM claim_fts WHERE claim_id=OLD.id;
  INSERT INTO claim_fts(claim_id,body)
  SELECT NEW.id,NEW.statement || ' ' || NEW.quote || ' ' || coalesce(NEW.task,'') || ' ' || coalesce(NEW.metric,'') || ' ' || coalesce(NEW.dataset,'')
  WHERE NEW.ordinal<(SELECT claim_count FROM source_revision WHERE id=NEW.source_revision_id);
END;
CREATE TRIGGER claim_fts_head AFTER UPDATE OF claim_count ON source_revision
BEGIN
  DELETE FROM claim_fts WHERE claim_id IN (SELECT id FROM claim WHERE source_revision_id=NEW.id);
  INSERT INTO claim_fts(claim_id,body)
  SELECT id,statement || ' ' || quote || ' ' || coalesce(task,'') || ' ' || coalesce(metric,'') || ' ' || coalesce(dataset,'')
  FROM claim WHERE source_revision_id=NEW.id AND ordinal<NEW.claim_count;
END;
