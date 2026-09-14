import {
  IdentifierSchema,
  VersionedRefSchema,
  WikiPageRevisionSchema,
  type VersionedRef,
  type WikiPageRevision,
} from "@eliotr/contracts";
import { ApiRequestError, requestApi } from "./api.js";

const PATH = "/api/v1/research/wiki/publications";
const PROTOCOL = "eliotr.wiki-publication.v1" as const;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const WIKI_PUBLICATION_TIMEOUT_MS = 10 * 60 * 1000;

export interface WikiPublicationView {
  readonly protocol: typeof PROTOCOL;
  readonly page_ref: VersionedRef;
  readonly status: "PUBLISHED";
  readonly reviewer_ref: string;
  readonly deployment_generation: string;
}

type JsonRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new ApiRequestError({ status: 502, code: "WIKI_RESPONSE_INVALID", message });
}

function record(value: unknown, keys: readonly string[], label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} is invalid`);
  const candidate = value as JsonRecord;
  if (Object.keys(candidate).length !== keys.length || keys.some((key) => !Object.hasOwn(candidate, key))) {
    invalid(`${label} has missing or unknown fields`);
  }
  return candidate;
}

function identifier(value: unknown, label: string): string {
  if (!IdentifierSchema.safeParse(value).success || typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function ref(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) invalid(`${label} is invalid`);
  return parsed.data;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function requestId(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new ApiRequestError({ status: 400, code: "WIKI_INPUT_INVALID", message: `${label} is invalid` });
  }
  return value;
}

/** Derive the only CAS target allowed by the loaded page's immutable lineage. */
export function expectedWikiHeadRevision(page: WikiPageRevision): number {
  const parsed = WikiPageRevisionSchema.safeParse(page);
  if (!parsed.success || parsed.data.status !== "DRAFT") invalid("Wiki proposal is not a strict DRAFT page");
  const revision = parsed.data.page_ref.revision;
  if (revision === 1) {
    if (parsed.data.supersedes_ref !== undefined) invalid("Wiki proposal revision lineage is invalid");
    return 0;
  }
  const supersedes = parsed.data.supersedes_ref;
  if (supersedes === undefined || supersedes.id !== parsed.data.page_ref.id || supersedes.revision !== revision - 1) {
    invalid("Wiki proposal revision lineage is invalid");
  }
  return supersedes.revision;
}

function decode(
  raw: unknown,
  expectedDeploymentGeneration: string,
  expectedPageRef: VersionedRef,
): WikiPublicationView {
  const envelope = record(raw, ["data", "trace_id", "deployment_generation"], "Wiki publication response");
  const trace = identifier(envelope.trace_id, "trace_id");
  if (!SAFE_TRACE_ID.test(trace)) invalid("trace_id is invalid");
  const generation = identifier(envelope.deployment_generation, "deployment_generation");
  if (generation !== expectedDeploymentGeneration) {
    throw new ApiRequestError({ status: 409, code: "WIKI_DEPLOYMENT_CHANGED", message: "The application changed; refresh Wiki proposals", retryable: true });
  }
  const data = record(envelope.data, ["protocol", "page_ref", "status", "reviewer_ref"], "Wiki publication data");
  if (data.protocol !== PROTOCOL || data.status !== "PUBLISHED") invalid("Wiki publication response is invalid");
  const pageRef = ref(data.page_ref, "page_ref");
  if (!sameRef(pageRef, expectedPageRef)) invalid("Wiki publication page identity does not match the proposal");
  return {
    protocol: PROTOCOL,
    page_ref: pageRef,
    status: "PUBLISHED",
    reviewer_ref: identifier(data.reviewer_ref, "reviewer_ref"),
    deployment_generation: generation,
  };
}

export async function publishWikiProposal(
  proposalRef: VersionedRef,
  pageRef: VersionedRef,
  expectedHeadRevision: number,
  idempotencyKey: string,
  expectedDeploymentGeneration: string,
  signal?: AbortSignal,
): Promise<WikiPublicationView> {
  const proposal = ref(proposalRef, "proposal_ref");
  if (proposal.revision !== 1) throw new ApiRequestError({ status: 400, code: "WIKI_INPUT_INVALID", message: "proposal_ref revision is unsupported" });
  const page = ref(pageRef, "page_ref");
  if (!Number.isSafeInteger(expectedHeadRevision) || expectedHeadRevision < 0 || expectedHeadRevision >= page.revision) {
    throw new ApiRequestError({ status: 400, code: "WIKI_INPUT_INVALID", message: "expected head revision is invalid" });
  }
  const generation = identifier(expectedDeploymentGeneration, "deployment generation");
  const idem = requestId(idempotencyKey, "idempotency-key");
  const raw = await requestApi(PATH, {
    method: "POST",
    body: JSON.stringify({ proposal_ref: proposal, expected_head_revision: expectedHeadRevision }),
    headers: { "content-type": "application/json", "idempotency-key": idem },
    ...(signal === undefined ? {} : { signal }),
  }, WIKI_PUBLICATION_TIMEOUT_MS);
  return decode(raw, generation, page);
}
