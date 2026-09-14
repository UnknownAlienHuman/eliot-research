import {
  IdentifierSchema,
  IsoDateTimeSchema,
  Sha256Schema,
  VersionedRefSchema,
  WikiPageRevisionSchema,
  WikiPageTypeSchema,
  type VersionedRef,
  type WikiPageRevision,
} from "@eliotr/contracts";
import { ApiRequestError, requestApi, requestApiBytes } from "./api.js";

export const MAX_WIKI_PROPOSALS = 20;
export const MAX_WIKI_BODY_BYTES = 8 * 1024 * 1024;

export type WikiProposalRiskClass =
  | "D0_MECHANICAL"
  | "D1_LOW_RISK_ADDITIVE"
  | "D2_ANALYTICAL"
  | "D3_AUTHORITY_SENSITIVE";

export interface WikiProposalSummary {
  readonly proposal_ref: VersionedRef;
  readonly page_ref: VersionedRef;
  readonly title: string;
  readonly page_type: WikiPageRevision["page_type"];
  readonly risk_class: WikiProposalRiskClass;
  readonly state: "PROPOSED" | "PUBLISHED";
  readonly created_at: string;
}

export interface WikiProposalListView {
  readonly protocol: "eliotr.wiki-proposals.v1";
  readonly items: readonly WikiProposalSummary[];
  readonly has_more: boolean;
  readonly deployment_generation: string;
}

export interface WikiProposalReadView {
  readonly protocol: "eliotr.wiki-proposal-read.v1" | "eliotr.wiki-proposal-read.v2";
  readonly proposal_ref: VersionedRef;
  readonly page: WikiPageRevision;
  readonly risk_class: WikiProposalRiskClass;
  readonly state: "PROPOSED" | "PUBLISHED";
  readonly source_freshness: WikiSourceFreshness;
  readonly deployment_generation: string;
}

export type WikiSourceFreshnessState = "CURRENT_REVISIONS" | "PREVIOUS_REVISIONS" | "UNKNOWN";

export interface WikiSourceFreshnessChange {
  readonly source_id: string;
  readonly saved_revision_ref: string;
  readonly head_revision_ref: string;
}

export interface WikiSourceFreshness {
  readonly state: WikiSourceFreshnessState;
  readonly checked_at?: string;
  readonly changed_sources: readonly WikiSourceFreshnessChange[];
}

export interface WikiProposalBodyView {
  readonly text: string;
  readonly body_sha256: string;
  readonly byte_length: number;
  readonly deployment_generation: string;
}

type JsonRecord = Record<string, unknown>;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RISK_CLASSES: readonly WikiProposalRiskClass[] = [
  "D0_MECHANICAL", "D1_LOW_RISK_ADDITIVE", "D2_ANALYTICAL", "D3_AUTHORITY_SENSITIVE",
];

function invalid(message: string): never {
  throw new ApiRequestError({ status: 502, code: "WIKI_RESPONSE_INVALID", message });
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("Wiki response data must be an object");
  const candidate = value as JsonRecord;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(candidate).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(candidate, key))) {
    invalid("Wiki response has missing or unknown fields");
  }
  return candidate;
}

function identifier(value: unknown, label: string): string {
  if (!IdentifierSchema.safeParse(value).success || typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${label} is invalid`);
  return value;
}

function versionedRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) invalid(`${label} is invalid`);
  return parsed.data;
}

function timestamp(value: unknown, label: string): string {
  const parsed = IsoDateTimeSchema.safeParse(value);
  if (!parsed.success) invalid(`${label} is invalid`);
  return parsed.data;
}

function title(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${label} is invalid`);
  return value;
}

function riskClass(value: unknown, label: string): WikiProposalRiskClass {
  if (typeof value !== "string" || !RISK_CLASSES.includes(value as WikiProposalRiskClass)) invalid(`${label} is invalid`);
  return value as WikiProposalRiskClass;
}

function state(value: unknown, label: string): "PROPOSED" | "PUBLISHED" {
  if (value !== "PROPOSED" && value !== "PUBLISHED") invalid(`${label} is invalid`);
  return value;
}

