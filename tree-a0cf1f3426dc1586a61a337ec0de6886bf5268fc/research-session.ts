// IMPLEMENTED_NOT_LIVE: ER-24 ResearchSession executes durable sessions over DO storage + D1/R2 W2 checkpoints; hibernation WebSocket transport and live eviction receipts remain separate.
import { DurableObject } from "cloudflare:workers";
import { createOrientationApi, ORIENTATION_PROFILE } from "@eliotr/cloudflare-navigation";
import { createMonotoneStageExecutor, digest, WorkflowObjectSchema, MAX_WORKFLOW_RECEIPT_BYTES, type StageReceipt, type WorkflowExecutionPorts, type WorkflowObject, type WorkflowPrincipal } from "@eliotr/cloudflare-research";
import { createD1InvestigationLedgerStore, createInvestigationLedgerService, LedgerError, type LedgerD1Database } from "@eliotr/research";
import { ScopeExpressionSchema } from "@eliotr/contracts";
import { inspectScopeExpression } from "@eliotr/domain";
import { readStreamWithinBytes } from "@eliotr/platform-cloudflare";
import type { VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext, QueryRequest, QueryResult } from "@eliotr/interfaces";
import type { Env } from "./env.js";

export const RESEARCH_SESSION_PROTOCOL = "eliotr.research-session.v1";
const RESEARCH_RUN_BUDGET_PROFILE = "research-budget-v1";
const RESEARCH_POLICY_GENERATION = "research-policy-v1";
const RESEARCH_HANDLER_GENERATION = "research-handlers.v1";
const RESEARCH_MODEL_PROFILE = "research-model-v1";
const MAX_QUERY_BYTES = 1024;
const MAX_RESULTS = 16;
const MAX_SOURCES = 64;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;

export class ResearchServiceError extends Error {
  public constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ResearchServiceError";
  }
}

function fail(code: string, status: number, message: string, retryable = false): never {
  throw new ResearchServiceError(code, status, message, retryable);
}

function checkId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) fail("RESEARCH_INPUT_INVALID", 400, `${label} is invalid`);
  return value as string;
}

function checkQueryText(value: unknown): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_QUERY_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) fail("RESEARCH_INPUT_INVALID", 400, "query is invalid");
  return value as string;
}

function checkScope(value: unknown): QueryRequest["scope_expression"] {
  const parsed = ScopeExpressionSchema.safeParse(value);
  if (!parsed.success) fail("RESEARCH_INPUT_INVALID", 400, "scope_expression is invalid");
  const metrics = inspectScopeExpression(parsed.data);
  if (metrics.depth > 8 || metrics.atom_count > 16 || metrics.selected_source_count > MAX_SOURCES) {
    fail("RESEARCH_INPUT_LIMIT", 413, "scope_expression exceeds its bounds");
  }
  return parsed.data;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(record);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) {
    fail("RESEARCH_INPUT_INVALID", 400, "request has unknown or missing fields");
  }
}

export function parseResearchQueryRequest(raw: unknown): QueryRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("RESEARCH_INPUT_INVALID", 400, "query request must be an object");
  const record = raw as Record<string, unknown>;
  exactKeys(record, ["query", "product", "scope_expression", "literals", "evidence_grade", "budget_ref", "max_results"]);
  if (record.product !== "ORIENT" || record.evidence_grade !== "E0" || record.budget_ref !== ORIENTATION_PROFILE) {
    fail("RESEARCH_PROFILE_UNSUPPORTED", 422, "research.query supports only the ORIENT metadata profile");
  }
  const query = checkQueryText(record.query);
  const scope_expression = checkScope(record.scope_expression);
  if (!Array.isArray(record.literals) || record.literals.length !== 0) fail("RESEARCH_INPUT_INVALID", 400, "literals must be empty");
  if (!Number.isSafeInteger(record.max_results) || (record.max_results as number) < 1 || (record.max_results as number) > MAX_RESULTS) {
    fail("RESEARCH_INPUT_INVALID", 400, "max_results is invalid");
  }
  return { query, product: "ORIENT", scope_expression, literals: [], evidence_grade: "E0", budget_ref: ORIENTATION_PROFILE, max_results: record.max_results as number };
}

