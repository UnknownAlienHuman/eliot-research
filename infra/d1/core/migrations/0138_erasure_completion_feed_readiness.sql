-- ER-13 readiness marker for the immutable ER-45 erasure-completion callback.
-- The marker is absent unless the separately allocated 0135 trigger is installed.
INSERT INTO schema_state(key,value,updated_at)
SELECT
  'erasure_completion_feed_generation',
  'erasure-completion-feed-v1',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE EXISTS (
  SELECT 1
  FROM sqlite_master
  WHERE type='trigger'
    AND name='erasure_execution_completion_change_feed'
    AND tbl_name='erasure_execution'
);