function sourceFreshness(value: unknown): WikiSourceFreshness {
  const data = record(value, ["state", "checked_at", "changed_sources"]);
  if (data.state !== "CURRENT_REVISIONS" && data.state !== "PREVIOUS_REVISIONS") invalid("source_freshness.state is invalid");
  const checkedAt = timestamp(data.checked_at, "source_freshness.checked_at");
  if (!Array.isArray(data.changed_sources) || data.changed_sources.length > 64) invalid("source_freshness.changed_sources is invalid");
  const seen = new Set<string>();
  const changedSources = data.changed_sources.map((value, index) => {
    const row = record(value, ["source_id", "saved_revision_ref", "head_revision_ref"]);
    const sourceId = identifier(row.source_id, `source_freshness.changed_sources[${index}].source_id`);
    const savedRevision = identifier(row.saved_revision_ref, `source_freshness.changed_sources[${index}].saved_revision_ref`);
    const headRevision = identifier(row.head_revision_ref, `source_freshness.changed_sources[${index}].head_revision_ref`);
    if (seen.has(sourceId)) invalid("source_freshness.changed_sources contains duplicate sources");
    seen.add(sourceId);
    if (data.state === "CURRENT_REVISIONS" && savedRevision !== headRevision) invalid("current source revisions do not match");
    if (data.state === "PREVIOUS_REVISIONS" && savedRevision === headRevision) invalid("previous source revisions must differ");
    return { source_id: sourceId, saved_revision_ref: savedRevision, head_revision_ref: headRevision };
  });
  if (data.state === "CURRENT_REVISIONS" && changedSources.length !== 0) invalid("current source revisions must have no changed sources");
  if (data.state === "PREVIOUS_REVISIONS" && changedSources.length === 0) invalid("previous source revisions must identify a changed source");
  return { state: data.state, checked_at: checkedAt, changed_sources: changedSources };
}

function envelope(raw: unknown, expectedDeploymentGeneration?: string): { readonly data: unknown; readonly deployment_generation: string } {
  const parsed = record(raw, ["data", "trace_id", "deployment_generation"]);
  const trace = identifier(parsed.trace_id, "trace_id");
  if (!SAFE_TRACE_ID.test(trace)) invalid("trace_id is invalid");
  const generation = identifier(parsed.deployment_generation, "deployment_generation");
  if (expectedDeploymentGeneration !== undefined && generation !== expectedDeploymentGeneration) {
    throw new ApiRequestError({ status: 409, code: "WIKI_DEPLOYMENT_CHANGED", message: "The application changed; refresh Wiki proposals", retryable: true });
  }
  return { data: parsed.data, deployment_generation: generation };
}

export function decodeWikiProposalList(raw: unknown, expectedDeploymentGeneration?: string): WikiProposalListView {
  const checked = envelope(raw, expectedDeploymentGeneration);
  const data = record(checked.data, ["protocol", "items", "has_more"]);
  if (data.protocol !== "eliotr.wiki-proposals.v1" || !Array.isArray(data.items) || data.items.length > MAX_WIKI_PROPOSALS || typeof data.has_more !== "boolean") invalid("Wiki proposal list is invalid");
  const seen = new Set<string>();
  const items = data.items.map((value, index) => {
    const item = record(value, ["proposal_ref", "page_ref", "title", "page_type", "risk_class", "state", "created_at"]);
    const proposalRef = versionedRef(item.proposal_ref, `items[${index}].proposal_ref`);
    const pageRef = versionedRef(item.page_ref, `items[${index}].page_ref`);
    const key = `${proposalRef.id}:${proposalRef.revision}`;
    if (seen.has(key)) invalid("Wiki proposal list contains duplicate proposals");
    seen.add(key);
    const pageType = WikiPageTypeSchema.safeParse(item.page_type);
    if (!pageType.success) invalid(`items[${index}].page_type is invalid`);
    return {
      proposal_ref: proposalRef,
      page_ref: pageRef,
      title: title(item.title, `items[${index}].title`),
      page_type: pageType.data,
      risk_class: riskClass(item.risk_class, `items[${index}].risk_class`),
      state: state(item.state, `items[${index}].state`),
      created_at: timestamp(item.created_at, `items[${index}].created_at`),
    };
  });
  return { protocol: "eliotr.wiki-proposals.v1", items, has_more: data.has_more, deployment_generation: checked.deployment_generation };
}

