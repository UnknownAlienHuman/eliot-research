-- ER-08/ER-13 FIX5: close Luna P1-A (caller-head field smuggling under the wrong
-- event kind) and P1-B (malformed timestamps evading julianday bounds).
-- Additive only: 0001-0016 files are untouched. All RAISE() calls live inside triggers.
--
-- P1-A root cause: 0016 validated authority, epoch, time, actor/verifier binding and
-- op shape, then wrote every NEW.nh_* column directly. The APPEND shape pinned
-- immutable identity but no event-kind-to-field mask, so a forged ordinary CHECKPOINT
-- could flip obligations to ACCEPTED with attacker verifier/metric refs. This file
-- adds exhaustive per-kind masks plus semantic transition rules (single-obligation
-- flip, named-verifier binding, exposed-confirmatory metric freeze, observed and
-- status preconditions, append-only registration growth) in the D1 layer to match
-- the service/store masks in packages/research/src/ledger-commands.ts.
--
-- P1-B root cause: 0016 time checks rely on julianday(), which yields NULL for
-- malformed text. NULL comparisons never fire WHEN triggers and never fail CHECK
-- constraints, so 'not-a-date' observed/expiry/head/event times were accepted and
-- persisted. This file requires strict canonical UTC millis-Z
-- (YYYY-MM-DDTHH:mm:ss.sssZ) via a simple GLOB shape (D1 rejects character-class
-- GLOB patterns as too complex), julianday parse, strftime round-trip (the real
-- gate: SQLite normalizes impossible calendar dates such as Feb 30, so only
-- exact round-trips pass), and field ranges BEFORE any julianday comparison.
-- Bounded skew/TTL rules are unchanged.
--
-- Firing order note (verified on SQLite/D1): BEFORE triggers fire newest-first.
-- Creation order below is therefore reverse priority: masks and semantic checks
-- are created first and canonical-time triggers last, so malformed times fail
-- first, then verifier binding (preserving the FIX4 VERIFIER_DENIED code for a
-- forged verifier on any shape), then SUPERSESSION_REQUIRED, then INPUT_INVALID
-- masks; every 0016 trigger runs after all of these. APPEND mask triggers carry
-- an EXISTS guard for the live head so a missing head still reports the 0016
-- LEDGER_CONFLICT code instead of a mask code.

PRAGMA foreign_keys = ON;

