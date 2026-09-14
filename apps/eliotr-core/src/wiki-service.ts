import {
  IdentifierSchema,
  VersionedRefSchema,
  WikiPageRevisionSchema,
  type VersionedRef,
  type WikiPageRevision,
} from "@eliotr/contracts";
import type {
  AuthenticatedRequestContext,
  SemanticApi,
  WikiProposalListResult,
  WikiProposalReadResult,
  WikiProposalSummary,
} from "@eliotr/interfaces";
import {
  canonicalEvidenceJson,
} from "@eliotr/cloudflare-evidence";
import {
  createWikiPublisher,
  WikiPublicationError,
  type DraftRiskClass,
  type WikiHeadCommit,
} from "@eliotr/research";
import { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";
import { prepareWikiProposalReadAuthorization } from "./wiki-proposal-reauthorization.js";
import { admitWikiOwnerReview } from "./wiki-review-admission.js";
import { createD1R2WikiPublicationPort } from "./wiki-publication-store.js";
import type { WikiOwnerPublicationGuardWitness } from "./wiki-owner-publication-guard.js";
import {
  MAX_BODY_BYTES,
  MAX_EVIDENCE_MAP_BYTES,
  decodeProposal,
  dependencyDigest,
  loadProposalRow,
  loadProposalRows,
  pageJson,
  readObject,
  textDigest,
  type ProposalRow,
} from "./wiki-publication-store-support.js";

const RISK_CLASSES = new Set<DraftRiskClass>([
  "D0_MECHANICAL",
  "D1_LOW_RISK_ADDITIVE",
  "D2_ANALYTICAL",
  "D3_AUTHORITY_SENSITIVE",
]);

export const WIKI_PROPOSAL_PROTOCOL = "eliotr.wiki-proposal.v1";
export const WIKI_PUBLICATION_PROTOCOL = "eliotr.wiki-publication.v1";
export const WIKI_PROPOSAL_READ_PROTOCOL = "eliotr.wiki-proposal-read.v1";
export const WIKI_PROPOSAL_LIST_PROTOCOL = "eliotr.wiki-proposals.v1";
const MAX_WIKI_PROPOSALS = 20;

export interface WikiProposalResult {
  readonly protocol: typeof WIKI_PROPOSAL_PROTOCOL;
  readonly proposal_ref: VersionedRef;
  readonly page_ref: VersionedRef;
  readonly risk_class: DraftRiskClass;
  readonly state: "PROPOSED";
}

export interface WikiPublicationResult {
  readonly protocol: typeof WIKI_PUBLICATION_PROTOCOL;
  readonly page_ref: VersionedRef;
  readonly status: "PUBLISHED";
  readonly reviewer_ref: string;
}

function fail(code: string, message: string, status = 400, retryable = false): never {
  throw new CatalogInputError(code, message, status, retryable);
}

function requireOwner(context: AuthenticatedRequestContext): void {
  if (context.client_class !== "owner_pwa") fail("WIKI_OWNER_REQUIRED", "Wiki access requires the owner profile", 403);
}

function guardFailure(message: string, cause?: unknown): never {
  throw new WikiPublicationError("WIKI_SETTLEMENT_UNCERTAIN", message, true, cause);
}

function guardText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) guardFailure(`${label} is unavailable`);
  return value;
}

function guardInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) guardFailure(`${label} is unavailable`);
  return value as number;
}

