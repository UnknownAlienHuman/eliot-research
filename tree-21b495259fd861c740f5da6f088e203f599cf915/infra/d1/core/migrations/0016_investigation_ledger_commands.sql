-- ER-08/ER-13 FIX4: atomic single-statement ledger commands replace the resumable guard path.
-- Additive only: 0001-0015 files are untouched. All RAISE() calls live inside triggers.
--
-- Root cause fixed: 0015 authorized head/event effects by the existence of any matching
-- persistent PENDING guard row, which does not prove same-transaction locality. A guard
-- committed in txn1 could authorize a zero-row CAS plus a forged seq-2 event in later
-- transactions (orphan event, forged actor, guard still PENDING), and guard observed/expiry
-- times were never bound to D1 current time.
--
-- New model: every create/append/supersede is exactly ONE INSERT into
-- investigation_ledger_command. BEFORE INSERT triggers validate the complete fence, epoch,
-- D1 current-time bounds, actor/verifier binding and op shape against live D1 rows; the
-- AFTER INSERT trigger program then performs every head/event effect inside the same
-- statement. Any failure aborts the whole statement (command row included), so a separate
-- transaction can never resume a command, and zero-row/stale CAS can never orphan an event.
-- Command rows are immutable receipts (no PENDING/CONSUMED lifecycle): reusing an event id
-- with identical bytes reconciles to the committed effect, any divergent byte conflicts.
--
-- Firing order note (verified on SQLite/D1): BEFORE triggers fire newest-first. Creation
-- order below is therefore reverse priority: epoch is created first so it fires last and a
-- specific authority dimension keeps its typed code when both it and the epoch go stale.
-- Direct head/event writes now require a full-byte-equal committed command row; heads can
-- never be deleted and events stay append-only.

PRAGMA foreign_keys = ON;

-- One row carries the entire operation: fence, versions, epoch, D1-time bounds, the full
-- old-mark head/event bytes (SUPERSEDE only) and the full new head/event bytes.
CREATE TABLE IF NOT EXISTS investigation_ledger_command (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) BETWEEN 1 AND 256),
  op_kind TEXT NOT NULL CHECK(op_kind IN ('CREATE','APPEND','SUPERSEDE')),
  expected_old_revision INTEGER NOT NULL CHECK(expected_old_revision >= 0),
  expected_new_revision INTEGER NOT NULL CHECK(expected_new_revision BETWEEN 1 AND 1000000),
  expected_old_event_head INTEGER NOT NULL CHECK(expected_old_event_head >= 0),
  expected_new_event_head INTEGER NOT NULL CHECK(expected_new_event_head BETWEEN 1 AND 1000000),
  expected_epoch INTEGER NOT NULL CHECK(expected_epoch > 0),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  scope_snapshot_id TEXT NOT NULL CHECK(length(scope_snapshot_id) BETWEEN 1 AND 256),
  scope_snapshot_revision INTEGER NOT NULL CHECK(scope_snapshot_revision BETWEEN 1 AND 1000000),
  policy_generation TEXT NOT NULL CHECK(length(policy_generation) BETWEEN 1 AND 256),
  policy_authority_ref TEXT NOT NULL CHECK(length(policy_authority_ref) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  global_purge_revision INTEGER NOT NULL CHECK(global_purge_revision >= 0),
  scope_purge_revision INTEGER CHECK(scope_purge_revision IS NULL OR scope_purge_revision >= 0),
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  oh_investigation_id TEXT, oh_revision INTEGER, oh_protocol_version TEXT, oh_goal TEXT,
  oh_scope_snapshot_id TEXT, oh_scope_snapshot_revision INTEGER, oh_evidence_grade TEXT,
  oh_lane TEXT, oh_lane_registrations_json TEXT, oh_obligations_json TEXT, oh_hypotheses_json TEXT,
  oh_portfolio_ref TEXT, oh_debt_refs_json TEXT, oh_checkpoint_head INTEGER, oh_principal_ref TEXT,
  oh_input_digest TEXT, oh_policy_generation TEXT, oh_policy_authority_ref TEXT,
  oh_deployment_generation TEXT, oh_idempotency_key TEXT, oh_model_profile_ref TEXT,
  oh_observed_execution TEXT, oh_observed_fidelity TEXT, oh_observed_assurance TEXT,
  oh_status TEXT, oh_supersedes_id TEXT, oh_supersession_reason TEXT, oh_event_head INTEGER,
  oh_created_at TEXT, oh_updated_at TEXT,
  oe_investigation_id TEXT, oe_sequence INTEGER, oe_event_id TEXT, oe_kind TEXT,
  oe_payload_handle_ref TEXT, oe_payload_digest TEXT, oe_actor_ref TEXT, oe_verifier_ref TEXT,
  oe_created_at TEXT,
  nh_investigation_id TEXT NOT NULL, nh_revision INTEGER NOT NULL, nh_protocol_version TEXT NOT NULL,
  nh_goal TEXT NOT NULL, nh_scope_snapshot_id TEXT NOT NULL, nh_scope_snapshot_revision INTEGER NOT NULL,
  nh_evidence_grade TEXT NOT NULL, nh_lane TEXT NOT NULL, nh_lane_registrations_json TEXT NOT NULL,
  nh_obligations_json TEXT NOT NULL, nh_hypotheses_json TEXT NOT NULL, nh_portfolio_ref TEXT NOT NULL,
  nh_debt_refs_json TEXT NOT NULL, nh_checkpoint_head INTEGER NOT NULL, nh_principal_ref TEXT NOT NULL,
  nh_input_digest TEXT NOT NULL, nh_policy_generation TEXT NOT NULL, nh_policy_authority_ref TEXT NOT NULL,
  nh_deployment_generation TEXT NOT NULL, nh_idempotency_key TEXT NOT NULL, nh_model_profile_ref TEXT NOT NULL,
  nh_observed_execution TEXT, nh_observed_fidelity TEXT, nh_observed_assurance TEXT,
  nh_status TEXT NOT NULL, nh_supersedes_id TEXT, nh_supersession_reason TEXT,
  nh_event_head INTEGER NOT NULL, nh_created_at TEXT NOT NULL, nh_updated_at TEXT NOT NULL,
  ne_investigation_id TEXT NOT NULL, ne_sequence INTEGER NOT NULL, ne_event_id TEXT NOT NULL,
  ne_kind TEXT NOT NULL, ne_payload_handle_ref TEXT NOT NULL, ne_payload_digest TEXT NOT NULL,
  ne_actor_ref TEXT NOT NULL, ne_verifier_ref TEXT, ne_created_at TEXT NOT NULL,
  CHECK(julianday(expires_at) > julianday(observed_at)),
  CHECK(julianday(expires_at) <= julianday(observed_at, '+10 minutes'))
) STRICT;
CREATE INDEX IF NOT EXISTS investigation_ledger_command_event_idx
  ON investigation_ledger_command(ne_event_id);

