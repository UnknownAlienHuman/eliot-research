-- S37 admission hardening (F2): bind the admitted branch role into the durable
-- research model spend admission record.
-- Branch stages (8 = ANALYZE_BRANCHES, 9 = COUNTER_SEARCH) always carry the
-- admitted role; every other stage never does. The role is part of the
-- admission digest, so a row that loses or swaps its role fails the digest
-- readback at decode time.
-- No stage 8/9 rows can predate this column: migration 0046 constrains
-- stage_index to (12, 13, 14), so the strict check is safe on existing rows.
PRAGMA foreign_keys = ON;

ALTER TABLE research_model_spend_admission
  ADD COLUMN role TEXT CHECK (
    (stage_index IN (8, 9) AND role IS NOT NULL)
    OR (stage_index NOT IN (8, 9) AND role IS NULL)
  );