/** Build the server-owned witness immediately before the publication batch. */
async function readWikiOwnerPublicationGuardWitness(
  env: Env,
  context: AuthenticatedRequestContext,
  input: WikiHeadCommit & { readonly page_sha256: string },
): Promise<WikiOwnerPublicationGuardWitness> {
  requireOwner(context);
  let authorization: Awaited<ReturnType<typeof prepareWikiProposalReadAuthorization>>;
  try {
    authorization = await prepareWikiProposalReadAuthorization(env, context, input.page);
  } catch (cause) {
    guardFailure("Wiki owner publication authorization is unavailable", cause);
  }
  const policyAuthorityRef = authorization.authorization.policy_authority_ref;
  let policy: { readonly policy_generation: unknown; readonly state: unknown } | null;
  let deployment: { readonly deployment_generation: unknown; readonly state: unknown } | null;
  let orientation: { readonly generation: unknown } | null;
  let ledger: { readonly generation: unknown } | null;
  let purge: { readonly revision: unknown } | null;
  try {
    [policy, deployment, orientation, ledger, purge] = await Promise.all([
      env.CORE_DB.prepare(
        "SELECT policy_generation,state FROM investigation_current_policy " +
        "WHERE policy_authority_ref=?1 AND state='ACTIVE' LIMIT 1",
      ).bind(policyAuthorityRef).first<{ readonly policy_generation: unknown; readonly state: unknown }>(),
      env.CORE_DB.prepare(
        "SELECT deployment_generation,state FROM investigation_current_deployment " +
        "WHERE deployment_generation=?1 AND state='ACTIVE' LIMIT 1",
      ).bind(env.DEPLOYMENT_GENERATION).first<{ readonly deployment_generation: unknown; readonly state: unknown }>(),
      env.CORE_DB.prepare("SELECT generation FROM orientation_authority_epoch WHERE singleton=1 LIMIT 1")
        .first<{ readonly generation: unknown }>(),
      env.CORE_DB.prepare("SELECT generation FROM investigation_ledger_epoch WHERE singleton=1 LIMIT 1")
        .first<{ readonly generation: unknown }>(),
      env.CORE_DB.prepare("SELECT COALESCE(MAX(ledger_revision),0) AS revision FROM purge_ledger")
        .first<{ readonly revision: unknown }>(),
    ]);
  } catch (cause) {
    guardFailure("Wiki publication current authority read is unavailable", cause);
  }
  if (policy === null || policy.state !== "ACTIVE" || deployment === null || deployment.state !== "ACTIVE") {
    throw new WikiPublicationError("WIKI_POLICY_DENIED", "Wiki publication policy or deployment is not current");
  }
  const policyGeneration = guardText(policy.policy_generation, "current policy generation");
  const deploymentGeneration = guardText(deployment.deployment_generation, "current deployment generation");
  const globalPurgeRevision = guardInteger(purge?.revision, "global purge revision");
  const orientationEpoch = guardInteger(orientation?.generation, "orientation epoch", 1);
  const ledgerEpoch = guardInteger(ledger?.generation, "ledger epoch", 1);
  const scope = authorization.navigation.scope;
  const sourceRefs = [...scope.member_source_revision_refs].sort();
  const sourceOwners: Record<string, string> = {};
  for (const sourceRef of sourceRefs) {
    const generation = scope.source_owner_generations[sourceRef];
    if (typeof generation !== "string" || generation.length < 1) guardFailure("Wiki source ownership is unavailable");
    sourceOwners[sourceRef] = generation;
  }
  try {
    await authorization.requireCurrent();
  } catch (cause) {
    throw new WikiPublicationError("WIKI_POLICY_DENIED", "Wiki owner publication authority is no longer current", false, cause);
  }
  const observedAt = authorization.navigation.timestamp();
  const scopeExpiry = Date.parse(scope.expires_at);
  const grantExpiry = Date.parse(authorization.authorization.expires_at);
  const observedMs = Date.parse(observedAt);
  if (![scopeExpiry, grantExpiry, observedMs].every(Number.isSafeInteger) || Math.min(scopeExpiry, grantExpiry) <= observedMs) {
    throw new WikiPublicationError("WIKI_POLICY_DENIED", "Wiki owner publication authorization has expired");
  }
  const guardId = `wiki-guard-${(await textDigest(canonicalEvidenceJson({
    proposal_ref: input.proposal_ref,
    page_ref: input.page.page_ref,
    expected_head_revision: input.expected_head_revision,
    manifest_ref: input.manifest_ref,
    page_sha256: input.page_sha256,
    principal_ref: context.principal_ref,
  }))).slice(0, 48)}`;
  return {
    guard_id: guardId,
    page_id: input.page.page_ref.id,
    page_revision: input.page.page_ref.revision,
    proposal_id: input.proposal_ref.id,
    proposal_revision: input.proposal_ref.revision,
    expected_head_revision: input.expected_head_revision,
    manifest_ref: input.manifest_ref,
    page_sha256: input.page_sha256,
    body_object_ref: input.page.body_object_ref,
    body_sha256: input.page.body_sha256,
    committer_ref: input.committer_ref,
    principal_ref: context.principal_ref,
    client_class: "owner_pwa",
    credential_generation: context.credential_generation,
    authorization_receipt_ref: authorization.authorization.authorization_receipt_ref,
    scope_snapshot_id: scope.snapshot_id,
    scope_snapshot_revision: scope.revision,
    scope_snapshot_digest: scope.digest,
    policy_generation: policyGeneration,
    policy_authority_ref: policyAuthorityRef,
    deployment_generation: deploymentGeneration,
    global_purge_revision: globalPurgeRevision,
    scope_purge_revision: scope.purge_ledger_revision,
    orientation_epoch: orientationEpoch,
    ledger_epoch: ledgerEpoch,
    source_revision_refs_json: canonicalEvidenceJson(sourceRefs),
    source_owner_generations_json: canonicalEvidenceJson(sourceOwners),
    allowed_use_json: canonicalEvidenceJson([...new Set(authorization.authorization.allowed_use)].sort()),
    disclosure_ceiling: authorization.authorization.disclosure_ceiling,
    scope_expires_at: scope.expires_at,
    grant_expires_at: authorization.authorization.expires_at,
    observed_at: observedAt,
    expires_at: new Date(Math.min(scopeExpiry, grantExpiry)).toISOString(),
  };
}