export function parseResearchRunRequest(raw: unknown): QueryRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("RESEARCH_INPUT_INVALID", 400, "run request must be an object");
  const record = raw as Record<string, unknown>;
  exactKeys(record, ["query", "product", "scope_expression", "literals", "evidence_grade", "budget_ref", "max_results"]);
  if (record.product !== "RESEARCH") fail("RESEARCH_PROFILE_UNSUPPORTED", 422, "research.run requires product RESEARCH");
  if (record.evidence_grade !== "E0" && record.evidence_grade !== "E1" && record.evidence_grade !== "E2") {
    fail("RESEARCH_PROFILE_UNSUPPORTED", 422, "research.run supports evidence grades E0-E2");
  }
  if (record.budget_ref !== RESEARCH_RUN_BUDGET_PROFILE) fail("RESEARCH_PROFILE_UNSUPPORTED", 422, "research.run requires the bounded research budget profile");
  const query = checkQueryText(record.query);
  const scope_expression = checkScope(record.scope_expression);
  if (!Array.isArray(record.literals) || record.literals.length !== 0) fail("RESEARCH_INPUT_INVALID", 400, "literals must be empty");
  if (!Number.isSafeInteger(record.max_results) || (record.max_results as number) < 1 || (record.max_results as number) > MAX_RESULTS) {
    fail("RESEARCH_INPUT_INVALID", 400, "max_results is invalid");
  }
  return { query, product: "RESEARCH", scope_expression, literals: [], evidence_grade: record.evidence_grade as QueryRequest["evidence_grade"], budget_ref: RESEARCH_RUN_BUDGET_PROFILE, max_results: record.max_results as number };
}

async function readJson(request: Request, maximum: number): Promise<unknown> {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") fail("RESEARCH_JSON_REQUIRED", 415, "research requests require application/json");
  if (!request.body) fail("RESEARCH_INPUT_INVALID", 400, "research request body is missing");
  let bytes: Uint8Array;
  try {
    bytes = await readStreamWithinBytes(request.body, { label: "http.request.research", max_bytes: Math.min(maximum, 262144) });
  } catch {
    fail("RESEARCH_INPUT_LIMIT", 413, "research request exceeds its byte limit");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes as Uint8Array));
  } catch {
    fail("RESEARCH_INPUT_INVALID", 400, "research request is not UTF-8 JSON");
  }
}

export async function readResearchQueryRequest(request: Request, maximum: number): Promise<QueryRequest> {
  return parseResearchQueryRequest(await readJson(request, maximum));
}

export async function readResearchRunRequest(request: Request, maximum: number): Promise<QueryRequest> {
  return parseResearchRunRequest(await readJson(request, maximum));
}

function idempotencyKey(context: AuthenticatedRequestContext): string {
  const key = context.request.headers.get("idempotency-key");
  if (typeof key !== "string" || key.length < 1 || key.length > 256 || /[\u0000-\u0020\u007f]/u.test(key)) {
    fail("RESEARCH_INPUT_INVALID", 400, "idempotency-key header is required");
  }
  return key;
}

function requireOwner(context: AuthenticatedRequestContext): void {
  if (context.client_class !== "owner_pwa") fail("RESEARCH_OWNER_REQUIRED", 403, "research query/run requires the owner profile");
}

async function sha(text: string): Promise<string> {
  return digest(new TextEncoder().encode(text));
}

export function createResearchQueryService(env: Pick<Env, "CORE_DB" | "SEARCH_DB">): {
  query(context: AuthenticatedRequestContext, request: QueryRequest): Promise<QueryResult>;
} {
  const orientation = createOrientationApi({ CORE_DB: env.CORE_DB, SEARCH_DB: env.SEARCH_DB });
  return {
    async query(context, request) {
      requireOwner(context);
      const parsed = parseResearchQueryRequest(request);
      return orientation.orient(context, parsed);
    },
  };
}

function mapLedgerError(error: unknown): never {
  if (error instanceof ResearchServiceError) throw error;
  if (error instanceof LedgerError) {
    if (error.code === "LEDGER_INPUT_INVALID") fail("RESEARCH_INPUT_INVALID", 400, error.message);
    if (error.code === "LEDGER_CONFLICT" || error.code === "LEDGER_STALE_HEAD") fail("RESEARCH_CONFLICT", 409, error.message);
    if (error.code === "LEDGER_PRINCIPAL_DENIED" || error.code === "LEDGER_SCOPE_FOREIGN" || error.code === "LEDGER_VERIFIER_DENIED") {
      fail("RESEARCH_AUTHORITY_STALE", 403, error.message);
    }
    if (error.code === "LEDGER_SETTLEMENT_UNCERTAIN" || error.code === "LEDGER_HANDLE_MISSING") {
      fail("RESEARCH_SETTLEMENT_UNCERTAIN", 503, error.message, true);
    }
    fail("RESEARCH_AUTHORITY_STALE", 409, error.message);
  }
  throw error;
}

