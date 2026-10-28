-- Source understanding starts only through an explicit revision request.
ALTER TABLE settings DROP COLUMN auto_distill;
UPDATE source_revision
SET distill_state='paused',distill_error='Source understanding now requires an explicit request.'
WHERE distill_state='queued' AND distill_calls=0;