export function parseWikiProposalRef(value: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse({ id: value, revision: 1 });
  if (!parsed.success) fail("WIKI_INPUT_INVALID", "Wiki proposal reference is invalid");
  return parsed.data;
}

function idempotencyKey(context: AuthenticatedRequestContext): string {
  const value = context.request.headers.get("idempotency-key");
  if (value === null || value.length < 1 || value.length > 256 || /[\u0000-\u0020\u007f]/u.test(value)) {
    fail("WIKI_INPUT_INVALID", "idempotency-key header is required");
  }
  return value;
}

export function requireWikiIdempotencyKey(context: AuthenticatedRequestContext): string {
  return idempotencyKey(context);
}

function strictRecord(raw: unknown, expected: readonly string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("WIKI_INPUT_INVALID", "Wiki request must be an object");
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) {
    fail("WIKI_INPUT_INVALID", "Wiki request has unknown or missing fields");
  }
  return record;
}

export function parseWikiProposalFromResearchRunRequest(raw: unknown): string {
  const record = strictRecord(raw, ["operation_id"]);
  const operationId = IdentifierSchema.safeParse(record.operation_id);
  if (!operationId.success) fail("WIKI_INPUT_INVALID", "research operation_id is invalid");
  return operationId.data;
}

function proposalInput(raw: unknown): { page: WikiPageRevision; risk_class: DraftRiskClass } {
  const record = strictRecord(raw, ["page", "risk_class"]);
  const page = WikiPageRevisionSchema.safeParse(record.page);
  if (!page.success || page.data.status !== "DRAFT") fail("WIKI_INPUT_INVALID", "Wiki proposal must contain one strict DRAFT page");
  if (typeof record.risk_class !== "string" || !RISK_CLASSES.has(record.risk_class as DraftRiskClass)) {
    fail("WIKI_INPUT_INVALID", "Wiki risk class is invalid");
  }
  return { page: page.data, risk_class: record.risk_class as DraftRiskClass };
}

function publicationInput(raw: unknown): { proposal_ref: VersionedRef; expected_head_revision: number } {
  const record = strictRecord(raw, ["proposal_ref", "expected_head_revision"]);
  const proposal = VersionedRefSchema.safeParse(record.proposal_ref);
  if (!proposal.success || proposal.data.revision !== 1) fail("WIKI_INPUT_INVALID", "Wiki proposal reference is invalid");
  if (!Number.isSafeInteger(record.expected_head_revision) || (record.expected_head_revision as number) < 0) {
    fail("WIKI_INPUT_INVALID", "expected Wiki head revision is invalid");
  }
  return { proposal_ref: proposal.data, expected_head_revision: record.expected_head_revision as number };
}

function mapWiki(error: unknown): never {
  if (!(error instanceof WikiPublicationError)) throw error;
  const status = error.code === "WIKI_INPUT_INVALID" ? 400
    : error.code === "WIKI_PROPOSAL_NOT_FOUND" ? 404
      : error.code === "WIKI_POLICY_DENIED" ? 403
        : error.code === "WIKI_HEAD_CONFLICT" || error.code === "WIKI_PROPOSAL_READBACK_MISMATCH"
          || error.code === "WIKI_IMMUTABLE_READBACK_MISMATCH" ? 409
          : error.code === "WIKI_PUBLICATION_INCOMPLETE" ? 422 : 503;
  fail(error.code, error.message, status, error.retryable || status === 503);
}