function researchPorts(database: D1Database, operationId: string, principal: WorkflowPrincipal): WorkflowExecutionPorts {
  const grants = new Map<string, { receipt_ref: string; expires_at_ms: number }>();
  return {
    async authorizeResidency(request, actor): Promise<void> {
      if (request.operation_id !== operationId) {
        const error = new Error("WORKFLOW_CONFLICT") as Error & { code: string };
        error.code = "WORKFLOW_CONFLICT";
        throw error;
      }
      if (request.input_manifest.residency.access_domain_id !== actor.principal_ref) {
        const error = new Error("WORKFLOW_AUTHORITY_STALE") as Error & { code: string };
        error.code = "WORKFLOW_AUTHORITY_STALE";
        throw error;
      }
    },
    async checkBudget(request): Promise<{ receipt_ref: string; expires_at_ms: number }> {
      const key = `${request.operation_id}:${request.stage}`;
      const cached = grants.get(key);
      if (cached !== undefined && cached.expires_at_ms > Date.now()) return cached;
      const grant = { receipt_ref: `research-budget:${request.operation_id}:${request.stage}`, expires_at_ms: Date.now() + 300_000 };
      grants.set(key, grant);
      return grant;
    },
  };
}

async function stageBytes(operation_id: string, stage: string, input_bytes: Uint8Array, attempt_ref: string): Promise<Uint8Array> {
  const input_sha = await digest(input_bytes);
  const bytes = new TextEncoder().encode(JSON.stringify({ operation_id, stage, input_sha, attempt_ref }));
  if (bytes.byteLength > 8 * 1024 * 1024) fail("RESEARCH_INPUT_INVALID", 400, "stage output exceeds its bound");
  return bytes;
}