-- The resumable guard path is retired: 0015 triggers below are replaced by command binding.
DROP TRIGGER IF EXISTS ledger_head_insert_guard;
DROP TRIGGER IF EXISTS ledger_head_update_guard;
DROP TRIGGER IF EXISTS ledger_event_insert_guard;

-- Created first so it fires last: a specific stale dimension keeps its typed code.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_epoch_current BEFORE INSERT ON investigation_ledger_command
WHEN NEW.expected_epoch IS NOT (SELECT generation FROM investigation_ledger_epoch WHERE singleton = 1)
BEGIN SELECT RAISE(ABORT, 'LEDGER_STALE_HEAD: ledger authority epoch changed'); END;
-- Observed time is bound to D1 current time: 60s future skew, 300s past staleness, hard expiry.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_time_fresh BEFORE INSERT ON investigation_ledger_command
WHEN julianday(NEW.observed_at) > julianday('now', '+60 seconds')
OR julianday(NEW.observed_at) < julianday('now', '-300 seconds')
OR julianday('now') > julianday(NEW.expires_at)
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: command observed time is outside D1 current-time bounds'); END;
CREATE TRIGGER IF NOT EXISTS ledger_cmd_ttl_bound BEFORE INSERT ON investigation_ledger_command
WHEN julianday(NEW.expires_at) <= julianday(NEW.observed_at)
OR julianday(NEW.expires_at) > julianday(NEW.observed_at, '+10 minutes')
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: command expiry exceeds the bounded TTL'); END;
CREATE TRIGGER IF NOT EXISTS ledger_cmd_scope_current BEFORE INSERT ON investigation_ledger_command
WHEN NOT EXISTS (SELECT 1 FROM scope_snapshot s WHERE s.snapshot_id = NEW.scope_snapshot_id AND s.revision = NEW.scope_snapshot_revision AND s.invalidated_at IS NULL AND julianday(s.expires_at) > julianday('now'))
BEGIN SELECT RAISE(ABORT, 'LEDGER_SCOPE_FOREIGN: scope snapshot missing invalidated expired or foreign'); END;
CREATE TRIGGER IF NOT EXISTS ledger_cmd_grant_active BEFORE INSERT ON investigation_ledger_command
WHEN NOT EXISTS (SELECT 1 FROM scope_access_grant g WHERE g.snapshot_id = NEW.scope_snapshot_id AND g.snapshot_revision = NEW.scope_snapshot_revision AND g.principal_ref = NEW.principal_ref AND g.state = 'ACTIVE' AND julianday(g.expires_at) > julianday('now') AND g.policy_authority_ref = NEW.policy_authority_ref)
BEGIN SELECT RAISE(ABORT, 'LEDGER_PRINCIPAL_DENIED: grant missing revoked expired or policy ref mismatch'); END;
CREATE TRIGGER IF NOT EXISTS ledger_cmd_policy_current BEFORE INSERT ON investigation_ledger_command
WHEN NOT EXISTS (SELECT 1 FROM investigation_current_policy p WHERE p.policy_generation = NEW.policy_generation AND p.policy_authority_ref = NEW.policy_authority_ref AND p.state = 'ACTIVE')
OR (SELECT s.policy_authority_ref FROM scope_snapshot s WHERE s.snapshot_id = NEW.scope_snapshot_id AND s.revision = NEW.scope_snapshot_revision) IS NOT NEW.policy_authority_ref
BEGIN SELECT RAISE(ABORT, 'LEDGER_POLICY_STALE: policy generation or authority ref mismatch'); END;
CREATE TRIGGER IF NOT EXISTS ledger_cmd_deployment_current BEFORE INSERT ON investigation_ledger_command
WHEN NOT EXISTS (SELECT 1 FROM investigation_current_deployment d WHERE d.deployment_generation = NEW.deployment_generation AND d.state = 'ACTIVE')
BEGIN SELECT RAISE(ABORT, 'LEDGER_DEPLOYMENT_STALE: deployment generation mismatch'); END;
CREATE TRIGGER IF NOT EXISTS ledger_cmd_purge_current BEFORE INSERT ON investigation_ledger_command
WHEN NEW.global_purge_revision IS NOT COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger), 0)
OR NEW.scope_purge_revision IS NOT (SELECT s.purge_ledger_revision FROM scope_snapshot s WHERE s.snapshot_id = NEW.scope_snapshot_id AND s.revision = NEW.scope_snapshot_revision)
OR (SELECT s.purge_ledger_revision FROM scope_snapshot s WHERE s.snapshot_id = NEW.scope_snapshot_id AND s.revision = NEW.scope_snapshot_revision) < COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger), 0)
BEGIN SELECT RAISE(ABORT, 'LEDGER_PURGE_STALE: global or scope purge revision mismatch'); END;
-- Every mutation is owner-bound: the new head stays with the fenced principal, CREATE and
-- SUPERSEDE marks are owner-written, and APPENDs are owner-written except a named-verifier
-- acceptance (actor equals the event verifier; the verifier trigger pins that binding).
CREATE TRIGGER IF NOT EXISTS ledger_cmd_actor_owner BEFORE INSERT ON investigation_ledger_command
WHEN NEW.nh_principal_ref IS NOT NEW.principal_ref
OR (NEW.op_kind IN ('CREATE', 'SUPERSEDE') AND NEW.ne_actor_ref IS NOT NEW.principal_ref)
OR (NEW.op_kind = 'SUPERSEDE' AND (NEW.oh_principal_ref IS NOT NEW.principal_ref OR NEW.oe_actor_ref IS NOT NEW.principal_ref))
OR (NEW.op_kind = 'APPEND' AND NEW.ne_actor_ref IS NOT NEW.principal_ref AND NOT (NEW.ne_kind = 'OBLIGATION_ACCEPTED' AND NEW.ne_verifier_ref IS NOT NULL AND NEW.ne_actor_ref IS NEW.ne_verifier_ref))
BEGIN SELECT RAISE(ABORT, 'LEDGER_PRINCIPAL_DENIED: foreign actor cannot mutate ledger'); END;
-- Only the named verifier accepts, and only on OBLIGATION_ACCEPTED; every other kind is verifier-free.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_verifier_new BEFORE INSERT ON investigation_ledger_command
WHEN (NEW.ne_kind = 'OBLIGATION_ACCEPTED' AND (NEW.ne_verifier_ref IS NULL OR NEW.ne_actor_ref IS NOT NEW.ne_verifier_ref))
OR (NEW.ne_kind <> 'OBLIGATION_ACCEPTED' AND NEW.ne_verifier_ref IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'LEDGER_VERIFIER_DENIED: only the named verifier accepts'); END;
CREATE TRIGGER IF NOT EXISTS ledger_cmd_verifier_old BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'SUPERSEDE' AND ((NEW.oe_kind = 'OBLIGATION_ACCEPTED' AND (NEW.oe_verifier_ref IS NULL OR NEW.oe_actor_ref IS NOT NEW.oe_verifier_ref)) OR (NEW.oe_kind <> 'OBLIGATION_ACCEPTED' AND NEW.oe_verifier_ref IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'LEDGER_VERIFIER_DENIED: only the named verifier accepts'); END;

-- CREATE shape: genesis revision/head, CREATED seq 1, one shared observed instant, no old bytes.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_create_shape BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'CREATE' AND (NEW.expected_old_revision <> 0 OR NEW.expected_new_revision <> 1
OR NEW.expected_old_event_head <> 0 OR NEW.expected_new_event_head <> 1
OR NEW.oh_investigation_id IS NOT NULL OR NEW.oe_event_id IS NOT NULL
OR NEW.nh_revision <> 1 OR NEW.nh_event_head <> 1 OR NEW.nh_supersedes_id IS NOT NULL
OR NEW.ne_sequence <> 1 OR NEW.ne_kind IS NOT 'CREATED'
OR NEW.ne_investigation_id IS NOT NEW.nh_investigation_id
OR NEW.ne_created_at IS NOT NEW.nh_created_at OR NEW.ne_created_at IS NOT NEW.nh_updated_at
OR NEW.nh_created_at IS NOT NEW.nh_updated_at OR NEW.observed_at IS NOT NEW.nh_updated_at)
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: malformed create command bytes'); END;

-- APPEND: old head must exist (else CONFLICT), CAS must match (else STALE_HEAD), then shape.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_append_old_present BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND NOT EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
BEGIN SELECT RAISE(ABORT, 'LEDGER_CONFLICT: unknown investigation ledger'); END;
CREATE TRIGGER IF NOT EXISTS ledger_cmd_append_cas BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id AND (h.revision IS NOT NEW.expected_old_revision OR h.event_head IS NOT NEW.expected_old_event_head))
BEGIN SELECT RAISE(ABORT, 'LEDGER_STALE_HEAD: stale expected revision for ledger head'); END;
CREATE TRIGGER IF NOT EXISTS ledger_cmd_append_shape BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'APPEND' AND (NEW.expected_new_revision <> NEW.expected_old_revision + 1
OR NEW.expected_new_event_head <> NEW.expected_old_event_head + 1
OR NEW.oh_investigation_id IS NOT NULL OR NEW.oe_event_id IS NOT NULL
OR NEW.nh_revision IS NOT NEW.expected_new_revision OR NEW.nh_event_head IS NOT NEW.expected_new_event_head
OR NEW.ne_sequence IS NOT NEW.expected_new_event_head OR NEW.ne_investigation_id IS NOT NEW.nh_investigation_id
OR NEW.ne_created_at IS NOT NEW.nh_updated_at OR NEW.observed_at IS NOT NEW.nh_updated_at
OR (SELECT h.status FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id) NOT IN ('OPEN', 'CLOSED')
OR NOT (NEW.nh_status IS (SELECT h.status FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id) OR ((SELECT h.status FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id) = 'OPEN' AND NEW.nh_status = 'CLOSED') OR ((SELECT h.status FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id) = 'CLOSED' AND NEW.nh_status = 'OPEN'))
OR NEW.nh_principal_ref IS NOT (SELECT h.principal_ref FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_scope_snapshot_id IS NOT (SELECT h.scope_snapshot_id FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_scope_snapshot_revision IS NOT (SELECT h.scope_snapshot_revision FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_policy_generation IS NOT (SELECT h.policy_generation FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_policy_authority_ref IS NOT (SELECT h.policy_authority_ref FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_deployment_generation IS NOT (SELECT h.deployment_generation FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_input_digest IS NOT (SELECT h.input_digest FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_idempotency_key IS NOT (SELECT h.idempotency_key FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_protocol_version IS NOT (SELECT h.protocol_version FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_evidence_grade IS NOT (SELECT h.evidence_grade FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_goal IS NOT (SELECT h.goal FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_lane IS NOT (SELECT h.lane FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_model_profile_ref IS NOT (SELECT h.model_profile_ref FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_created_at IS NOT (SELECT h.created_at FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id)
OR NEW.nh_supersedes_id IS NOT (SELECT h.supersedes_id FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id))
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: malformed append command bytes'); END;

-- SUPERSEDE: old head must exist OPEN (CONFLICT/STALE_HEAD), cross-linked replacement, one instant.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_supersede_old_present BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'SUPERSEDE' AND NOT EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id)
BEGIN SELECT RAISE(ABORT, 'LEDGER_CONFLICT: unknown investigation ledger'); END;
CREATE TRIGGER IF NOT EXISTS ledger_cmd_supersede_cas BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'SUPERSEDE' AND EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id AND (h.revision IS NOT NEW.expected_old_revision OR h.event_head IS NOT NEW.expected_old_event_head))
BEGIN SELECT RAISE(ABORT, 'LEDGER_STALE_HEAD: stale expected revision for superseded head'); END;
CREATE TRIGGER IF NOT EXISTS ledger_cmd_supersede_shape BEFORE INSERT ON investigation_ledger_command
WHEN NEW.op_kind = 'SUPERSEDE' AND (NEW.expected_new_revision <> NEW.expected_old_revision + 1
OR NEW.expected_new_event_head <> NEW.expected_old_event_head + 1
OR NEW.oh_investigation_id IS NULL OR NEW.oe_event_id IS NULL OR NEW.nh_investigation_id IS NULL OR NEW.ne_event_id IS NULL
OR NEW.oh_revision IS NOT NEW.expected_new_revision OR NEW.oh_event_head IS NOT NEW.expected_new_event_head
OR NEW.oh_status IS NOT 'SUPERSEDED' OR NEW.nh_status IS NOT 'OPEN'
OR NEW.oh_investigation_id IS NEW.nh_investigation_id OR NEW.nh_supersedes_id IS NOT NEW.oh_investigation_id
OR NEW.nh_revision <> 1 OR NEW.nh_event_head <> 1 OR NEW.ne_sequence <> 1 OR NEW.ne_kind IS NOT 'CREATED'
OR NEW.ne_investigation_id IS NOT NEW.nh_investigation_id
OR NEW.oe_sequence IS NOT NEW.expected_new_event_head OR NEW.oe_kind IS NOT 'SUPERSEDED'
OR NEW.oe_investigation_id IS NOT NEW.oh_investigation_id
OR NEW.oe_created_at IS NOT NEW.ne_created_at OR NEW.nh_created_at IS NOT NEW.ne_created_at
OR NEW.nh_updated_at IS NOT NEW.ne_created_at OR NEW.oh_updated_at IS NOT NEW.ne_created_at
OR NEW.observed_at IS NOT NEW.ne_created_at
OR (SELECT h.status FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id) IS NOT 'OPEN'
OR NEW.oh_principal_ref IS NOT (SELECT h.principal_ref FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id)
OR NEW.oh_scope_snapshot_id IS NOT (SELECT h.scope_snapshot_id FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id)
OR NEW.oh_scope_snapshot_revision IS NOT (SELECT h.scope_snapshot_revision FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id)
OR NEW.oh_policy_generation IS NOT (SELECT h.policy_generation FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id)
OR NEW.oh_policy_authority_ref IS NOT (SELECT h.policy_authority_ref FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id)
OR NEW.oh_deployment_generation IS NOT (SELECT h.deployment_generation FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id)
OR NEW.oh_input_digest IS NOT (SELECT h.input_digest FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id)
OR NEW.oh_idempotency_key IS NOT (SELECT h.idempotency_key FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id)
OR NEW.oh_protocol_version IS NOT (SELECT h.protocol_version FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id)
OR NEW.oh_evidence_grade IS NOT (SELECT h.evidence_grade FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id)
OR NEW.oh_goal IS NOT (SELECT h.goal FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id)
OR NEW.oh_lane IS NOT (SELECT h.lane FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id)
OR NEW.oh_model_profile_ref IS NOT (SELECT h.model_profile_ref FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id)
OR NEW.oh_created_at IS NOT (SELECT h.created_at FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id))
BEGIN SELECT RAISE(ABORT, 'LEDGER_INPUT_INVALID: malformed supersede command bytes'); END;

-- The atomic effect program: every head/event mutation of the operation happens here, in the
-- command INSERT statement. Post-write linkage checks turn a zero-row CAS into a hard abort
-- that rolls back the command row, heads and events together.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_apply AFTER INSERT ON investigation_ledger_command
BEGIN
  INSERT INTO investigation_ledger_head (investigation_id, revision, protocol_version, goal, scope_snapshot_id, scope_snapshot_revision, evidence_grade, lane, lane_registrations_json, obligations_json, hypotheses_json, portfolio_ref, debt_refs_json, checkpoint_head, principal_ref, input_digest, policy_generation, policy_authority_ref, deployment_generation, idempotency_key, model_profile_ref, observed_execution, observed_fidelity, observed_assurance, status, supersedes_id, supersession_reason, event_head, created_at, updated_at)
  SELECT NEW.nh_investigation_id, NEW.nh_revision, NEW.nh_protocol_version, NEW.nh_goal, NEW.nh_scope_snapshot_id, NEW.nh_scope_snapshot_revision, NEW.nh_evidence_grade, NEW.nh_lane, NEW.nh_lane_registrations_json, NEW.nh_obligations_json, NEW.nh_hypotheses_json, NEW.nh_portfolio_ref, NEW.nh_debt_refs_json, NEW.nh_checkpoint_head, NEW.nh_principal_ref, NEW.nh_input_digest, NEW.nh_policy_generation, NEW.nh_policy_authority_ref, NEW.nh_deployment_generation, NEW.nh_idempotency_key, NEW.nh_model_profile_ref, NEW.nh_observed_execution, NEW.nh_observed_fidelity, NEW.nh_observed_assurance, NEW.nh_status, NEW.nh_supersedes_id, NEW.nh_supersession_reason, NEW.nh_event_head, NEW.nh_created_at, NEW.nh_updated_at
  WHERE NEW.op_kind IN ('CREATE', 'SUPERSEDE');
  INSERT INTO investigation_ledger_event (investigation_id, sequence, event_id, kind, payload_handle_ref, payload_digest, actor_ref, verifier_ref, created_at)
  SELECT NEW.ne_investigation_id, NEW.ne_sequence, NEW.ne_event_id, NEW.ne_kind, NEW.ne_payload_handle_ref, NEW.ne_payload_digest, NEW.ne_actor_ref, NEW.ne_verifier_ref, NEW.ne_created_at
  WHERE NEW.op_kind IN ('CREATE', 'SUPERSEDE');
  UPDATE investigation_ledger_head SET revision = NEW.nh_revision, protocol_version = NEW.nh_protocol_version, goal = NEW.nh_goal, scope_snapshot_id = NEW.nh_scope_snapshot_id, scope_snapshot_revision = NEW.nh_scope_snapshot_revision, evidence_grade = NEW.nh_evidence_grade, lane = NEW.nh_lane, lane_registrations_json = NEW.nh_lane_registrations_json, obligations_json = NEW.nh_obligations_json, hypotheses_json = NEW.nh_hypotheses_json, portfolio_ref = NEW.nh_portfolio_ref, debt_refs_json = NEW.nh_debt_refs_json, checkpoint_head = NEW.nh_checkpoint_head, principal_ref = NEW.nh_principal_ref, input_digest = NEW.nh_input_digest, policy_generation = NEW.nh_policy_generation, policy_authority_ref = NEW.nh_policy_authority_ref, deployment_generation = NEW.nh_deployment_generation, idempotency_key = NEW.nh_idempotency_key, model_profile_ref = NEW.nh_model_profile_ref, observed_execution = NEW.nh_observed_execution, observed_fidelity = NEW.nh_observed_fidelity, observed_assurance = NEW.nh_observed_assurance, status = NEW.nh_status, supersedes_id = NEW.nh_supersedes_id, supersession_reason = NEW.nh_supersession_reason, event_head = NEW.nh_event_head, updated_at = NEW.nh_updated_at
  WHERE NEW.op_kind = 'APPEND' AND investigation_id = NEW.nh_investigation_id AND revision = NEW.expected_old_revision;
  INSERT INTO investigation_ledger_event (investigation_id, sequence, event_id, kind, payload_handle_ref, payload_digest, actor_ref, verifier_ref, created_at)
  SELECT NEW.ne_investigation_id, NEW.ne_sequence, NEW.ne_event_id, NEW.ne_kind, NEW.ne_payload_handle_ref, NEW.ne_payload_digest, NEW.ne_actor_ref, NEW.ne_verifier_ref, NEW.ne_created_at
  WHERE NEW.op_kind = 'APPEND';
  UPDATE investigation_ledger_head SET revision = NEW.oh_revision, protocol_version = NEW.oh_protocol_version, goal = NEW.oh_goal, scope_snapshot_id = NEW.oh_scope_snapshot_id, scope_snapshot_revision = NEW.oh_scope_snapshot_revision, evidence_grade = NEW.oh_evidence_grade, lane = NEW.oh_lane, lane_registrations_json = NEW.oh_lane_registrations_json, obligations_json = NEW.oh_obligations_json, hypotheses_json = NEW.oh_hypotheses_json, portfolio_ref = NEW.oh_portfolio_ref, debt_refs_json = NEW.oh_debt_refs_json, checkpoint_head = NEW.oh_checkpoint_head, principal_ref = NEW.oh_principal_ref, input_digest = NEW.oh_input_digest, policy_generation = NEW.oh_policy_generation, policy_authority_ref = NEW.oh_policy_authority_ref, deployment_generation = NEW.oh_deployment_generation, idempotency_key = NEW.oh_idempotency_key, model_profile_ref = NEW.oh_model_profile_ref, observed_execution = NEW.oh_observed_execution, observed_fidelity = NEW.oh_observed_fidelity, observed_assurance = NEW.oh_observed_assurance, status = NEW.oh_status, supersedes_id = NEW.oh_supersedes_id, supersession_reason = NEW.oh_supersession_reason, event_head = NEW.oh_event_head, updated_at = NEW.oh_updated_at
  WHERE NEW.op_kind = 'SUPERSEDE' AND investigation_id = NEW.oh_investigation_id AND revision = NEW.expected_old_revision;
  INSERT INTO investigation_ledger_event (investigation_id, sequence, event_id, kind, payload_handle_ref, payload_digest, actor_ref, verifier_ref, created_at)
  SELECT NEW.oe_investigation_id, NEW.oe_sequence, NEW.oe_event_id, NEW.oe_kind, NEW.oe_payload_handle_ref, NEW.oe_payload_digest, NEW.oe_actor_ref, NEW.oe_verifier_ref, NEW.oe_created_at
  WHERE NEW.op_kind = 'SUPERSEDE';
  SELECT RAISE(ABORT, 'LEDGER_CONFLICT: create command did not persist head and event') WHERE NEW.op_kind = 'CREATE' AND (NOT EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id AND h.revision = 1 AND h.event_head = 1) OR NOT EXISTS (SELECT 1 FROM investigation_ledger_event e WHERE e.event_id = NEW.ne_event_id AND e.investigation_id = NEW.nh_investigation_id AND e.sequence = 1));
  SELECT RAISE(ABORT, 'LEDGER_STALE_HEAD: append command did not advance a live head') WHERE NEW.op_kind = 'APPEND' AND NOT EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id AND h.revision = NEW.expected_new_revision AND h.event_head = NEW.expected_new_event_head);
  SELECT RAISE(ABORT, 'LEDGER_SETTLEMENT_UNCERTAIN: append command event is missing') WHERE NEW.op_kind = 'APPEND' AND NOT EXISTS (SELECT 1 FROM investigation_ledger_event e WHERE e.event_id = NEW.ne_event_id AND e.investigation_id = NEW.nh_investigation_id AND e.sequence = NEW.expected_new_event_head);
  SELECT RAISE(ABORT, 'LEDGER_STALE_HEAD: supersede command did not mark a live head') WHERE NEW.op_kind = 'SUPERSEDE' AND NOT EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.oh_investigation_id AND h.revision = NEW.expected_new_revision AND h.event_head = NEW.expected_new_event_head AND h.status = 'SUPERSEDED');
  SELECT RAISE(ABORT, 'LEDGER_SETTLEMENT_UNCERTAIN: supersede command effect is incomplete') WHERE NEW.op_kind = 'SUPERSEDE' AND (NOT EXISTS (SELECT 1 FROM investigation_ledger_event e WHERE e.event_id = NEW.oe_event_id) OR NOT EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.nh_investigation_id AND h.revision = 1 AND h.event_head = 1) OR NOT EXISTS (SELECT 1 FROM investigation_ledger_event e WHERE e.event_id = NEW.ne_event_id));
END;

-- Fail-closed head/event binding: a write is allowed only when its full bytes equal a
-- committed command's bytes. Replaying committed bytes is a harmless no-op (UNIQUE backstop);
-- any divergent byte has no matching command and aborts. Heads are never deleted.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_head_insert BEFORE INSERT ON investigation_ledger_head
WHEN NOT EXISTS (SELECT 1 FROM investigation_ledger_command c WHERE c.op_kind IN ('CREATE', 'SUPERSEDE')
AND c.nh_investigation_id IS NEW.investigation_id AND c.nh_revision IS NEW.revision AND c.nh_protocol_version IS NEW.protocol_version
AND c.nh_goal IS NEW.goal AND c.nh_scope_snapshot_id IS NEW.scope_snapshot_id AND c.nh_scope_snapshot_revision IS NEW.scope_snapshot_revision
AND c.nh_evidence_grade IS NEW.evidence_grade AND c.nh_lane IS NEW.lane AND c.nh_lane_registrations_json IS NEW.lane_registrations_json
AND c.nh_obligations_json IS NEW.obligations_json AND c.nh_hypotheses_json IS NEW.hypotheses_json AND c.nh_portfolio_ref IS NEW.portfolio_ref
AND c.nh_debt_refs_json IS NEW.debt_refs_json AND c.nh_checkpoint_head IS NEW.checkpoint_head AND c.nh_principal_ref IS NEW.principal_ref
AND c.nh_input_digest IS NEW.input_digest AND c.nh_policy_generation IS NEW.policy_generation AND c.nh_policy_authority_ref IS NEW.policy_authority_ref
AND c.nh_deployment_generation IS NEW.deployment_generation AND c.nh_idempotency_key IS NEW.idempotency_key AND c.nh_model_profile_ref IS NEW.model_profile_ref
AND c.nh_observed_execution IS NEW.observed_execution AND c.nh_observed_fidelity IS NEW.observed_fidelity AND c.nh_observed_assurance IS NEW.observed_assurance
AND c.nh_status IS NEW.status AND c.nh_supersedes_id IS NEW.supersedes_id AND c.nh_supersession_reason IS NEW.supersession_reason
AND c.nh_event_head IS NEW.event_head AND c.nh_created_at IS NEW.created_at AND c.nh_updated_at IS NEW.updated_at)
BEGIN SELECT RAISE(ABORT, 'LEDGER_CONFLICT: head insert without atomic command authorization'); END;
CREATE TRIGGER IF NOT EXISTS ledger_cmd_head_update BEFORE UPDATE ON investigation_ledger_head
WHEN NOT EXISTS (SELECT 1 FROM investigation_ledger_command c WHERE NEW.revision = OLD.revision + 1 AND NEW.event_head = OLD.event_head + 1
AND OLD.revision IS c.expected_old_revision AND OLD.event_head IS c.expected_old_event_head
AND ((c.op_kind = 'APPEND' AND c.nh_investigation_id IS NEW.investigation_id AND c.nh_investigation_id IS OLD.investigation_id
AND c.nh_revision IS NEW.revision AND c.nh_protocol_version IS NEW.protocol_version AND c.nh_goal IS NEW.goal
AND c.nh_scope_snapshot_id IS NEW.scope_snapshot_id AND c.nh_scope_snapshot_revision IS NEW.scope_snapshot_revision
AND c.nh_evidence_grade IS NEW.evidence_grade AND c.nh_lane IS NEW.lane AND c.nh_lane_registrations_json IS NEW.lane_registrations_json
AND c.nh_obligations_json IS NEW.obligations_json AND c.nh_hypotheses_json IS NEW.hypotheses_json AND c.nh_portfolio_ref IS NEW.portfolio_ref
AND c.nh_debt_refs_json IS NEW.debt_refs_json AND c.nh_checkpoint_head IS NEW.checkpoint_head AND c.nh_principal_ref IS NEW.principal_ref
AND c.nh_input_digest IS NEW.input_digest AND c.nh_policy_generation IS NEW.policy_generation AND c.nh_policy_authority_ref IS NEW.policy_authority_ref
AND c.nh_deployment_generation IS NEW.deployment_generation AND c.nh_idempotency_key IS NEW.idempotency_key AND c.nh_model_profile_ref IS NEW.model_profile_ref
AND c.nh_observed_execution IS NEW.observed_execution AND c.nh_observed_fidelity IS NEW.observed_fidelity AND c.nh_observed_assurance IS NEW.observed_assurance
AND c.nh_status IS NEW.status AND c.nh_supersedes_id IS NEW.supersedes_id AND c.nh_supersession_reason IS NEW.supersession_reason
AND c.nh_event_head IS NEW.event_head AND c.nh_created_at IS NEW.created_at AND c.nh_updated_at IS NEW.updated_at)
OR (c.op_kind = 'SUPERSEDE' AND c.oh_investigation_id IS NEW.investigation_id AND c.oh_investigation_id IS OLD.investigation_id
AND c.oh_revision IS NEW.revision AND c.oh_protocol_version IS NEW.protocol_version AND c.oh_goal IS NEW.goal
AND c.oh_scope_snapshot_id IS NEW.scope_snapshot_id AND c.oh_scope_snapshot_revision IS NEW.scope_snapshot_revision
AND c.oh_evidence_grade IS NEW.evidence_grade AND c.oh_lane IS NEW.lane AND c.oh_lane_registrations_json IS NEW.lane_registrations_json
AND c.oh_obligations_json IS NEW.obligations_json AND c.oh_hypotheses_json IS NEW.hypotheses_json AND c.oh_portfolio_ref IS NEW.portfolio_ref
AND c.oh_debt_refs_json IS NEW.debt_refs_json AND c.oh_checkpoint_head IS NEW.checkpoint_head AND c.oh_principal_ref IS NEW.principal_ref
AND c.oh_input_digest IS NEW.input_digest AND c.oh_policy_generation IS NEW.policy_generation AND c.oh_policy_authority_ref IS NEW.policy_authority_ref
AND c.oh_deployment_generation IS NEW.deployment_generation AND c.oh_idempotency_key IS NEW.idempotency_key AND c.oh_model_profile_ref IS NEW.model_profile_ref
AND c.oh_observed_execution IS NEW.observed_execution AND c.oh_observed_fidelity IS NEW.observed_fidelity AND c.oh_observed_assurance IS NEW.observed_assurance
AND c.oh_status IS NEW.status AND c.oh_supersedes_id IS NEW.supersedes_id AND c.oh_supersession_reason IS NEW.supersession_reason
AND c.oh_event_head IS NEW.event_head AND c.oh_created_at IS NEW.created_at AND c.oh_updated_at IS NEW.updated_at)))
BEGIN SELECT RAISE(ABORT, 'LEDGER_STALE_HEAD: head update without atomic command authorization'); END;
CREATE TRIGGER IF NOT EXISTS ledger_cmd_head_no_delete BEFORE DELETE ON investigation_ledger_head
BEGIN SELECT RAISE(ABORT, 'LEDGER_CONFLICT: ledger heads are append-only; supersede instead of deleting'); END;
CREATE TRIGGER IF NOT EXISTS ledger_cmd_event_insert BEFORE INSERT ON investigation_ledger_event
WHEN NOT EXISTS (SELECT 1 FROM investigation_ledger_command c WHERE
(c.ne_investigation_id IS NEW.investigation_id AND c.ne_sequence IS NEW.sequence AND c.ne_event_id IS NEW.event_id AND c.ne_kind IS NEW.kind
AND c.ne_payload_handle_ref IS NEW.payload_handle_ref AND c.ne_payload_digest IS NEW.payload_digest AND c.ne_actor_ref IS NEW.actor_ref
AND c.ne_verifier_ref IS NEW.verifier_ref AND c.ne_created_at IS NEW.created_at)
OR (c.op_kind = 'SUPERSEDE' AND c.oe_investigation_id IS NEW.investigation_id AND c.oe_sequence IS NEW.sequence AND c.oe_event_id IS NEW.event_id AND c.oe_kind IS NEW.kind
AND c.oe_payload_handle_ref IS NEW.payload_handle_ref AND c.oe_payload_digest IS NEW.payload_digest AND c.oe_actor_ref IS NEW.actor_ref
AND c.oe_verifier_ref IS NEW.verifier_ref AND c.oe_created_at IS NEW.created_at))
BEGIN SELECT RAISE(ABORT, 'LEDGER_CONFLICT: event insert without atomic command authorization'); END;

-- Commands are immutable receipts: no update, no delete, no guard resume. Replay reconciles
-- by reading the committed command plus ledger readback, never by mutating a command row.
CREATE TRIGGER IF NOT EXISTS ledger_cmd_guard_retired BEFORE INSERT ON investigation_ledger_guard
BEGIN SELECT RAISE(ABORT, 'LEDGER_CONFLICT: guard path retired; use atomic ledger commands'); END;
CREATE TRIGGER IF NOT EXISTS ledger_cmd_immutable BEFORE UPDATE ON investigation_ledger_command
BEGIN SELECT RAISE(ABORT, 'LEDGER_CONFLICT: ledger commands are immutable receipts'); END;
CREATE TRIGGER IF NOT EXISTS ledger_cmd_no_delete BEFORE DELETE ON investigation_ledger_command
BEGIN SELECT RAISE(ABORT, 'LEDGER_CONFLICT: ledger commands are immutable receipts'); END;

INSERT INTO schema_state(key, value, updated_at) VALUES('investigation_ledger_command_generation', 'investigation-ledger-command-v1', '2026-09-06T00:00:00Z');