async function propose(
  env: Pick<Env, "CORE_DB" | "WORK_BUCKET">,
  context: AuthenticatedRequestContext,
  raw: unknown,
): Promise<WikiProposalResult> {
  requireOwner(context);
  const input = proposalInput(raw);
  const port = createD1R2WikiPublicationPort(env.CORE_DB, env.WORK_BUCKET, {
    principal_ref: context.principal_ref,
    idempotency_key: idempotencyKey(context),
  });
  try {
    const proposalRef = await createWikiPublisher(port).propose(input.page, input.risk_class);
    return {
      protocol: WIKI_PROPOSAL_PROTOCOL,
      proposal_ref: proposalRef,
      page_ref: { ...input.page.page_ref },
      risk_class: input.risk_class,
      state: "PROPOSED",
    };
  } catch (error) { mapWiki(error); }
}

interface CheckedProposal {
  readonly row: ProposalRow;
  readonly proposal: ReturnType<typeof decodeProposal>;
  readonly requireCurrent: () => Promise<void>;
  readonly body?: Uint8Array;
}

async function checkedProposal(
  env: Pick<Env, "CORE_DB" | "WORK_BUCKET">,
  context: AuthenticatedRequestContext,
  proposalRef: VersionedRef,
  verifyObjects: boolean,
): Promise<CheckedProposal> {
  requireOwner(context);
  const row = await loadProposalRow(env.CORE_DB, proposalRef, context.principal_ref);
  if (row === null) fail("WIKI_PROPOSAL_NOT_FOUND", "Wiki proposal does not exist", 404);
  const proposal = decodeProposal(row);
  if (await textDigest(pageJson(proposal.page)) !== row.page_sha256 ||
      await dependencyDigest(proposal.page) !== row.dependency_refs_sha256) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki proposal digest is corrupt", 409);
  }
  const authorization = await prepareWikiProposalReadAuthorization(env, context, proposal.page);
  if (!verifyObjects) return { row, proposal, requireCurrent: authorization.requireCurrent };
  const body = await readObject(env.WORK_BUCKET, proposal.page.body_object_ref, MAX_BODY_BYTES);
  const evidence = await readObject(env.WORK_BUCKET, proposal.page.evidence_map_ref, MAX_EVIDENCE_MAP_BYTES);
  if (body.sha256 !== proposal.page.body_sha256 || body.bytes.byteLength !== row.body_size ||
      evidence.sha256 !== row.evidence_map_sha256 || evidence.bytes.byteLength !== row.evidence_map_size) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki proposal object readback differs from its durable identity", 409);
  }
  await authorization.requireCurrent();
  return { row, proposal, requireCurrent: authorization.requireCurrent, body: body.bytes };
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isExpectedStaleRead(error: unknown): boolean {
  const code = errorCode(error);
  return code === "WIKI_POLICY_DENIED" || code === "SCOPE_SNAPSHOT_STALE" ||
    code === "NAVIGATION_SCOPE_NOT_CURRENT" || code === "NAVIGATION_SCOPE_MISMATCH" ||
    code === "EVIDENCE_SCOPE_INVALIDATED" || code === "EVIDENCE_SCOPE_EXPIRED" ||
    code === "EVIDENCE_AUTHORIZATION_DENIED" || code === "EVIDENCE_SOURCE_NOT_LIVE" ||
    code === "EVIDENCE_OWNER_GENERATION_MISMATCH" || code === "EVIDENCE_SCOPE_MISMATCH";
}

async function readProposal(
  env: Pick<Env, "CORE_DB" | "WORK_BUCKET">,
  context: AuthenticatedRequestContext,
  proposalRef: VersionedRef,
): Promise<WikiProposalReadResult> {
  try {
    const checked = await checkedProposal(env, context, proposalRef, true);
    return {
      protocol: WIKI_PROPOSAL_READ_PROTOCOL,
      proposal_ref: checked.proposal.proposal_ref,
      page: checked.proposal.page,
      risk_class: checked.proposal.risk_class,
      state: checked.row.state as "PROPOSED" | "PUBLISHED",
    };
  } catch (error) { mapWiki(error); }
}