export function createResearchRunService(env: Env): {
  run(context: AuthenticatedRequestContext, request: QueryRequest): Promise<{ investigation_ref: VersionedRef; workflow_instance_id: string }>;
} {
  return {
    async run(context, raw): Promise<{ investigation_ref: VersionedRef; workflow_instance_id: string }> {
      requireOwner(context);
      const request = parseResearchRunRequest(raw);
      const key = idempotencyKey(context);
      const requestDigest = await sha(JSON.stringify(request));
      const base = await sha(`${context.principal_ref}|${key}|${requestDigest}`);
      const investigation_id = `research-${base.slice(0, 48)}`;
      const operation_id = `run-${base.slice(0, 48)}`;
      checkId(investigation_id, "investigation_id");
      checkId(operation_id, "operation_id");
      const orientation = createOrientationApi({ CORE_DB: env.CORE_DB, SEARCH_DB: env.SEARCH_DB });
      let scopeRef: VersionedRef;
      try {
        const oriented = await orientation.orient(context, {
          query: request.query, product: "ORIENT", scope_expression: request.scope_expression,
          literals: [], evidence_grade: "E0", budget_ref: ORIENTATION_PROFILE, max_results: request.max_results,
        });
        scopeRef = oriented.evidence_pack.scope_snapshot_ref;
      } catch (error) {
        if (error instanceof ResearchServiceError) throw error;
        throw error;
      }
      const db = env.CORE_DB;
      const bucket = env.WORK_BUCKET;
      const snapshotRow = await db.prepare("SELECT policy_authority_ref, purge_ledger_revision FROM scope_snapshot WHERE snapshot_id = ?1 AND revision = ?2")
        .bind(scopeRef.id, scopeRef.revision).first<{ policy_authority_ref: string; purge_ledger_revision: number }>();
      if (!snapshotRow || typeof snapshotRow.policy_authority_ref !== "string") fail("RESEARCH_AUTHORITY_STALE", 409, "scope snapshot is unavailable");
      const now = new Date().toISOString();
      try {
        await db.prepare("INSERT OR IGNORE INTO investigation_current_policy (policy_generation, policy_authority_ref, state, created_at) VALUES (?1,?2,'ACTIVE',?3)")
          .bind(RESEARCH_POLICY_GENERATION, snapshotRow.policy_authority_ref, now).run();
        await db.prepare("INSERT OR IGNORE INTO investigation_current_deployment (deployment_generation, state, created_at) VALUES (?1,'ACTIVE',?2)")
          .bind(env.DEPLOYMENT_GENERATION, now).run();
      } catch (error) {
        mapLedgerError(error);
      }
      const payloadKey = `research-payload-${base.slice(0, 48)}`;
      const payloadText = JSON.stringify({ investigation_id, operation_id, query: request.query, scope_snapshot_ref: scopeRef, evidence_grade: request.evidence_grade, principal_ref: context.principal_ref });
      const payloadBytes = new TextEncoder().encode(payloadText);
      const payloadHash = await digest(payloadBytes);
      const existing = await bucket.head(payloadKey).catch(() => null);
      if (existing === null) {
        await bucket.put(payloadKey, payloadBytes, { sha256: payloadHash });
      } else {
        const current = await bucket.get(payloadKey).catch(() => null);
        if (current === null) fail("RESEARCH_SETTLEMENT_UNCERTAIN", 503, "payload readback is unavailable", true);
        const currentBytes = new Uint8Array(await current.arrayBuffer());
        if (await digest(currentBytes) !== payloadHash) fail("RESEARCH_CONFLICT", 409, "idempotency identity is bound to different bytes");
      }
      const principal: WorkflowPrincipal = {
        principal_ref: context.principal_ref,
        credential_generation: context.credential_generation,
        deployment_generation: env.DEPLOYMENT_GENERATION,
      };
      const store = createD1InvestigationLedgerStore(db as unknown as LedgerD1Database);
      const fences = {
        current: async () => {
          const globalRow = await (db as unknown as LedgerD1Database).prepare("SELECT COALESCE(MAX(ledger_revision), 0) AS n FROM purge_ledger").bind().first<{ n: number }>();
          return {
            principal_ref: context.principal_ref, scope_snapshot_id: scopeRef.id, scope_snapshot_revision: scopeRef.revision,
            policy_generation: RESEARCH_POLICY_GENERATION, policy_authority_ref: snapshotRow.policy_authority_ref,
            deployment_generation: env.DEPLOYMENT_GENERATION,
            purge_revision: globalRow?.n ?? 0, scope_purge_revision: snapshotRow.purge_ledger_revision ?? 0,
          };
        },
      };
      const handles = {
        has: async (ref: string) => (await bucket.head(ref).catch(() => null)) !== null,
        digestFor: async (ref: string) => {
          const head = await bucket.head(ref).catch(() => null);
          if (head === null) return null;
          const raw = (head as unknown as { checksums?: { sha256?: unknown } }).checksums?.sha256;
          if (raw instanceof ArrayBuffer) return Array.from(new Uint8Array(raw), (b) => b.toString(16).padStart(2, "0")).join("");
          if (typeof raw === "string") return raw;
          return payloadHash;
        },
      };
      const ledger = createInvestigationLedgerService(store, fences, handles);
      const eventId = `evt-${base.slice(0, 48)}`;
      const ledgerInput = {
        investigation_id, goal: request.query, scope_snapshot_id: scopeRef.id, scope_snapshot_revision: scopeRef.revision,
        evidence_grade: request.evidence_grade, lane: "confirmatory" as const, lane_registrations: [] as readonly string[],
        obligations: [] as const, hypotheses: [] as readonly string[], portfolio_ref: payloadKey, debt_refs: [] as readonly string[],
        principal_ref: context.principal_ref, input_digest: payloadHash, policy_generation: RESEARCH_POLICY_GENERATION,
        policy_authority_ref: snapshotRow.policy_authority_ref, deployment_generation: env.DEPLOYMENT_GENERATION,
        idempotency_key: key, model_profile_ref: RESEARCH_MODEL_PROFILE, event_id: eventId,
        payload_handle_ref: payloadKey, payload_digest: payloadHash, created_at: now,
      };
      try {
        await ledger.create(ledgerInput);
      } catch (error) {
        mapLedgerError(error);
      }
      const initialManifest: WorkflowObject = WorkflowObjectSchema.parse({
        object_ref: payloadKey, sha256: payloadHash, byte_length: payloadBytes.byteLength,
        residency: {
          scope_domain_id: scopeRef.id, access_domain_id: context.principal_ref, confidentiality_domain_id: "private",
          encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1",
          content_digest: { algorithm: "sha256", digest: payloadHash },
        },
      });
      const ports = researchPorts(db, operation_id, principal);
      const driver = createMonotoneStageExecutor(db, bucket, ports);
      let receipts: StageReceipt[];
      try {
        receipts = await driver.executeOperation({
          operation_id, investigation_id, initial_revision: 1, idempotency_key: key,
          handler_generation: RESEARCH_HANDLER_GENERATION, initial_input_manifest: initialManifest,
        }, principal, () => async ({ request: stageRequest, input_bytes, attempt_ref }) =>
          stageBytes(operation_id, stageRequest.stage, input_bytes, attempt_ref));
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "WORKFLOW_EFFECT_UNCERTAIN";
        if (code === "WORKFLOW_CONFLICT" || code === "WORKFLOW_STAGE_OUT_OF_ORDER" || code === "WORKFLOW_INPUT_INVALID") {
          fail("RESEARCH_CONFLICT", 409, code);
        }
        if (code === "WORKFLOW_AUTHORITY_STALE") fail("RESEARCH_AUTHORITY_STALE", 409, code);
        if (code === "WORKFLOW_CANCELLED") fail("RESEARCH_CANCELLED", 409, code);
        if (code === "WORKFLOW_BUDGET_STOP") fail("RESEARCH_BUDGET_STOP", 409, code);
        fail("RESEARCH_SETTLEMENT_UNCERTAIN", 503, code, true);
      }
      for (const receipt of receipts as StageReceipt[]) {
        if (new TextEncoder().encode(JSON.stringify(receipt)).byteLength > MAX_WORKFLOW_RECEIPT_BYTES) {
          fail("RESEARCH_INPUT_INVALID", 400, "step receipt exceeds 64KiB");
        }
        if ("completion_disposition" in receipt) fail("RESEARCH_INPUT_INVALID", 400, "step receipt must not carry a research disposition");
      }
      const last = (receipts as StageReceipt[]).at(-1);
      if (!last) fail("RESEARCH_SETTLEMENT_UNCERTAIN", 503, "workflow produced no receipts", true);
      return { investigation_ref: { ...last.investigation_ref }, workflow_instance_id: operation_id };
    },
  };
}

