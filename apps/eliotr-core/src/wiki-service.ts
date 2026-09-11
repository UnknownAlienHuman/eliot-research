import {
  VersionedRefSchema,
  WikiPageRevisionSchema,
  type VersionedRef,
  type WikiPageRevision,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext, SemanticApi } from "@eliotr/interfaces";
import {
  createWikiPublisher,
  WikiPublicationError,
  type DraftRiskClass,
} from "@eliotr/research";
import { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";
import { createD1R2WikiPublicationPort } from "./wiki-publication-store.js";

const RISK_CLASSES = new Set<DraftRiskClass>([
  "D0_MECHANICAL",
  "D1_LOW_RISK_ADDITIVE",
  "D2_ANALYTICAL",
  "D3_AUTHORITY_SENSITIVE",
]);

export const WIKI_PROPOSAL_PROTOCOL = "eliotr.wiki-proposal.v1";
export const WIKI_PUBLICATION_PROTOCOL = "eliotr.wiki-publication.v1";

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
  if (context.client_class !== "owner_pwa") fail("WIKI_OWNER_REQUIRED", "Wiki mutation requires the owner profile", 403);
}

function idempotencyKey(context: AuthenticatedRequestContext): string {
  const value = context.request.headers.get("idempotency-key");
  if (value === null || value.length < 1 || value.length > 256 || /[\u0000-\u0020\u007f]/u.test(value)) {
    fail("WIKI_INPUT_INVALID", "idempotency-key header is required");
  }
  return value;
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

export function createWikiProposalService(
  env: Pick<Env, "CORE_DB" | "WORK_BUCKET">,
): SemanticApi["proposeWiki"] {
  return (context: AuthenticatedRequestContext, raw: unknown) => propose(env, context, raw);
}

/** Server-side/manual review path; no public route is added until review receipt admission is composed. */
export async function publishWikiProposal(
  env: Pick<Env, "CORE_DB" | "WORK_BUCKET">,
  context: AuthenticatedRequestContext,
  raw: unknown,
): Promise<WikiPublicationResult> {
  requireOwner(context);
  const input = publicationInput(raw);
  const port = createD1R2WikiPublicationPort(env.CORE_DB, env.WORK_BUCKET, {
    principal_ref: context.principal_ref,
    idempotency_key: idempotencyKey(context),
  });
  try {
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
