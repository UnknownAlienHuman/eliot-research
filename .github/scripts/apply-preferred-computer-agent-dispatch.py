from pathlib import Path
from textwrap import dedent

ROOT = Path.cwd()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(dedent(content).lstrip(), encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}: {old[:160]!r}")
    target.write_text(text.replace(old, new), encoding="utf-8")


def append_once(path: str, marker: str, content: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    if marker in text:
        return
    target.write_text(text.rstrip() + "\n\n" + dedent(content).strip() + "\n", encoding="utf-8")


write("infra/d1/core/migrations/0094_computer_agent_preferred_dispatch.sql", r'''
-- Owner-authorized FIRST_READY selection. Selection is immutable and precedes exact dispatch creation.
-- A retry reuses the selected connection instead of re-reading a changed readiness order.
PRAGMA foreign_keys = ON;

CREATE TABLE computer_agent_preferred_dispatch_selection (
  selection_id TEXT PRIMARY KEY CHECK(length(selection_id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL REFERENCES project(project_id),
  task_kind TEXT NOT NULL CHECK(task_kind='RESEARCH_BRANCH_ANALYSIS'),
  selection_strategy TEXT NOT NULL CHECK(selection_strategy='FIRST_READY'),
  transport TEXT NOT NULL CHECK(transport IN ('MCP_WRITE','WEB_INBOX')),
  route_revision INTEGER NOT NULL CHECK(route_revision BETWEEN 1 AND 2147483647),
  priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 15),
  connection_id TEXT NOT NULL,
  connection_revision INTEGER NOT NULL CHECK(connection_revision BETWEEN 1 AND 2147483647),
  client_grant_id TEXT NOT NULL,
  client_grant_revision INTEGER NOT NULL CHECK(client_grant_revision BETWEEN 1 AND 2147483647),
  owner_principal_ref TEXT NOT NULL CHECK(length(owner_principal_ref) BETWEEN 1 AND 256),
  owner_credential_generation TEXT NOT NULL CHECK(length(owner_credential_generation) BETWEEN 1 AND 256),
  qualification_challenge_id TEXT NOT NULL
    REFERENCES computer_agent_connection_qualification_binding(challenge_id),
  qualification_observation_ref TEXT NOT NULL CHECK(length(qualification_observation_ref) BETWEEN 1 AND 256),
  qualification_credential_generation TEXT NOT NULL CHECK(length(qualification_credential_generation) BETWEEN 1 AND 256),
  qualification_ready_until TEXT NOT NULL CHECK(julianday(qualification_ready_until) IS NOT NULL),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  run_request_sha256 TEXT NOT NULL
    CHECK(length(run_request_sha256)=64 AND run_request_sha256 NOT GLOB '*[^0-9a-f]*'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  request_sha256 TEXT NOT NULL
    CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_json TEXT NOT NULL
    CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB)) BETWEEN 1 AND 32768),
  record_sha256 TEXT NOT NULL
    CHECK(length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  selected_at TEXT NOT NULL CHECK(julianday(selected_at) IS NOT NULL),
  UNIQUE(owner_principal_ref,idempotency_key),
  FOREIGN KEY(project_id,task_kind,route_revision,priority,connection_id,connection_revision)
    REFERENCES project_computer_agent_route_entry(
      project_id,task_kind,route_revision,priority,connection_id,connection_revision
    ),
  FOREIGN KEY(client_grant_id,client_grant_revision)
    REFERENCES project_client_grant(grant_id,revision),
  CHECK(selection_id='preferred-selection-' || substr(request_sha256,1,48)),
  CHECK(julianday(qualification_ready_until)>julianday(selected_at)),
  CHECK(json_extract(record_json,'$.protocol') IS 'eliotr.computer-agent-preferred-selection.v1'),
  CHECK(json_extract(record_json,'$.selection_id') IS selection_id),
  CHECK(json_extract(record_json,'$.project_id') IS project_id),
  CHECK(json_extract(record_json,'$.task_kind') IS task_kind),
  CHECK(json_extract(record_json,'$.selection_strategy') IS selection_strategy),
  CHECK(json_extract(record_json,'$.transport') IS transport),
  CHECK(json_extract(record_json,'$.route_revision') IS route_revision),
  CHECK(json_extract(record_json,'$.priority') IS priority),
  CHECK(json_extract(record_json,'$.connection_id') IS connection_id),
  CHECK(json_extract(record_json,'$.connection_revision') IS connection_revision),
  CHECK(json_extract(record_json,'$.client_grant_id') IS client_grant_id),
  CHECK(json_extract(record_json,'$.client_grant_revision') IS client_grant_revision),
  CHECK(json_extract(record_json,'$.owner_principal_ref') IS owner_principal_ref),
  CHECK(json_extract(record_json,'$.owner_credential_generation') IS owner_credential_generation),
  CHECK(json_extract(record_json,'$.qualification.challenge_id') IS qualification_challenge_id),
  CHECK(json_extract(record_json,'$.qualification.observation_ref') IS qualification_observation_ref),
  CHECK(json_extract(record_json,'$.qualification.verified_credential_generation')
    IS qualification_credential_generation),
  CHECK(json_extract(record_json,'$.qualification.ready_until') IS qualification_ready_until),
  CHECK(json_extract(record_json,'$.qualification.deployment_generation') IS deployment_generation),
  CHECK(json_extract(record_json,'$.run_request_sha256') IS run_request_sha256),
  CHECK(json_extract(record_json,'$.idempotency_key') IS idempotency_key),
  CHECK(json_extract(record_json,'$.request_sha256') IS request_sha256),
  CHECK(json_extract(record_json,'$.selected_at') IS selected_at)
) STRICT;

CREATE INDEX computer_agent_preferred_selection_project_idx
  ON computer_agent_preferred_dispatch_selection(project_id,task_kind,selected_at,selection_id);

CREATE TRIGGER computer_agent_preferred_selection_insert_guard
BEFORE INSERT ON computer_agent_preferred_dispatch_selection
WHEN NOT EXISTS (
  SELECT 1
  FROM project_computer_agent_route_current r
  JOIN project_computer_agent_route_entry e
    ON e.project_id=r.project_id AND e.task_kind=r.task_kind AND e.route_revision=r.revision
    AND e.priority=NEW.priority AND e.connection_id=NEW.connection_id
    AND e.connection_revision=NEW.connection_revision
  JOIN computer_agent_connection_current c
    ON c.connection_id=e.connection_id AND c.revision=e.connection_revision AND c.state='ENABLED'
  JOIN project_client_grant_current g
    ON g.grant_id=NEW.client_grant_id AND g.revision=NEW.client_grant_revision AND g.state='ACTIVE'
  JOIN project_owner o ON o.project_id=r.project_id AND o.principal_ref=r.owner_principal_ref
  JOIN computer_agent_connection_qualification_observation q
    ON q.challenge_id=NEW.qualification_challenge_id
  WHERE r.project_id=NEW.project_id AND r.task_kind=NEW.task_kind
    AND r.revision=NEW.route_revision AND r.state='ACTIVE'
    AND r.owner_principal_ref=NEW.owner_principal_ref
    AND c.owner_principal_ref=NEW.owner_principal_ref
    AND EXISTS (SELECT 1 FROM json_each(c.task_kinds_json) WHERE value=NEW.task_kind)
    AND EXISTS (SELECT 1 FROM json_each(c.transport_capabilities_json) WHERE value=NEW.transport)
    AND g.project_id=NEW.project_id AND g.grantor_principal_ref=NEW.owner_principal_ref
    AND g.grantee_method='service_token'
    AND g.grantee_issuer=c.actor_issuer AND g.grantee_subject=c.actor_subject
    AND g.spend_policy_ref IS NOT NULL AND julianday(g.expires_at)>julianday(NEW.selected_at)
    AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='run')
    AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='recover')
    AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='evidence')
    AND q.connection_id=NEW.connection_id AND q.connection_revision=NEW.connection_revision
    AND q.transport=NEW.transport AND q.owner_principal_ref=NEW.owner_principal_ref
    AND q.challenge_state='CONFIRMED' AND q.auth_profile='service-token'
    AND q.connection_state='ENABLED' AND q.current_connection_state='ENABLED'
    AND q.current_connection_revision=NEW.connection_revision
    AND q.verified_authentication_method='service_token'
    AND q.verified_actor_ref=q.actor_subject
    AND q.observation_ref=NEW.qualification_observation_ref
    AND q.verified_credential_generation=NEW.qualification_credential_generation
    AND q.deployment_generation=NEW.deployment_generation
    AND q.challenge_id=(
      SELECT q2.challenge_id
      FROM computer_agent_connection_qualification_observation q2
      WHERE q2.connection_id=NEW.connection_id
        AND q2.connection_revision=NEW.connection_revision AND q2.transport=NEW.transport
      ORDER BY q2.issued_at DESC,q2.challenge_id DESC LIMIT 1
    )
    AND julianday(q.observed_at)<=julianday(NEW.selected_at)
    AND julianday(NEW.qualification_ready_until)<=julianday(q.observed_at,'+1 day')
    AND julianday(NEW.qualification_ready_until)<=julianday(q.verified_expires_at)
    AND NOT EXISTS (
      SELECT 1
      FROM project_computer_agent_route_entry pe
      JOIN computer_agent_connection_current pc
        ON pc.connection_id=pe.connection_id AND pc.revision=pe.connection_revision
        AND pc.state='ENABLED'
      JOIN computer_agent_connection_qualification_observation pq
        ON pq.connection_id=pe.connection_id AND pq.connection_revision=pe.connection_revision
        AND pq.transport=NEW.transport
      WHERE pe.project_id=NEW.project_id AND pe.task_kind=NEW.task_kind
        AND pe.route_revision=NEW.route_revision AND pe.priority<NEW.priority
        AND pc.owner_principal_ref=NEW.owner_principal_ref
        AND EXISTS (SELECT 1 FROM json_each(pc.task_kinds_json) WHERE value=NEW.task_kind)
        AND EXISTS (SELECT 1 FROM json_each(pc.transport_capabilities_json) WHERE value=NEW.transport)
        AND pq.challenge_id=(
          SELECT pq2.challenge_id
          FROM computer_agent_connection_qualification_observation pq2
          WHERE pq2.connection_id=pe.connection_id
            AND pq2.connection_revision=pe.connection_revision AND pq2.transport=NEW.transport
          ORDER BY pq2.issued_at DESC,pq2.challenge_id DESC LIMIT 1
        )
        AND pq.challenge_state='CONFIRMED' AND pq.auth_profile='service-token'
        AND pq.connection_state='ENABLED' AND pq.current_connection_state='ENABLED'
        AND pq.current_connection_revision=pe.connection_revision
        AND pq.verified_authentication_method='service_token'
        AND pq.verified_actor_ref=pq.actor_subject
        AND pq.deployment_generation=NEW.deployment_generation
        AND julianday(pq.observed_at)<=julianday(NEW.selected_at)
        AND julianday(NEW.selected_at)<julianday(pq.observed_at,'+1 day')
        AND julianday(NEW.selected_at)<julianday(pq.verified_expires_at)
    )
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SELECTION_AUTHORITY_STALE'); END;

CREATE TRIGGER computer_agent_preferred_selection_no_update
BEFORE UPDATE ON computer_agent_preferred_dispatch_selection
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SELECTION_IMMUTABLE'); END;
CREATE TRIGGER computer_agent_preferred_selection_no_delete
BEFORE DELETE ON computer_agent_preferred_dispatch_selection
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SELECTION_IMMUTABLE'); END;

CREATE TABLE computer_agent_preferred_dispatch_settlement (
  selection_id TEXT PRIMARY KEY
    REFERENCES computer_agent_preferred_dispatch_selection(selection_id),
  dispatch_id TEXT NOT NULL UNIQUE REFERENCES computer_agent_dispatch(dispatch_id),
  record_json TEXT NOT NULL
    CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB)) BETWEEN 1 AND 8192),
  record_sha256 TEXT NOT NULL
    CHECK(length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  settled_at TEXT NOT NULL CHECK(julianday(settled_at) IS NOT NULL),
  CHECK(json_extract(record_json,'$.protocol')
    IS 'eliotr.computer-agent-preferred-dispatch-settlement.v1'),
  CHECK(json_extract(record_json,'$.selection_id') IS selection_id),
  CHECK(json_extract(record_json,'$.dispatch_id') IS dispatch_id),
  CHECK(json_extract(record_json,'$.settled_at') IS settled_at)
) STRICT;

CREATE TRIGGER computer_agent_preferred_settlement_insert_guard
BEFORE INSERT ON computer_agent_preferred_dispatch_settlement
WHEN NOT EXISTS (
  SELECT 1
  FROM computer_agent_preferred_dispatch_selection s
  JOIN computer_agent_dispatch d ON d.dispatch_id=NEW.dispatch_id
  WHERE s.selection_id=NEW.selection_id
    AND d.project_id=s.project_id AND d.task_kind=s.task_kind AND d.transport=s.transport
    AND d.route_revision=s.route_revision AND d.priority=s.priority
    AND d.connection_id=s.connection_id AND d.connection_revision=s.connection_revision
    AND d.client_grant_id=s.client_grant_id AND d.client_grant_revision=s.client_grant_revision
    AND d.owner_principal_ref=s.owner_principal_ref
    AND d.owner_credential_generation=s.owner_credential_generation
    AND d.qualification_challenge_id=s.qualification_challenge_id
    AND d.qualification_observation_ref=s.qualification_observation_ref
    AND d.qualification_credential_generation=s.qualification_credential_generation
    AND d.deployment_generation=s.deployment_generation
    AND d.run_request_sha256=s.run_request_sha256
    AND julianday(d.created_at)>=julianday(s.selected_at)
    AND julianday(d.expires_at)<=julianday(s.qualification_ready_until)
    AND julianday(NEW.settled_at)>=julianday(d.created_at)
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SETTLEMENT_CONFLICT'); END;

CREATE TRIGGER computer_agent_preferred_settlement_no_update
BEFORE UPDATE ON computer_agent_preferred_dispatch_settlement
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SETTLEMENT_IMMUTABLE'); END;
CREATE TRIGGER computer_agent_preferred_settlement_no_delete
BEFORE DELETE ON computer_agent_preferred_dispatch_settlement
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SETTLEMENT_IMMUTABLE'); END;

INSERT INTO schema_state(key,value,updated_at)
VALUES('computer_agent_preferred_dispatch_generation','computer-agent-preferred-dispatch-v1',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'));
''')

replace_once(
    "packages/contracts/src/computer-agent-dispatch.ts",
    '''export type ComputerAgentDispatchCreate = z.infer<typeof ComputerAgentDispatchCreateSchema>;\n\n''',
    '''export type ComputerAgentDispatchCreate = z.infer<typeof ComputerAgentDispatchCreateSchema>;\n\nexport const ComputerAgentPreferredDispatchCreateSchema = z.object({\n  transport: ComputerAgentQualificationTransportSchema,\n  expected_route_revision: revision,\n  client_grant_id: id,\n  client_grant_revision: revision,\n  expires_in_seconds: z.number().int().min(60).max(3600),\n  run_request: ComputerAgentDispatchRunRequestSchema,\n}).strict();\nexport type ComputerAgentPreferredDispatchCreate =\n  z.infer<typeof ComputerAgentPreferredDispatchCreateSchema>;\n\n''',
)
replace_once(
    "packages/contracts/src/computer-agent-dispatch.ts",
    '''export type ComputerAgentDispatch = z.infer<typeof ComputerAgentDispatchSchema>;\n\n''',
    '''export type ComputerAgentDispatch = z.infer<typeof ComputerAgentDispatchSchema>;\n\nexport const ComputerAgentPreferredDispatchSelectionSchema = z.object({\n  protocol: z.literal("eliotr.computer-agent-preferred-selection.v1"),\n  selection_id: id,\n  project_id: id,\n  task_kind: ComputerAgentTaskKindSchema,\n  selection_strategy: z.literal("FIRST_READY"),\n  transport: ComputerAgentQualificationTransportSchema,\n  route_revision: revision,\n  priority: z.number().int().min(0).max(15),\n  connection_id: id,\n  connection_revision: revision,\n  client_grant_id: id,\n  client_grant_revision: revision,\n  owner_principal_ref: id,\n  owner_credential_generation: id,\n  qualification: ComputerAgentDispatchQualificationSchema,\n  run_request_sha256: Sha256Schema,\n  idempotency_key: actionKey,\n  request_sha256: Sha256Schema,\n  selected_at: IsoDateTimeSchema,\n}).strict().superRefine((value, context) => {\n  if (value.task_kind !== "RESEARCH_BRANCH_ANALYSIS") {\n    context.addIssue({ code: "custom", path: ["task_kind"],\n      message: "Preferred dispatch supports only RESEARCH_BRANCH_ANALYSIS" });\n  }\n  if (value.selection_id !== `preferred-selection-${value.request_sha256.slice(0, 48)}` ||\n      Date.parse(value.qualification.ready_until) <= Date.parse(value.selected_at)) {\n    context.addIssue({ code: "custom", message: "Preferred selection identity or expiry is invalid" });\n  }\n});\nexport type ComputerAgentPreferredDispatchSelection =\n  z.infer<typeof ComputerAgentPreferredDispatchSelectionSchema>;\n\nexport const ComputerAgentPreferredDispatchSettlementSchema = z.object({\n  protocol: z.literal("eliotr.computer-agent-preferred-dispatch-settlement.v1"),\n  selection_id: id,\n  dispatch_id: id,\n  settled_at: IsoDateTimeSchema,\n}).strict();\nexport type ComputerAgentPreferredDispatchSettlement =\n  z.infer<typeof ComputerAgentPreferredDispatchSettlementSchema>;\n\nexport const ComputerAgentPreferredDispatchReceiptSchema = z.object({\n  protocol: z.literal("eliotr.computer-agent-preferred-dispatch-receipt.v1"),\n  selection: ComputerAgentPreferredDispatchSelectionSchema,\n  settlement: ComputerAgentPreferredDispatchSettlementSchema,\n  dispatch: ComputerAgentDispatchSchema,\n}).strict().superRefine((value, context) => {\n  const selection = value.selection;\n  const dispatch = value.dispatch;\n  if (value.settlement.selection_id !== selection.selection_id ||\n      value.settlement.dispatch_id !== dispatch.dispatch_id ||\n      dispatch.project_id !== selection.project_id || dispatch.task_kind !== selection.task_kind ||\n      dispatch.transport !== selection.transport || dispatch.route_revision !== selection.route_revision ||\n      dispatch.priority !== selection.priority || dispatch.connection_id !== selection.connection_id ||\n      dispatch.connection_revision !== selection.connection_revision ||\n      dispatch.client_grant_id !== selection.client_grant_id ||\n      dispatch.client_grant_revision !== selection.client_grant_revision ||\n      dispatch.owner_principal_ref !== selection.owner_principal_ref ||\n      dispatch.owner_credential_generation !== selection.owner_credential_generation ||\n      dispatch.qualification.challenge_id !== selection.qualification.challenge_id ||\n      dispatch.qualification.observation_ref !== selection.qualification.observation_ref ||\n      dispatch.qualification.verified_credential_generation !==\n        selection.qualification.verified_credential_generation ||\n      dispatch.run_request_sha256 !== selection.run_request_sha256) {\n    context.addIssue({ code: "custom", message: "Preferred dispatch receipt identities differ" });\n  }\n});\nexport type ComputerAgentPreferredDispatchReceipt =\n  z.infer<typeof ComputerAgentPreferredDispatchReceiptSchema>;\n\n''',
)

write("apps/eliotr-core/src/computer-agent-preferred-dispatch.ts", r'''
import {
  ComputerAgentPreferredDispatchCreateSchema,
  ComputerAgentPreferredDispatchReceiptSchema,
  ComputerAgentPreferredDispatchSelectionSchema,
  ComputerAgentPreferredDispatchSettlementSchema,
  type ComputerAgentDispatch,
  type ComputerAgentPreferredDispatchReceipt,
  type ComputerAgentPreferredDispatchSelection,
  type ComputerAgentPreferredDispatchSettlement,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { ComputerAgentRouteError } from "./computer-agent-route-store.js";
import { readProjectComputerAgentRouteReadiness } from "./computer-agent-route-readiness.js";
import { createComputerAgentDispatchService } from "./computer-agent-dispatch-store.js";
import {
  decodeComputerAgentDispatch,
  readComputerAgentDispatchReplay,
  readComputerAgentDispatchRow,
} from "./computer-agent-dispatch-record.js";
import { failComputerAgentDispatch as fail } from "./computer-agent-dispatch-error.js";
import type { Env } from "./env.js";

const SCHEMA_GENERATION = "computer-agent-preferred-dispatch-v1";
const TASK_KIND = "RESEARCH_BRANCH_ANALYSIS" as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const KEY = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;
const INTERNAL_PREFIX = "preferred-dispatch-";

interface SelectionRow {
  selection_id: string;
  project_id: string;
  task_kind: string;
  selection_strategy: string;
  transport: string;
  route_revision: number;
  priority: number;
  connection_id: string;
  connection_revision: number;
  client_grant_id: string;
  client_grant_revision: number;
  owner_principal_ref: string;
  owner_credential_generation: string;
  qualification_challenge_id: string;
  qualification_observation_ref: string;
  qualification_credential_generation: string;
  qualification_ready_until: string;
  deployment_generation: string;
  run_request_sha256: string;
  idempotency_key: string;
  request_sha256: string;
  record_json: string;
  record_sha256: string;
  selected_at: string;
}
interface SettlementRow {
  selection_id: string;
  dispatch_id: string;
  record_json: string;
  record_sha256: string;
  settled_at: string;
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400, `${label} is invalid`);
  }
  return value;
}
function idempotency(value: unknown): string {
  if (typeof value !== "string" || !KEY.test(value) || value.startsWith(INTERNAL_PREFIX)) {
    fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,
      "Idempotency-Key is required, invalid, or uses a reserved prefix");
  }
  return value;
}
function instant(now: () => number): number {
  let value: number;
  try { value = now(); }
  catch { return fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
    "Preferred-dispatch clock is unavailable", true); }
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Preferred-dispatch clock is invalid", true);
  }
  return value;
}
function owner(context: AuthenticatedRequestContext, now: () => number) {
  const current = instant(now);
  if (context.client_class !== "owner_pwa" || context.request.signal.aborted) {
    fail("COMPUTER_AGENT_DISPATCH_OWNER_REQUIRED", 403, "A current owner request is required");
  }
  if (context.access && (context.access.principal_ref !== context.principal_ref ||
      context.access.credential_generation !== context.credential_generation ||
      !Number.isFinite(Date.parse(context.access.expires_at)) ||
      Date.parse(context.access.expires_at) <= current)) {
    fail("COMPUTER_AGENT_DISPATCH_OWNER_REQUIRED", 403, "Owner session is no longer current");
  }
  return Object.freeze({
    principal_ref: identifier(context.principal_ref, "owner principal"),
    credential_generation: identifier(context.credential_generation, "owner credential generation"),
  });
}
async function requireSchema(db: D1Database): Promise<void> {
  let value: string | null;
  try {
    value = await db.prepare(
      "SELECT value FROM schema_state WHERE key='computer_agent_preferred_dispatch_generation'",
    ).first<string>("value");
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_SCHEMA_NOT_READY", 503,
      "Computer-agent preferred dispatch migration 0094 is required", true);
  }
  if (value !== SCHEMA_GENERATION) {
    fail("COMPUTER_AGENT_DISPATCH_SCHEMA_NOT_READY", 503,
      "Computer-agent preferred dispatch migration 0094 is required", true);
  }
}
function mapReadiness(error: unknown): never {
  if (error instanceof ComputerAgentRouteError) {
    if (error.retryable) fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Preferred route readiness is unavailable", true);
    if (error.status >= 500) fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Preferred route readiness is corrupt");
    fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
      "Preferred route readiness is no longer current");
  }
  throw error;
}
async function readSelectionReplay(db: D1Database, principal: string,
  key: string): Promise<SelectionRow | null> {
  try {
    return await db.prepare("SELECT * FROM computer_agent_preferred_dispatch_selection " +
      "WHERE owner_principal_ref=?1 AND idempotency_key=?2 LIMIT 1")
      .bind(principal, key).first<SelectionRow>();
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Preferred selection replay is unavailable", true);
  }
}
async function readSettlement(db: D1Database, selectionId: string): Promise<SettlementRow | null> {
  try {
    return await db.prepare("SELECT * FROM computer_agent_preferred_dispatch_settlement " +
      "WHERE selection_id=?1 LIMIT 1").bind(selectionId).first<SettlementRow>();
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Preferred dispatch settlement read is unavailable", true);
  }
}
async function decodeSelection(row: SelectionRow): Promise<ComputerAgentPreferredDispatchSelection> {
  let raw: unknown;
  try { raw = JSON.parse(row.record_json); }
  catch { return fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
    "Preferred selection is not valid JSON"); }
  const parsed = ComputerAgentPreferredDispatchSelectionSchema.safeParse(raw);
  if (!parsed.success || canonicalJson(parsed.data) !== row.record_json ||
      await sha256Utf8(row.record_json) !== row.record_sha256 ||
      parsed.data.selection_id !== row.selection_id || parsed.data.project_id !== row.project_id ||
      parsed.data.task_kind !== row.task_kind ||
      parsed.data.selection_strategy !== row.selection_strategy ||
      parsed.data.transport !== row.transport || parsed.data.route_revision !== row.route_revision ||
      parsed.data.priority !== row.priority || parsed.data.connection_id !== row.connection_id ||
      parsed.data.connection_revision !== row.connection_revision ||
      parsed.data.client_grant_id !== row.client_grant_id ||
      parsed.data.client_grant_revision !== row.client_grant_revision ||
      parsed.data.owner_principal_ref !== row.owner_principal_ref ||
      parsed.data.owner_credential_generation !== row.owner_credential_generation ||
      parsed.data.qualification.challenge_id !== row.qualification_challenge_id ||
      parsed.data.qualification.observation_ref !== row.qualification_observation_ref ||
      parsed.data.qualification.verified_credential_generation !==
        row.qualification_credential_generation ||
      parsed.data.qualification.ready_until !== row.qualification_ready_until ||
      parsed.data.qualification.deployment_generation !== row.deployment_generation ||
      parsed.data.run_request_sha256 !== row.run_request_sha256 ||
      parsed.data.idempotency_key !== row.idempotency_key ||
      parsed.data.request_sha256 !== row.request_sha256 ||
      parsed.data.selected_at !== row.selected_at) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Preferred selection identity is corrupt");
  }
  return parsed.data;
}
async function decodeSettlement(row: SettlementRow): Promise<ComputerAgentPreferredDispatchSettlement> {
  let raw: unknown;
  try { raw = JSON.parse(row.record_json); }
  catch { return fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
    "Preferred dispatch settlement is not valid JSON"); }
  const parsed = ComputerAgentPreferredDispatchSettlementSchema.safeParse(raw);
  if (!parsed.success || canonicalJson(parsed.data) !== row.record_json ||
      await sha256Utf8(row.record_json) !== row.record_sha256 ||
      parsed.data.selection_id !== row.selection_id || parsed.data.dispatch_id !== row.dispatch_id ||
      parsed.data.settled_at !== row.settled_at) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Preferred dispatch settlement identity is corrupt");
  }
  return parsed.data;
}
function requireDispatchMatch(dispatch: ComputerAgentDispatch,
  selection: ComputerAgentPreferredDispatchSelection, runRequest: unknown): void {
  if (dispatch.project_id !== selection.project_id || dispatch.task_kind !== selection.task_kind ||
      dispatch.transport !== selection.transport || dispatch.route_revision !== selection.route_revision ||
      dispatch.priority !== selection.priority || dispatch.connection_id !== selection.connection_id ||
      dispatch.connection_revision !== selection.connection_revision ||
      dispatch.client_grant_id !== selection.client_grant_id ||
      dispatch.client_grant_revision !== selection.client_grant_revision ||
      dispatch.owner_principal_ref !== selection.owner_principal_ref ||
      dispatch.owner_credential_generation !== selection.owner_credential_generation ||
      canonicalJson(dispatch.qualification) !== canonicalJson(selection.qualification) ||
      dispatch.run_request_sha256 !== selection.run_request_sha256 ||
      canonicalJson(dispatch.run_request) !== canonicalJson(runRequest)) {
    fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
      "Preferred selection settled a different exact dispatch");
  }
}
async function receipt(db: D1Database, selection: ComputerAgentPreferredDispatchSelection,
  settlement: ComputerAgentPreferredDispatchSettlement, runRequest: unknown,
): Promise<ComputerAgentPreferredDispatchReceipt> {
  const row = await readComputerAgentDispatchRow(db, settlement.dispatch_id);
  if (row === null) fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
    "Preferred settlement references a missing dispatch");
  const dispatch = await decodeComputerAgentDispatch(row);
  requireDispatchMatch(dispatch, selection, runRequest);
  return ComputerAgentPreferredDispatchReceiptSchema.parse({
    protocol: "eliotr.computer-agent-preferred-dispatch-receipt.v1",
    selection,
    settlement,
    dispatch,
  });
}

export function createComputerAgentPreferredDispatchService(env: Env, options?: {
  readonly now?: () => number;
}) {
  const db = env.CORE_DB;
  const now = options?.now ?? Date.now;

  async function create(context: AuthenticatedRequestContext,
    projectIdValue: string, rawInput: unknown): Promise<ComputerAgentPreferredDispatchReceipt> {
    await requireSchema(db);
    const identity = owner(context, now);
    const projectId = identifier(projectIdValue, "project_id");
    const parsed = ComputerAgentPreferredDispatchCreateSchema.safeParse(rawInput);
    if (!parsed.success || parsed.data.run_request.scope_expression.project_id !== projectId) {
      fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,
        "Preferred dispatch input contains unknown, invalid or cross-project fields");
    }
    const key = idempotency(context.request.headers.get("Idempotency-Key"));
    const requestSha = await sha256Utf8(canonicalJson({
      protocol: "eliotr.computer-agent-preferred-dispatch-create.v1",
      project_id: projectId,
      owner_principal_ref: identity.principal_ref,
      input: parsed.data,
    }));
    let row = await readSelectionReplay(db, identity.principal_ref, key);
    if (row !== null && (row.project_id !== projectId || row.request_sha256 !== requestSha)) {
      fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
        "Idempotency-Key is already bound to another preferred selection");
    }
    if (row === null) {
      const readiness = await readProjectComputerAgentRouteReadiness({
        database: db,
        context,
        project_id: projectId,
        task_kind: TASK_KIND,
        transport: parsed.data.transport,
        deployment_generation: env.DEPLOYMENT_GENERATION,
        now,
      }).catch(mapReadiness);
      if (readiness.route_state !== "ACTIVE" ||
          readiness.route_revision !== parsed.data.expected_route_revision ||
          readiness.preferred_ready_connection === null) {
        fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
          "The expected route has no READY preferred connection for this transport");
      }
      const preferred = readiness.preferred_ready_connection;
      const entry = readiness.entries[preferred.priority];
      const qualification = entry?.qualification;
      if (entry === undefined || !entry.eligible ||
          entry.connection_id !== preferred.connection_id ||
          entry.connection_revision !== preferred.connection_revision ||
          qualification?.status !== "READY" || qualification.observation_ref === undefined ||
          qualification.verified_credential_generation === undefined ||
          qualification.ready_until === undefined ||
          qualification.deployment_generation !== env.DEPLOYMENT_GENERATION) {
        fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
          "Preferred readiness report is internally inconsistent");
      }
      const runRequestSha = await sha256Utf8(canonicalJson(parsed.data.run_request));
      const selection = ComputerAgentPreferredDispatchSelectionSchema.parse({
        protocol: "eliotr.computer-agent-preferred-selection.v1",
        selection_id: `preferred-selection-${requestSha.slice(0, 48)}`,
        project_id: projectId,
        task_kind: TASK_KIND,
        selection_strategy: "FIRST_READY",
        transport: parsed.data.transport,
        route_revision: readiness.route_revision,
        priority: entry.priority,
        connection_id: entry.connection_id,
        connection_revision: entry.connection_revision,
        client_grant_id: parsed.data.client_grant_id,
        client_grant_revision: parsed.data.client_grant_revision,
        owner_principal_ref: identity.principal_ref,
        owner_credential_generation: identity.credential_generation,
        qualification: {
          challenge_id: qualification.challenge_id,
          observation_ref: qualification.observation_ref,
          verified_credential_generation: qualification.verified_credential_generation,
          ready_until: qualification.ready_until,
          deployment_generation: qualification.deployment_generation,
        },
        run_request_sha256: runRequestSha,
        idempotency_key: key,
        request_sha256: requestSha,
        selected_at: readiness.observed_at,
      });
      const record = canonicalJson(selection);
      const digest = await sha256Utf8(record);
      owner(context, now);
      try {
        await db.prepare("INSERT INTO computer_agent_preferred_dispatch_selection(" +
          "selection_id,project_id,task_kind,selection_strategy,transport,route_revision,priority," +
          "connection_id,connection_revision,client_grant_id,client_grant_revision," +
          "owner_principal_ref,owner_credential_generation,qualification_challenge_id," +
          "qualification_observation_ref,qualification_credential_generation," +
          "qualification_ready_until,deployment_generation,run_request_sha256,idempotency_key," +
          "request_sha256,record_json,record_sha256,selected_at) " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16," +
          "?17,?18,?19,?20,?21,?22,?23,?24)")
          .bind(selection.selection_id, selection.project_id, selection.task_kind,
            selection.selection_strategy, selection.transport, selection.route_revision,
            selection.priority, selection.connection_id, selection.connection_revision,
            selection.client_grant_id, selection.client_grant_revision,
            selection.owner_principal_ref, selection.owner_credential_generation,
            selection.qualification.challenge_id, selection.qualification.observation_ref,
            selection.qualification.verified_credential_generation,
            selection.qualification.ready_until,
            selection.qualification.deployment_generation, selection.run_request_sha256,
            selection.idempotency_key, selection.request_sha256, record, digest,
            selection.selected_at).run();
      } catch { /* Immutable owner/key readback below reconciles the selection intent. */ }
      row = await readSelectionReplay(db, identity.principal_ref, key);
      if (row === null) fail("COMPUTER_AGENT_DISPATCH_SETTLEMENT_UNCERTAIN", 503,
        "Preferred selection acknowledgement is uncertain; retry the same request", true);
      const recorded = await decodeSelection(row);
      if (canonicalJson(recorded) !== record) fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
        "Preferred selection readback differs from the intended record");
    }
    const selection = await decodeSelection(row);
    if (selection.request_sha256 !== requestSha ||
        selection.run_request_sha256 !== await sha256Utf8(canonicalJson(parsed.data.run_request))) {
      fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
        "Preferred selection is bound to another request");
    }
    let settlementRow = await readSettlement(db, selection.selection_id);
    if (settlementRow !== null) {
      owner(context, now);
      return receipt(db, selection, await decodeSettlement(settlementRow), parsed.data.run_request);
    }
    if (selection.owner_credential_generation !== identity.credential_generation) {
      fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
        "Unsettled preferred selection belongs to another owner credential generation");
    }
    const internalKey = `${INTERNAL_PREFIX}${selection.request_sha256.slice(0, 48)}`;
    const existing = await readComputerAgentDispatchReplay(db, identity.principal_ref, internalKey);
    let dispatch: ComputerAgentDispatch;
    if (existing !== null) {
      dispatch = await decodeComputerAgentDispatch(existing);
      requireDispatchMatch(dispatch, selection, parsed.data.run_request);
    } else {
      const headers = new Headers(context.request.headers);
      headers.set("Idempotency-Key", internalKey);
      headers.set("Content-Type", "application/json");
      const internalContext: AuthenticatedRequestContext = {
        ...context,
        request: new Request(context.request.url, {
          method: "POST",
          headers,
          signal: context.request.signal,
        }),
      };
      dispatch = await createComputerAgentDispatchService(env, {
        now,
        allow_preferred_internal_key: true,
      }).create(internalContext, projectId, {
        transport: selection.transport,
        expected_route_revision: selection.route_revision,
        connection_id: selection.connection_id,
        connection_revision: selection.connection_revision,
        client_grant_id: selection.client_grant_id,
        client_grant_revision: selection.client_grant_revision,
        expires_in_seconds: parsed.data.expires_in_seconds,
        run_request: parsed.data.run_request,
      });
      requireDispatchMatch(dispatch, selection, parsed.data.run_request);
    }
    const settlement = ComputerAgentPreferredDispatchSettlementSchema.parse({
      protocol: "eliotr.computer-agent-preferred-dispatch-settlement.v1",
      selection_id: selection.selection_id,
      dispatch_id: dispatch.dispatch_id,
      settled_at: dispatch.created_at,
    });
    const settlementJson = canonicalJson(settlement);
    const settlementSha = await sha256Utf8(settlementJson);
    owner(context, now);
    try {
      await db.prepare("INSERT INTO computer_agent_preferred_dispatch_settlement(" +
        "selection_id,dispatch_id,record_json,record_sha256,settled_at) VALUES (?1,?2,?3,?4,?5)")
        .bind(settlement.selection_id, settlement.dispatch_id, settlementJson,
          settlementSha, settlement.settled_at).run();
    } catch { /* Exact immutable selection settlement readback below reconciles lost ACK. */ }
    settlementRow = await readSettlement(db, selection.selection_id);
    if (settlementRow === null) fail("COMPUTER_AGENT_DISPATCH_SETTLEMENT_UNCERTAIN", 503,
      "Preferred dispatch settlement is uncertain; retry the same request", true);
    const recordedSettlement = await decodeSettlement(settlementRow);
    if (canonicalJson(recordedSettlement) !== settlementJson) {
      fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
        "Preferred dispatch settlement readback differs from the intended record");
    }
    owner(context, now);
    return ComputerAgentPreferredDispatchReceiptSchema.parse({
      protocol: "eliotr.computer-agent-preferred-dispatch-receipt.v1",
      selection,
      settlement: recordedSettlement,
      dispatch,
    });
  }
  return Object.freeze({ create });
}
''')

replace_once(
    "apps/eliotr-core/src/computer-agent-dispatch-store.ts",
    '''  readonly start_run?: (context: AuthenticatedRequestContext, request: QueryRequest) =>\n    Promise<{ investigation_ref: { readonly id: string; readonly revision: number };\n      workflow_instance_id: string }>;\n}) {\n''',
    '''  readonly start_run?: (context: AuthenticatedRequestContext, request: QueryRequest) =>\n    Promise<{ investigation_ref: { readonly id: string; readonly revision: number };\n      workflow_instance_id: string }>;\n  readonly allow_preferred_internal_key?: boolean | undefined;\n}) {\n''',
)
replace_once(
    "apps/eliotr-core/src/computer-agent-dispatch-store.ts",
    '''    const key = idempotency(context.request.headers.get("Idempotency-Key"));\n    const requestSha = await sha256Utf8(canonicalJson({\n''',
    '''    const key = idempotency(context.request.headers.get("Idempotency-Key"));\n    if (key.startsWith("preferred-dispatch-") &&\n        options?.allow_preferred_internal_key !== true) {\n      fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,\n        "Idempotency-Key uses the reserved preferred-dispatch namespace");\n    }\n    const requestSha = await sha256Utf8(canonicalJson({\n''',
)

replace_once(
    "apps/eliotr-core/src/computer-agent-dispatch-http.ts",
    'import { createComputerAgentDispatchReassignmentService } from "./computer-agent-dispatch-reassignment.js";\n',
    'import { createComputerAgentDispatchReassignmentService } from "./computer-agent-dispatch-reassignment.js";\nimport { createComputerAgentPreferredDispatchService } from "./computer-agent-preferred-dispatch.js";\n',
)
replace_once(
    "apps/eliotr-core/src/computer-agent-dispatch-http.ts",
    '''    if (operation === "research.computer-agent-dispatches.create") {\n      requireOwnerMutationOrigin(request, url);\n      return apiResult(request, env, await service.create(\n        context,\n        params.project_id ?? "",\n        await readJsonBodyWithinBytes(request, maximumBytes),\n      ));\n    }\n''',
    '''    if (operation === "research.computer-agent-dispatches.create" ||\n        operation === "research.computer-agent-dispatches.create-preferred") {\n      requireOwnerMutationOrigin(request, url);\n      const body: unknown = await readJsonBodyWithinBytes(request, maximumBytes);\n      return apiResult(request, env,\n        operation === "research.computer-agent-dispatches.create-preferred"\n          ? await createComputerAgentPreferredDispatchService(env).create(\n              context, params.project_id ?? "", body)\n          : await service.create(context, params.project_id ?? "", body));\n    }\n''',
)

replace_once(
    "apps/eliotr-core/src/http-special-routes.ts",
    '''    case "research.computer-agent-dispatches.create":\n    case "research.computer-agent-dispatches.abandon":\n''',
    '''    case "research.computer-agent-dispatches.create":\n    case "research.computer-agent-dispatches.create-preferred":\n    case "research.computer-agent-dispatches.abandon":\n''',
)

replace_once(
    "packages/interfaces/src/routes.ts",
    '''  { method: "POST", path: "/api/v1/research/projects/:project_id/computer-agent-dispatches", operation: "research.computer-agent-dispatches.create", auth: "owner", maximum_request_bytes: RESEARCH_REQUEST_MAX_BYTES + 32768, response_mode: "json" },\n''',
    '''  { method: "POST", path: "/api/v1/research/projects/:project_id/computer-agent-dispatches", operation: "research.computer-agent-dispatches.create", auth: "owner", maximum_request_bytes: RESEARCH_REQUEST_MAX_BYTES + 32768, response_mode: "json" },\n  { method: "POST", path: "/api/v1/research/projects/:project_id/computer-agent-dispatches/preferred", operation: "research.computer-agent-dispatches.create-preferred", auth: "owner", maximum_request_bytes: RESEARCH_REQUEST_MAX_BYTES + 32768, response_mode: "json" },\n''',
)

append_once("docs/adr/0007-external-agents-and-cloudflare-evolution.md",
    "## 12. Owner-authorized FIRST_READY dispatch",
    r'''
## 12. Owner-authorized FIRST_READY dispatch

Migration 0094 adds a separate immutable selection intent before exact dispatch creation. The owner may
submit project, exact expected route revision, transport, target grant revision, expiry and explicit v2
Research request without naming Spark, Muse, Dot or another contour. Core consumes the existing readiness
report and records its first READY connection, priority and qualification observation. Only then does it
create the ordinary exact dispatch for that actor.

The caller idempotency key binds the selection request, while a reserved digest-derived internal key binds
the exact dispatch. Selection is recorded before dispatch creation, so a retry after any lost acknowledgement
reuses the same selected connection and cannot jump to a newly preferred contour. Ordinary explicit dispatch
creation rejects the reserved internal-key namespace. This is owner-authorized target selection, not failover:
decline, abandonment and terminal reassignment remain separate actions, and no accepted offer, task, lease,
credential or Research run moves between actors.
''')

append_once("docs/implementation/computer-agent-web-inbox.md",
    "## Owner-authorized FIRST_READY creation",
    r'''
## Owner-authorized FIRST_READY creation

An owner can create a new offer without manually copying the preferred connection from readiness:

```text
POST /api/v1/research/projects/<project>/computer-agent-dispatches/preferred
Idempotency-Key: <stable owner action key>

{
  "transport": "WEB_INBOX",
  "expected_route_revision": 4,
  "client_grant_id": "<exact target grant>",
  "client_grant_revision": 2,
  "expires_in_seconds": 900,
  "run_request": { "...": "explicit v2 PROJECT Research request" }
}
```

Core records an immutable FIRST_READY selection before creating the ordinary exact dispatch. Repeating the
same owner key/body returns that selection and dispatch even if readiness ordering later changes. A different
body under the same key conflicts. This endpoint does not reassign a declined/abandoned offer and never moves
an accepted dispatch or task lease; use the explicit reassignment endpoint for terminal offers.
''')

append_once("docs/implementation/muse-operator-runbook.md",
    "### Owner-selected FIRST_READY offer",
    r'''
### Owner-selected FIRST_READY offer

The owner may call the preferred-dispatch endpoint after inspecting route readiness. The endpoint chooses and
immutably records the first READY Spark, Muse, Dot or other route entry, then creates the normal exact offer.
The agent still pulls and accepts under its own Access actor and exact project grant. Retry the same owner key
and body after an uncertain response; selection cannot silently switch to another contour. Decline/abandon
continues through explicit reassignment rather than automatic failover.
''')