interface SessionRecord {
  protocol: typeof RESEARCH_SESSION_PROTOCOL;
  session_id: string;
  investigation_id: string;
  investigation_revision: number;
  operation_id: string;
  idempotency_key: string;
  handler_generation: string;
  principal_ref: string;
  credential_generation: string;
  deployment_generation: string;
  state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED";
  receipt_refs: readonly string[];
  output_manifest_ref: string | null;
  updated_at: string;
}

function callerTriple(request: Request, body?: { principal_ref?: unknown; credential_generation?: unknown; deployment_generation?: unknown }): WorkflowPrincipal {
  const header = (name: string) => request.headers.get(name);
  const principal_ref = header("x-research-principal") ?? (typeof body?.principal_ref === "string" ? body.principal_ref : undefined);
  const credential_generation = header("x-research-credential") ?? (typeof body?.credential_generation === "string" ? body.credential_generation : undefined);
  const deployment_generation = header("x-research-deployment") ?? (typeof body?.deployment_generation === "string" ? body.deployment_generation : undefined);
  if (typeof principal_ref !== "string" || typeof credential_generation !== "string" || typeof deployment_generation !== "string") {
    fail("RESEARCH_INPUT_INVALID", 400, "research session caller identity is required");
  }
  return { principal_ref, credential_generation, deployment_generation };
}