-- P1-A: CHECKPOINT may advance only checkpoint_head (+ revision/event_head time).
CREATE TRIGGER IF NOT EXISTS ledger_cmd_append_mask_checkpoint BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND NEW.ne_kind = 'CHECKPOINT'
AND EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
AND ((SELECT h.status FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id) IS NOT 'OPEN'
OR NEW.nh_status IS NOT 'OPEN'
OR NEW.nh_obligations_json IS NOT (SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_hypotheses_json IS NOT (SELECT h.hypotheses_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_lane_registrations_json IS NOT (SELECT h.lane_registrations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_portfolio_ref IS NOT (SELECT h.portfolio_ref FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_debt_refs_json IS NOT (SELECT h.debt_refs_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_execution IS NOT (SELECT h.observed_execution FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_fidelity IS NOT (SELECT h.observed_fidelity FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_assurance IS NOT (SELECT h.observed_assurance FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_supersession_reason IS NOT (SELECT h.supersession_reason FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id))
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: checkpoint mutated a protected family'); END;

-- P1-A: OBLIGATION_ACCEPTED may change only obligations_json (semantics below).
CREATE TRIGGER IF NOT EXISTS ledger_cmd_append_mask_accept BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND NEW.ne_kind = 'OBLIGATION_ACCEPTED'
AND EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
AND ((SELECT h.status FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id) IS NOT 'OPEN'
OR NEW.nh_status IS NOT 'OPEN'
OR NEW.nh_checkpoint_head IS NOT (SELECT h.checkpoint_head FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_hypotheses_json IS NOT (SELECT h.hypotheses_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_lane_registrations_json IS NOT (SELECT h.lane_registrations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_portfolio_ref IS NOT (SELECT h.portfolio_ref FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_debt_refs_json IS NOT (SELECT h.debt_refs_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_execution IS NOT (SELECT h.observed_execution FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_fidelity IS NOT (SELECT h.observed_fidelity FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_assurance IS NOT (SELECT h.observed_assurance FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_supersession_reason IS NOT (SELECT h.supersession_reason FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id))
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: acceptance mutated a protected family'); END;

-- P1-A: acceptance must flip exactly one REGISTERED obligation to ACCEPTED with
-- unchanged identity and the event verifier pinned to the named verifier.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_accept_single BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND NEW.ne_kind = 'OBLIGATION_ACCEPTED'
AND EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
AND (json_array_length(NEW.nh_obligations_json) <> json_array_length((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id))
OR (SELECT COUNT(*) FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value) <> 1
OR (SELECT json_extract(o.value, '$.status') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS NOT 'REGISTERED'
OR (SELECT json_extract(n.value, '$.status') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS NOT 'ACCEPTED'
OR (SELECT json_extract(o.value, '$.obligation_id') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS NOT (SELECT json_extract(n.value, '$.obligation_id') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1)
OR (SELECT json_extract(o.value, '$.verifier_ref') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS NOT (SELECT json_extract(n.value, '$.verifier_ref') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1)
OR (SELECT json_extract(o.value, '$.lane') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS NOT (SELECT json_extract(n.value, '$.lane') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1)
OR (SELECT json_extract(o.value, '$.exposed') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS NOT (SELECT json_extract(n.value, '$.exposed') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1)
OR (SELECT json_extract(n.value, '$.verifier_ref') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS NOT NEW.ne_verifier_ref)
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: obligation acceptance transition is not permitted'); END;

-- P1-A: DEVIATION may change only obligations_json plus observed_execution.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_append_mask_deviation BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND NEW.ne_kind = 'DEVIATION'
AND EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
AND ((SELECT h.status FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id) IS NOT 'OPEN'
OR NEW.nh_status IS NOT 'OPEN'
OR NEW.nh_checkpoint_head IS NOT (SELECT h.checkpoint_head FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_hypotheses_json IS NOT (SELECT h.hypotheses_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_lane_registrations_json IS NOT (SELECT h.lane_registrations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_portfolio_ref IS NOT (SELECT h.portfolio_ref FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_debt_refs_json IS NOT (SELECT h.debt_refs_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_fidelity IS NOT (SELECT h.observed_fidelity FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_assurance IS NOT (SELECT h.observed_assurance FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_supersession_reason IS NOT (SELECT h.supersession_reason FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id))
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: deviation mutated a protected family'); END;

-- P1-A: deviation must flip exactly one live obligation to DEVIATED with an
-- observed note, leaving obligation identity intact.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_deviation_single BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND NEW.ne_kind = 'DEVIATION'
AND EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
AND (json_array_length(NEW.nh_obligations_json) <> json_array_length((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id))
OR (SELECT COUNT(*) FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value) <> 1
OR (SELECT json_extract(o.value, '$.status') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) NOT IN ('REGISTERED', 'ACCEPTED')
OR (SELECT json_extract(n.value, '$.status') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS NOT 'DEVIATED'
OR (SELECT json_extract(o.value, '$.obligation_id') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS NOT (SELECT json_extract(n.value, '$.obligation_id') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1)
OR (SELECT json_extract(o.value, '$.verifier_ref') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS NOT (SELECT json_extract(n.value, '$.verifier_ref') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1)
OR (SELECT json_extract(o.value, '$.lane') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS NOT (SELECT json_extract(n.value, '$.lane') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1)
OR (SELECT json_extract(o.value, '$.exposed') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS NOT (SELECT json_extract(n.value, '$.exposed') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1)
OR (SELECT json_extract(o.value, '$.metric_ref') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS NOT (SELECT json_extract(n.value, '$.metric_ref') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1)
OR NEW.nh_observed_execution IS (SELECT h.observed_execution FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id))
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: obligation deviation transition is not permitted'); END;

-- P1-A: OBSERVED may change only observed_execution/fidelity/assurance.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_append_mask_observed BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND NEW.ne_kind = 'OBSERVED'
AND EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
AND ((SELECT h.status FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id) IS NOT 'OPEN'
OR NEW.nh_status IS NOT 'OPEN'
OR NEW.nh_obligations_json IS NOT (SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_hypotheses_json IS NOT (SELECT h.hypotheses_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_lane_registrations_json IS NOT (SELECT h.lane_registrations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_checkpoint_head IS NOT (SELECT h.checkpoint_head FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_portfolio_ref IS NOT (SELECT h.portfolio_ref FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_debt_refs_json IS NOT (SELECT h.debt_refs_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_supersession_reason IS NOT (SELECT h.supersession_reason FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR (NEW.nh_observed_execution IS (SELECT h.observed_execution FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
AND NEW.nh_observed_fidelity IS (SELECT h.observed_fidelity FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
AND NEW.nh_observed_assurance IS (SELECT h.observed_assurance FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)))
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: observation mutated a protected family'); END;

-- P1-A: CLOSED may flip only status OPEN to CLOSED.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_append_mask_closed BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND NEW.ne_kind = 'CLOSED'
AND EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
AND ((SELECT h.status FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id) IS NOT 'OPEN'
OR NEW.nh_status IS NOT 'CLOSED'
OR NEW.nh_obligations_json IS NOT (SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_hypotheses_json IS NOT (SELECT h.hypotheses_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_lane_registrations_json IS NOT (SELECT h.lane_registrations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_checkpoint_head IS NOT (SELECT h.checkpoint_head FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_portfolio_ref IS NOT (SELECT h.portfolio_ref FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_debt_refs_json IS NOT (SELECT h.debt_refs_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_execution IS NOT (SELECT h.observed_execution FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_fidelity IS NOT (SELECT h.observed_fidelity FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_assurance IS NOT (SELECT h.observed_assurance FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_supersession_reason IS NOT (SELECT h.supersession_reason FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id))
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: close mutated a protected family'); END;

-- P1-A: REOPENED may flip only status CLOSED to OPEN.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_append_mask_reopened BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND NEW.ne_kind = 'REOPENED'
AND EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
AND ((SELECT h.status FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id) IS NOT 'CLOSED'
OR NEW.nh_status IS NOT 'OPEN'
OR NEW.nh_obligations_json IS NOT (SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_hypotheses_json IS NOT (SELECT h.hypotheses_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_lane_registrations_json IS NOT (SELECT h.lane_registrations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_checkpoint_head IS NOT (SELECT h.checkpoint_head FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_portfolio_ref IS NOT (SELECT h.portfolio_ref FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_debt_refs_json IS NOT (SELECT h.debt_refs_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_execution IS NOT (SELECT h.observed_execution FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_fidelity IS NOT (SELECT h.observed_fidelity FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_assurance IS NOT (SELECT h.observed_assurance FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_supersession_reason IS NOT (SELECT h.supersession_reason FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id))
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: reopen mutated a protected family'); END;

-- P1-A: LANE_REGISTERED may append exactly one lane registration.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_append_mask_lane BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND NEW.ne_kind = 'LANE_REGISTERED'
AND EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
AND ((SELECT h.status FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id) IS NOT 'OPEN'
OR NEW.nh_status IS NOT 'OPEN'
OR NEW.nh_obligations_json IS NOT (SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_hypotheses_json IS NOT (SELECT h.hypotheses_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_checkpoint_head IS NOT (SELECT h.checkpoint_head FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_portfolio_ref IS NOT (SELECT h.portfolio_ref FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_debt_refs_json IS NOT (SELECT h.debt_refs_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_execution IS NOT (SELECT h.observed_execution FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_fidelity IS NOT (SELECT h.observed_fidelity FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_assurance IS NOT (SELECT h.observed_assurance FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_supersession_reason IS NOT (SELECT h.supersession_reason FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR json_array_length(NEW.nh_lane_registrations_json) <> json_array_length((SELECT h.lane_registrations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) + 1
OR (SELECT COUNT(*) FROM json_each((SELECT h.lane_registrations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_lane_registrations_json) n ON n.key = o.key WHERE n.value IS o.value) <> json_array_length((SELECT h.lane_registrations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)))
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: lane registration mutated a protected family'); END;

-- P1-A: OBLIGATION_REGISTERED may append exactly one REGISTERED obligation with
-- a fresh id.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_append_mask_oblreg BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND NEW.ne_kind = 'OBLIGATION_REGISTERED'
AND EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
AND ((SELECT h.status FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id) IS NOT 'OPEN'
OR NEW.nh_status IS NOT 'OPEN'
OR NEW.nh_checkpoint_head IS NOT (SELECT h.checkpoint_head FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_hypotheses_json IS NOT (SELECT h.hypotheses_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_lane_registrations_json IS NOT (SELECT h.lane_registrations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_portfolio_ref IS NOT (SELECT h.portfolio_ref FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_debt_refs_json IS NOT (SELECT h.debt_refs_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_execution IS NOT (SELECT h.observed_execution FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_fidelity IS NOT (SELECT h.observed_fidelity FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_assurance IS NOT (SELECT h.observed_assurance FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_supersession_reason IS NOT (SELECT h.supersession_reason FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR json_array_length(NEW.nh_obligations_json) <> json_array_length((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) + 1
OR (SELECT COUNT(*) FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS o.value) <> json_array_length((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id))
OR json_extract(NEW.nh_obligations_json, '$[' || (json_array_length(NEW.nh_obligations_json) - 1) || '].status') IS NOT 'REGISTERED'
OR EXISTS (SELECT 1 FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o WHERE json_extract(o.value, '$.obligation_id') IS json_extract(NEW.nh_obligations_json, '$[' || (json_array_length(NEW.nh_obligations_json) - 1) || '].obligation_id')))
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: obligation registration mutated a protected family'); END;

-- P1-A: HYPOTHESIS_RECORDED may append exactly one hypothesis.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_append_mask_hyprec BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND NEW.ne_kind = 'HYPOTHESIS_RECORDED'
AND EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
AND ((SELECT h.status FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id) IS NOT 'OPEN'
OR NEW.nh_status IS NOT 'OPEN'
OR NEW.nh_obligations_json IS NOT (SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_checkpoint_head IS NOT (SELECT h.checkpoint_head FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_lane_registrations_json IS NOT (SELECT h.lane_registrations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_portfolio_ref IS NOT (SELECT h.portfolio_ref FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_debt_refs_json IS NOT (SELECT h.debt_refs_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_execution IS NOT (SELECT h.observed_execution FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_fidelity IS NOT (SELECT h.observed_fidelity FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_observed_assurance IS NOT (SELECT h.observed_assurance FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_supersession_reason IS NOT (SELECT h.supersession_reason FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR json_array_length(NEW.nh_hypotheses_json) <> json_array_length((SELECT h.hypotheses_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) + 1
OR (SELECT COUNT(*) FROM json_each((SELECT h.hypotheses_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_hypotheses_json) n ON n.key = o.key WHERE n.value IS o.value) <> json_array_length((SELECT h.hypotheses_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)))
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: hypothesis record mutated a protected family'); END;

-- P1-A: accepting a deviated obligation, or moving an exposed confirmatory
-- metric, requires explicit supersession rather than an append.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_accept_supersede BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND NEW.ne_kind = 'OBLIGATION_ACCEPTED'
AND EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
AND ((SELECT json_extract(o.value, '$.status') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS 'DEVIATED'
OR ((SELECT json_extract(o.value, '$.exposed') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS 1
AND (SELECT json_extract(o.value, '$.lane') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS 'confirmatory'
AND (SELECT json_extract(n.value, '$.metric_ref') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1) IS NOT (SELECT json_extract(o.value, '$.metric_ref') FROM json_each((SELECT h.obligations_json FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)) o JOIN json_each(NEW.nh_obligations_json) n ON n.key = o.key WHERE n.value IS NOT o.value LIMIT 1)))
BEGIN SELECT RAISE(ABORT, 'LEDGER_SUPERSESSION_REQUIRED: deviated obligation or exposed confirmatory metric requires explicit supersession'); END;

-- P1-A: only the named verifier accepts, on OBLIGATION_ACCEPTED only. Created
-- after the masks so it fires first and preserves the FIX4 VERIFIER_DENIED code
-- for a forged verifier on any next-head shape.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_accept_verifier BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND NEW.ne_kind = 'OBLIGATION_ACCEPTED'
AND (NEW.ne_verifier_ref IS NULL OR NEW.ne_actor_ref IS NOT NEW.ne_verifier_ref)
BEGIN SELECT RAISE(ABORT, 'LEDGER_VERIFIER_DENIED: only the named verifier accepts'); END;

-- P1-A: CREATED and SUPERSEDED events require their explicit commands.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_append_kind_allow BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND NEW.ne_kind IN ('CREATED', 'SUPERSEDED')
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: event kind requires an explicit create or supersede command'); END;

-- P1-A: APPEND head JSON families must parse so mask comparisons are exact.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_append_json_valid BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND'
AND (json_valid(NEW.nh_obligations_json) IS NOT 1
OR json_valid(NEW.nh_hypotheses_json) IS NOT 1
OR json_valid(NEW.nh_lane_registrations_json) IS NOT 1
OR json_valid(NEW.nh_debt_refs_json) IS NOT 1)
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: append head JSON is malformed'); END;

-- P1-B: canonical UTC millis-Z on command transport times. Fires before the
-- 0016 freshness/TTL triggers: malformed text must fail here, never slip
-- through a NULL julianday comparison.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_time_canonical_observed BEFORE INSERT ON investigation_ledger_command
WHEN NEW.observed_at NOT GLOB '????-??-??T??:??:??.???Z'
OR julianday(NEW.observed_at) IS NULL
OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.observed_at) IS NOT NEW.observed_at
OR CAST(substr(NEW.observed_at, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
OR CAST(substr(NEW.observed_at, 9, 2) AS INTEGER) NOT BETWEEN 1 AND 31
OR CAST(substr(NEW.observed_at, 12, 2) AS INTEGER) NOT BETWEEN 0 AND 23
OR CAST(substr(NEW.observed_at, 15, 2) AS INTEGER) NOT BETWEEN 0 AND 59
OR CAST(substr(NEW.observed_at, 18, 2) AS INTEGER) NOT BETWEEN 0 AND 59
OR NEW.expires_at NOT GLOB '????-??-??T??:??:??.???Z'
OR julianday(NEW.expires_at) IS NULL
OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.expires_at) IS NOT NEW.expires_at
OR CAST(substr(NEW.expires_at, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
OR CAST(substr(NEW.expires_at, 9, 2) AS INTEGER) NOT BETWEEN 1 AND 31
OR CAST(substr(NEW.expires_at, 12, 2) AS INTEGER) NOT BETWEEN 0 AND 23
OR CAST(substr(NEW.expires_at, 15, 2) AS INTEGER) NOT BETWEEN 0 AND 59
OR CAST(substr(NEW.expires_at, 18, 2) AS INTEGER) NOT BETWEEN 0 AND 59
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: command transport time is not canonical UTC millis-Z'); END;

-- P1-B: canonical UTC millis-Z on every new head/event timestamp.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_time_canonical_new BEFORE INSERT ON investigation_ledger_command
WHEN NEW.nh_created_at NOT GLOB '????-??-??T??:??:??.???Z'
OR julianday(NEW.nh_created_at) IS NULL
OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.nh_created_at) IS NOT NEW.nh_created_at
OR CAST(substr(NEW.nh_created_at, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
OR CAST(substr(NEW.nh_created_at, 9, 2) AS INTEGER) NOT BETWEEN 1 AND 31
OR CAST(substr(NEW.nh_created_at, 12, 2) AS INTEGER) NOT BETWEEN 0 AND 23
OR CAST(substr(NEW.nh_created_at, 15, 2) AS INTEGER) NOT BETWEEN 0 AND 59
OR CAST(substr(NEW.nh_created_at, 18, 2) AS INTEGER) NOT BETWEEN 0 AND 59
OR NEW.nh_updated_at NOT GLOB '????-??-??T??:??:??.???Z'
OR julianday(NEW.nh_updated_at) IS NULL
OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.nh_updated_at) IS NOT NEW.nh_updated_at
OR CAST(substr(NEW.nh_updated_at, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
OR CAST(substr(NEW.nh_updated_at, 9, 2) AS INTEGER) NOT BETWEEN 1 AND 31
OR CAST(substr(NEW.nh_updated_at, 12, 2) AS INTEGER) NOT BETWEEN 0 AND 23
OR CAST(substr(NEW.nh_updated_at, 15, 2) AS INTEGER) NOT BETWEEN 0 AND 59
OR CAST(substr(NEW.nh_updated_at, 18, 2) AS INTEGER) NOT BETWEEN 0 AND 59
OR NEW.ne_created_at NOT GLOB '????-??-??T??:??:??.???Z'
OR julianday(NEW.ne_created_at) IS NULL
OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.ne_created_at) IS NOT NEW.ne_created_at
OR CAST(substr(NEW.ne_created_at, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
OR CAST(substr(NEW.ne_created_at, 9, 2) AS INTEGER) NOT BETWEEN 1 AND 31
OR CAST(substr(NEW.ne_created_at, 12, 2) AS INTEGER) NOT BETWEEN 0 AND 23
OR CAST(substr(NEW.ne_created_at, 15, 2) AS INTEGER) NOT BETWEEN 0 AND 59
OR CAST(substr(NEW.ne_created_at, 18, 2) AS INTEGER) NOT BETWEEN 0 AND 59
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: command head or event time is not canonical UTC millis-Z'); END;

-- P1-B: canonical UTC millis-Z on carried old-mark times (SUPERSEDE only;
-- CREATE/APPEND old bytes stay NULL).
CREATE TRIGGER IF NOT EXISTS ledger_cmd_time_canonical_old BEFORE INSERT ON investigation_ledger_command
WHEN (NEW.oh_created_at IS NOT NULL AND (NEW.oh_created_at NOT GLOB '????-??-??T??:??:??.???Z'
OR julianday(NEW.oh_created_at) IS NULL
OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.oh_created_at) IS NOT NEW.oh_created_at
OR CAST(substr(NEW.oh_created_at, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
OR CAST(substr(NEW.oh_created_at, 9, 2) AS INTEGER) NOT BETWEEN 1 AND 31
OR CAST(substr(NEW.oh_created_at, 12, 2) AS INTEGER) NOT BETWEEN 0 AND 23
OR CAST(substr(NEW.oh_created_at, 15, 2) AS INTEGER) NOT BETWEEN 0 AND 59
OR CAST(substr(NEW.oh_created_at, 18, 2) AS INTEGER) NOT BETWEEN 0 AND 59))
OR (NEW.oh_updated_at IS NOT NULL AND (NEW.oh_updated_at NOT GLOB '????-??-??T??:??:??.???Z'
OR julianday(NEW.oh_updated_at) IS NULL
OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.oh_updated_at) IS NOT NEW.oh_updated_at
OR CAST(substr(NEW.oh_updated_at, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
OR CAST(substr(NEW.oh_updated_at, 9, 2) AS INTEGER) NOT BETWEEN 1 AND 31
OR CAST(substr(NEW.oh_updated_at, 12, 2) AS INTEGER) NOT BETWEEN 0 AND 23
OR CAST(substr(NEW.oh_updated_at, 15, 2) AS INTEGER) NOT BETWEEN 0 AND 59
OR CAST(substr(NEW.oh_updated_at, 18, 2) AS INTEGER) NOT BETWEEN 0 AND 59))
OR (NEW.oe_created_at IS NOT NULL AND (NEW.oe_created_at NOT GLOB '????-??-??T??:??:??.???Z'
OR julianday(NEW.oe_created_at) IS NULL
OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.oe_created_at) IS NOT NEW.oe_created_at
OR CAST(substr(NEW.oe_created_at, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
OR CAST(substr(NEW.oe_created_at, 9, 2) AS INTEGER) NOT BETWEEN 1 AND 31
OR CAST(substr(NEW.oe_created_at, 12, 2) AS INTEGER) NOT BETWEEN 0 AND 23
OR CAST(substr(NEW.oe_created_at, 15, 2) AS INTEGER) NOT BETWEEN 0 AND 59
OR CAST(substr(NEW.oe_created_at, 18, 2) AS INTEGER) NOT BETWEEN 0 AND 59))
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: supersede mark time is not canonical UTC millis-Z'); END;

INSERT INTO schema_state(key, value, updated_at) VALUES('investigation_ledger_fix5_generation', 'investigation-ledger-fix5-v1', '2026-09-06T00:00:00Z');