async function listProposals(
  env: Pick<Env, "CORE_DB" | "WORK_BUCKET">,
  context: AuthenticatedRequestContext,
): Promise<WikiProposalListResult> {
  try {
    requireOwner(context);
    const rows = await loadProposalRows(env.CORE_DB, context.principal_ref, MAX_WIKI_PROPOSALS);
    const items: WikiProposalSummary[] = [];
    const currentChecks: Array<() => Promise<void>> = [];
    for (const row of rows.slice(0, MAX_WIKI_PROPOSALS)) {
      let checked: CheckedProposal;
      try {
        checked = await checkedProposal(env, context, { id: row.proposal_id, revision: row.proposal_revision }, false);
      } catch (error) {
        if (isExpectedStaleRead(error)) continue;
        throw error;
      }
      if (typeof row.created_at !== "string" || Number.isNaN(Date.parse(row.created_at)) || !row.created_at.endsWith("Z")) {
        fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki proposal creation time is malformed", 409);
      }
      currentChecks.push(checked.requireCurrent);
      items.push({
        proposal_ref: checked.proposal.proposal_ref,
        page_ref: { ...checked.proposal.page.page_ref },
        title: checked.proposal.page.title,
        page_type: checked.proposal.page.page_type,
        risk_class: checked.proposal.risk_class,
        state: checked.row.state as "PROPOSED" | "PUBLISHED",
        created_at: row.created_at,
      });
    }
    for (const requireCurrent of currentChecks) {
      try {
        await requireCurrent();
      } catch (error) {
        if (isExpectedStaleRead(error)) {
          fail("WIKI_POLICY_DENIED", "Wiki proposal list changed during read", 410);
        }
        throw error;
      }
    }
    return { protocol: WIKI_PROPOSAL_LIST_PROTOCOL, items, has_more: rows.length > MAX_WIKI_PROPOSALS };
  } catch (error) { mapWiki(error); }
}

async function readProposalBody(
  env: Pick<Env, "CORE_DB" | "WORK_BUCKET">,
  context: AuthenticatedRequestContext,
  proposalRef: VersionedRef,
): Promise<Response> {
  try {
    const checked = await checkedProposal(env, context, proposalRef, true);
    if (checked.body === undefined) fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki proposal body is unavailable", 409);
    const buffer = new ArrayBuffer(checked.body.byteLength);
    new Uint8Array(buffer).set(checked.body);
    const encodedProposal = encodeURIComponent(`${checked.proposal.proposal_ref.id}:${checked.proposal.proposal_ref.revision}`);
    const encodedPage = encodeURIComponent(`${checked.proposal.page.page_ref.id}:${checked.proposal.page.page_ref.revision}`);
    return new Response(buffer, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-length": String(checked.body.byteLength),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-eliotr-wiki-proposal-ref": encodedProposal,
        "x-eliotr-wiki-page-ref": encodedPage,
        "x-eliotr-body-sha256": checked.proposal.page.body_sha256,
      },
    });
  } catch (error) { mapWiki(error); }
}

export function createWikiProposalReaderService(
  env: Pick<Env, "CORE_DB" | "WORK_BUCKET">,
): Pick<SemanticApi, "readWikiProposal" | "listWikiProposals" | "readWikiProposalBody"> {
  return {
    readWikiProposal: (context, proposalRef) => readProposal(env, context, proposalRef),
    listWikiProposals: (context) => listProposals(env, context),
    readWikiProposalBody: (context, proposalRef) => readProposalBody(env, context, proposalRef),
  };
}

export function createWikiProposalService(
  env: Pick<Env, "CORE_DB" | "WORK_BUCKET">,
): SemanticApi["proposeWiki"] {
  return (context: AuthenticatedRequestContext, raw: unknown) => propose(env, context, raw);
}

/** Owner/manual review path; from-run proposals receive server-derived admission before publication. */
export async function publishWikiProposal(
  env: Env,
  context: AuthenticatedRequestContext,
  raw: unknown,
): Promise<WikiPublicationResult> {
  requireOwner(context);
  const input = publicationInput(raw);
  const port = createD1R2WikiPublicationPort(env.CORE_DB, env.WORK_BUCKET, {
    principal_ref: context.principal_ref,
    idempotency_key: idempotencyKey(context),
    read_owner_publication_guard_witness: (commit) => readWikiOwnerPublicationGuardWitness(env, context, commit),
  });
  try {
    await admitWikiOwnerReview(env, context, input.proposal_ref);
    const page = await createWikiPublisher(port).publish(
      input.proposal_ref,
      input.expected_head_revision,
      context.principal_ref,
    );
    return {
      protocol: WIKI_PUBLICATION_PROTOCOL,
      page_ref: { ...page.page_ref },
      status: "PUBLISHED",
      reviewer_ref: context.principal_ref,
    };
  } catch (error) { mapWiki(error); }
}