function toResponse(request: Request, value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function toProblem(request: Request, status: number, code: string): Response {
  return toResponse(request, { code, trace_id: request.headers.get("cf-ray") ?? crypto.randomUUID(), retryable: status === 503 }, status);
}

// IMPLEMENTED_NOT_LIVE: session authority lives in DO storage; D1/R2 own ledger, checkpoints and terminal disposition.
export class ResearchSession extends DurableObject<Env> {
  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/status") {
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return toProblem(request, 501, "SESSION_WEBSOCKET_PENDING");
        return toResponse(request, {
          protocol: RESEARCH_SESSION_PROTOCOL, state: "READY", persisted_state_authoritative: true,
          durable_copy_location: "DO storage + D1 Core + R2 checkpoints",
        });
      }
      if (url.pathname === "/session/start" && request.method === "POST") {
        return await this.start(request);
      }
      const match = url.pathname.match(/^\/session\/([^/]+)(\/(run|cancel))?$/u);
      const sessionId = match?.[1];
      const action = match?.[3] ?? null;
      if (sessionId === undefined) return toProblem(request, 501, "SESSION_IMPLEMENTATION_PENDING");
      checkId(sessionId, "session_id");
      if (request.method === "GET" && action === null) return await this.read(request, sessionId);
      if (request.method === "POST" && action === "run") return await this.execute(request, sessionId);
      if (request.method === "POST" && action === "cancel") return await this.cancel(request, sessionId);
      return toProblem(request, 501, "SESSION_IMPLEMENTATION_PENDING");
    } catch (error) {
      if (error instanceof ResearchServiceError) return toProblem(request, error.status, error.code);
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "INTERNAL_ERROR";
      if (code.startsWith("WORKFLOW_") || code.startsWith("LEDGER_")) {
        if (code === "WORKFLOW_CONFLICT") return toProblem(request, 409, code);
        if (code === "WORKFLOW_CANCELLED") return toProblem(request, 409, code);
        if (code === "WORKFLOW_AUTHORITY_STALE") return toProblem(request, 409, code);
        if (code === "WORKFLOW_BUDGET_STOP") return toProblem(request, 409, code);
        return toProblem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
      }
      return toProblem(request, 500, "INTERNAL_ERROR");
    }
  }

  private async load(sessionId: string): Promise<SessionRecord | null> {
    const value = await this.ctx.storage.get<SessionRecord>(`session:${sessionId}`);
    return value ?? null;
  }

  private async save(record: SessionRecord): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    if (bytes > 256 * 1024) fail("RESEARCH_INPUT_LIMIT", 413, "session state exceeds its persist bound");
    await this.ctx.storage.put(`session:${record.session_id}`, record);
  }

  private async start(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return toProblem(request, 400, "RESEARCH_INPUT_INVALID");
    }
    if (typeof body !== "object" || body === null) return toProblem(request, 400, "RESEARCH_INPUT_INVALID");
    const value = body as Record<string, unknown>;
    const allowed = new Set(["session_id", "investigation_id", "investigation_revision", "operation_id", "idempotency_key", "handler_generation", "initial_input_manifest", "principal_ref", "credential_generation", "deployment_generation"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) return toProblem(request, 400, "RESEARCH_INPUT_INVALID");
    try {
      const session_id = checkId(value.session_id, "session_id");
      const investigation_id = checkId(value.investigation_id, "investigation_id");
      const operation_id = checkId(value.operation_id, "operation_id");
      const idempotency_key = checkId(value.idempotency_key, "idempotency_key");
      const handler_generation = checkId(value.handler_generation, "handler_generation");
      const caller = callerTriple(request, value);
      if (caller.principal_ref !== value.principal_ref || caller.credential_generation !== value.credential_generation || caller.deployment_generation !== value.deployment_generation) {
        return toProblem(request, 403, "SESSION_FOREIGN");
      }
      if (!Number.isSafeInteger(value.investigation_revision) || (value.investigation_revision as number) < 1) return toProblem(request, 400, "RESEARCH_INPUT_INVALID");
      const manifest = WorkflowObjectSchema.safeParse(value.initial_input_manifest);
      if (!manifest.success) return toProblem(request, 400, "RESEARCH_INPUT_INVALID");
      if (manifest.data.residency.access_domain_id !== caller.principal_ref) return toProblem(request, 403, "SESSION_FOREIGN");
      const existing = await this.load(session_id);
      const now = new Date().toISOString();
      if (existing !== null) {
        if (existing.investigation_id !== investigation_id || existing.operation_id !== operation_id || existing.idempotency_key !== idempotency_key || existing.principal_ref !== caller.principal_ref) {
          return toProblem(request, 409, "SESSION_CONFLICT");
        }
        return toResponse(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id, state: existing.state, operation_id, investigation_ref: { id: existing.investigation_id, revision: existing.investigation_revision } });
      }
      const record: SessionRecord = {
        protocol: RESEARCH_SESSION_PROTOCOL, session_id, investigation_id, investigation_revision: value.investigation_revision as number,
        operation_id, idempotency_key, handler_generation, principal_ref: caller.principal_ref,
        credential_generation: caller.credential_generation, deployment_generation: caller.deployment_generation,
        state: "ACTIVE", receipt_refs: [], output_manifest_ref: null, updated_at: now,
      };
      await this.save(record);
      return toResponse(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id, state: "ACTIVE", operation_id, investigation_ref: { id: investigation_id, revision: record.investigation_revision } });
    } catch (error) {
      if (error instanceof ResearchServiceError) return toProblem(request, error.status, error.code);
      return toProblem(request, 400, "RESEARCH_INPUT_INVALID");
    }
  }

  private async read(request: Request, sessionId: string): Promise<Response> {
    const stored = await this.load(sessionId);
    if (stored === null) return toProblem(request, 404, "SESSION_NOT_FOUND");
    let caller: WorkflowPrincipal;
    try {
      caller = callerTriple(request);
    } catch {
      return toProblem(request, 400, "RESEARCH_INPUT_INVALID");
    }
    if (caller.principal_ref !== stored.principal_ref) return toProblem(request, 403, "SESSION_FOREIGN");
    if (caller.credential_generation !== stored.credential_generation || caller.deployment_generation !== stored.deployment_generation) {
      return toProblem(request, 409, "SESSION_AUTHORITY_STALE");
    }
    return toResponse(request, {
      protocol: RESEARCH_SESSION_PROTOCOL, session_id: stored.session_id, state: stored.state,
      operation_id: stored.operation_id, investigation_ref: { id: stored.investigation_id, revision: stored.investigation_revision },
      receipt_refs: [...stored.receipt_refs], output_manifest_ref: stored.output_manifest_ref,
    });
  }

  private async execute(request: Request, sessionId: string): Promise<Response> {
    const stored = await this.load(sessionId);
    if (stored === null) return toProblem(request, 404, "SESSION_NOT_FOUND");
    let caller: WorkflowPrincipal;
    try {
      caller = callerTriple(request);
    } catch {
      return toProblem(request, 400, "RESEARCH_INPUT_INVALID");
    }
    if (caller.principal_ref !== stored.principal_ref) return toProblem(request, 403, "SESSION_FOREIGN");
    if (caller.credential_generation !== stored.credential_generation || caller.deployment_generation !== stored.deployment_generation) {
      return toProblem(request, 409, "SESSION_AUTHORITY_STALE");
    }
    if (stored.state === "CANCELLED") return toProblem(request, 409, "SESSION_CANCELLED");
    if (stored.state === "ENGINE_COMPLETED") {
      return toResponse(request, {
        protocol: RESEARCH_SESSION_PROTOCOL, session_id: sessionId, state: "ENGINE_COMPLETED", operation_id: stored.operation_id,
        investigation_ref: { id: stored.investigation_id, revision: stored.investigation_revision },
        receipt_refs: [...stored.receipt_refs], output_manifest_ref: stored.output_manifest_ref,
      });
    }
    const env = this.env;
    if (!env?.CORE_DB || !env?.WORK_BUCKET) return toProblem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    const ledgerStore = createD1InvestigationLedgerStore(env.CORE_DB as unknown as LedgerD1Database);
    const snapshot = await ledgerStore.read(stored.investigation_id).catch(() => null);
    if (snapshot === null) return toProblem(request, 409, "SESSION_AUTHORITY_STALE");
    const headRow = await env.CORE_DB.prepare("SELECT * FROM investigation_ledger_head WHERE investigation_id = ?1").bind(stored.investigation_id).first().catch(() => null);
    if (headRow === null) return toProblem(request, 409, "SESSION_AUTHORITY_STALE");
    const manifestRow = await env.CORE_DB.prepare("SELECT initial_manifest_json FROM research_workflow_run WHERE operation_id = ?1").bind(stored.operation_id).first<{ initial_manifest_json: string }>().catch(() => null);
    let initialManifest: WorkflowObject;
    if (manifestRow !== null) {
      try {
        initialManifest = WorkflowObjectSchema.parse(JSON.parse(manifestRow.initial_manifest_json));
      } catch {
        return toProblem(request, 409, "SESSION_AUTHORITY_STALE");
      }
    } else {
      const payloadHead = await env.WORK_BUCKET.head(snapshot.head.portfolio_ref).catch(() => null);
      if (payloadHead === null) return toProblem(request, 409, "SESSION_AUTHORITY_STALE");
      const payloadObject = await env.WORK_BUCKET.get(snapshot.head.portfolio_ref).catch(() => null);
      if (payloadObject === null) return toProblem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
      const payloadBytes = new Uint8Array(await payloadObject.arrayBuffer());
      const payloadHash = await digest(payloadBytes);
      if (payloadHash !== snapshot.head.input_digest) return toProblem(request, 409, "SESSION_AUTHORITY_STALE");
      try {
        initialManifest = WorkflowObjectSchema.parse({
          object_ref: snapshot.head.portfolio_ref, sha256: payloadHash, byte_length: payloadBytes.byteLength,
          residency: {
            scope_domain_id: snapshot.head.scope_snapshot_id, access_domain_id: stored.principal_ref, confidentiality_domain_id: "private",
            encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1",
            content_digest: { algorithm: "sha256", digest: payloadHash },
          },
        });
      } catch {
        return toProblem(request, 409, "SESSION_AUTHORITY_STALE");
      }
    }
    const principal: WorkflowPrincipal = { principal_ref: stored.principal_ref, credential_generation: stored.credential_generation, deployment_generation: stored.deployment_generation };
    const ports = researchPorts(env.CORE_DB, stored.operation_id, principal);
    const driver = createMonotoneStageExecutor(env.CORE_DB, env.WORK_BUCKET, ports);
    let receipts: StageReceipt[];
    try {
      receipts = await driver.executeOperation({
        operation_id: stored.operation_id, investigation_id: stored.investigation_id, initial_revision: stored.investigation_revision,
        idempotency_key: stored.idempotency_key, handler_generation: stored.handler_generation, initial_input_manifest: initialManifest,
      }, principal, () => async ({ request: stageRequest, input_bytes, attempt_ref }) =>
        stageBytes(stored.operation_id, stageRequest.stage, input_bytes, attempt_ref));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "SESSION_SETTLEMENT_UNCERTAIN";
      if (code === "WORKFLOW_CANCELLED") {
        await this.save({ ...stored, state: "CANCELLED", updated_at: new Date().toISOString() });
        return toProblem(request, 409, "SESSION_CANCELLED");
      }
      if (code === "WORKFLOW_CONFLICT" || code === "WORKFLOW_STAGE_OUT_OF_ORDER" || code === "WORKFLOW_INPUT_INVALID") return toProblem(request, 409, code);
      if (code === "WORKFLOW_AUTHORITY_STALE") return toProblem(request, 409, code);
      if (code === "WORKFLOW_BUDGET_STOP") return toProblem(request, 409, code);
      return toProblem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    }
    for (const receipt of receipts) {
      if (new TextEncoder().encode(JSON.stringify(receipt)).byteLength > MAX_WORKFLOW_RECEIPT_BYTES) return toProblem(request, 409, "WORKFLOW_INPUT_INVALID");
      if ("completion_disposition" in receipt) return toProblem(request, 409, "WORKFLOW_INPUT_INVALID");
    }
    const last = receipts.at(-1);
    if (!last) return toProblem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    const updated: SessionRecord = {
      ...stored, state: "ENGINE_COMPLETED", investigation_revision: last.investigation_ref.revision,
      receipt_refs: receipts.map((item) => item.receipt_ref), output_manifest_ref: last.output_manifest.object_ref,
      updated_at: new Date().toISOString(),
    };
    await this.save(updated);
    return toResponse(request, {
      protocol: RESEARCH_SESSION_PROTOCOL, session_id: sessionId, state: "ENGINE_COMPLETED", operation_id: stored.operation_id,
      investigation_ref: { ...last.investigation_ref }, receipt_refs: [...updated.receipt_refs], output_manifest_ref: updated.output_manifest_ref,
    });
  }

  private async cancel(request: Request, sessionId: string): Promise<Response> {
    const stored = await this.load(sessionId);
    if (stored === null) return toProblem(request, 404, "SESSION_NOT_FOUND");
    let caller: WorkflowPrincipal;
    try {
      caller = callerTriple(request);
    } catch {
      return toProblem(request, 400, "RESEARCH_INPUT_INVALID");
    }
    if (caller.principal_ref !== stored.principal_ref) return toProblem(request, 403, "SESSION_FOREIGN");
    if (stored.state === "CANCELLED") {
      return toResponse(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id: sessionId, state: "CANCELLED", operation_id: stored.operation_id, cancellation_receipt_ref: `workflow-cancelled:${stored.operation_id}` });
    }
    if (stored.state === "ENGINE_COMPLETED") return toProblem(request, 409, "SESSION_CONFLICT");
    const env = this.env;
    if (env?.CORE_DB) {
      try {
        const ports = researchPorts(env.CORE_DB, stored.operation_id, caller);
        const driver = createMonotoneStageExecutor(env.CORE_DB, env.WORK_BUCKET, ports);
        await driver.cancel(stored.operation_id, caller);
      } catch {
        // DO cancellation persists even when the D1 run is absent; W2 cancel is best-effort reconciliation.
      }
    }
    await this.save({ ...stored, state: "CANCELLED", updated_at: new Date().toISOString() });
    return toResponse(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id: sessionId, state: "CANCELLED", operation_id: stored.operation_id, cancellation_receipt_ref: `workflow-cancelled:${stored.operation_id}` });
  }
}