export function decodeWikiProposalRead(raw: unknown, expectedDeploymentGeneration?: string): WikiProposalReadView {
  const checked = envelope(raw, expectedDeploymentGeneration);
  const data = record(checked.data, ["protocol", "proposal_ref", "page", "risk_class", "state"], ["source_freshness"]);
  if (data.protocol !== "eliotr.wiki-proposal-read.v1" && data.protocol !== "eliotr.wiki-proposal-read.v2") invalid("Wiki proposal read protocol is invalid");
  const freshness = data.protocol === "eliotr.wiki-proposal-read.v2"
    ? sourceFreshness(data.source_freshness)
    : Object.hasOwn(data, "source_freshness")
      ? invalid("v1 Wiki proposal read cannot include source freshness")
      : { state: "UNKNOWN" as const, changed_sources: [] as const };
  const page = WikiPageRevisionSchema.safeParse(data.page);
  if (!page.success) invalid("Wiki proposal page is invalid");
  return {
    protocol: data.protocol,
    proposal_ref: versionedRef(data.proposal_ref, "proposal_ref"),
    page: page.data,
    risk_class: riskClass(data.risk_class, "risk_class"),
    state: state(data.state, "state"),
    source_freshness: freshness,
    deployment_generation: checked.deployment_generation,
  };
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function pathRef(ref: VersionedRef, label: string): string {
  if (ref.revision !== 1) throw new ApiRequestError({ status: 400, code: "WIKI_INPUT_INVALID", message: `${label} revision is unsupported` });
  return encodeURIComponent(ref.id);
}

function header(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null || value.length === 0 || value !== value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`Wiki response is missing a valid ${name} header`);
  return value;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export async function readWikiProposals(expectedDeploymentGeneration?: string, signal?: AbortSignal): Promise<WikiProposalListView> {
  const raw = await requestApi("/api/v1/research/wiki/proposals", signal === undefined ? {} : { signal });
  return decodeWikiProposalList(raw, expectedDeploymentGeneration);
}

export async function readWikiProposal(proposalRef: VersionedRef, expectedDeploymentGeneration?: string, signal?: AbortSignal): Promise<WikiProposalReadView> {
  const ref = versionedRef(proposalRef, "proposal_ref");
  const raw = await requestApi(`/api/v1/research/wiki/proposals/${pathRef(ref, "proposal")}`, signal === undefined ? {} : { signal });
  const view = decodeWikiProposalRead(raw, expectedDeploymentGeneration);
  if (refKey(view.proposal_ref) !== refKey(ref)) invalid("Wiki proposal identity does not match the requested proposal");
  return view;
}

export async function readWikiProposalBody(
  proposalRef: VersionedRef,
  pageRef: VersionedRef,
  expectedBodySha256: string,
  expectedDeploymentGeneration: string,
  signal?: AbortSignal,
): Promise<WikiProposalBodyView> {
  const proposal = versionedRef(proposalRef, "proposal_ref");
  const page = versionedRef(pageRef, "page_ref");
  if (!Sha256Schema.safeParse(expectedBodySha256).success) throw new ApiRequestError({ status: 400, code: "WIKI_INPUT_INVALID", message: "expected body digest is invalid" });
  const generation = identifier(expectedDeploymentGeneration, "deployment generation");
  const response = await requestApiBytes(`/api/v1/research/wiki/proposals/${pathRef(proposal, "proposal")}/body`, signal, MAX_WIKI_BODY_BYTES, "text/plain");
  if (header(response.headers, "x-eliotr-wiki-proposal-ref") !== encodeURIComponent(refKey(proposal)) ||
      header(response.headers, "x-eliotr-wiki-page-ref") !== encodeURIComponent(refKey(page))) invalid("Wiki response identity does not match the requested proposal");
  const returnedGeneration = header(response.headers, "x-eliotr-deployment-generation");
  if (returnedGeneration !== generation) throw new ApiRequestError({ status: 409, code: "WIKI_DEPLOYMENT_CHANGED", message: "The application changed; refresh Wiki proposals", retryable: true });
  const bodySha256 = header(response.headers, "x-eliotr-body-sha256");
  if (!Sha256Schema.safeParse(bodySha256).success || bodySha256 !== expectedBodySha256 || await sha256(response.bytes) !== bodySha256) invalid("Wiki body digest does not match the response body");
  const length = response.headers.get("content-length");
  if (length !== null && (length.length === 0 || length !== length.trim() || length.length > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(length) || !/^(0|[1-9][0-9]*)$/u.test(length))) {
    invalid("Wiki response has an invalid content-length header");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(response.bytes); }
  catch { invalid("Wiki body is not valid UTF-8"); }
  return { text, body_sha256: bodySha256, byte_length: response.bytes.byteLength, deployment_generation: generation };
}
