import { IdentifierSchema, VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { ApiRequestError, requestApi } from "./api.js";
import { MAX_WIKI_BODY_BYTES } from "./wiki-api.js";
import type { WikiProposalFromRunView } from "./wiki-proposal-create-api.js";

const PATH = "/api/v1/research/wiki/proposals/from-edit";
const PROTOCOL = "eliotr.wiki-proposal.v1" as const;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_TITLE_CHARS = 512;
const MAX_EDIT_NOTE_CHARS = 4_096;
const MAX_WIKI_EDIT_REQUEST_BYTES = 8_650_752;
const WIKI_EDIT_TIMEOUT_MS = 10 * 60 * 1000;

export type WikiEditProposalView = WikiProposalFromRunView;

type JsonRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new ApiRequestError({ status: 502, code: "WIKI_RESPONSE_INVALID", message });
}

function inputInvalid(message: string): never {
  throw new ApiRequestError({ status: 400, code: "WIKI_INPUT_INVALID", message });
}

function record(value: unknown, keys: readonly string[], label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} is invalid`);
  const candidate = value as JsonRecord;
  if (Object.keys(candidate).length !== keys.length || keys.some((key) => !Object.hasOwn(candidate, key))) {
    invalid(`${label} has missing or unknown fields`);
  }
  return candidate;
}

function responseIdentifier(value: unknown, label: string): string {
  if (!IdentifierSchema.safeParse(value).success || typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function inputIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || !IdentifierSchema.safeParse(value).success || !SAFE_IDENTIFIER.test(value)) {
    inputInvalid(`${label} is invalid`);
  }
  return value;
}

function responseRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) invalid(`${label} is invalid`);
  return parsed.data;
}

function inputRef(value: VersionedRef, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) inputInvalid(`${label} is invalid`);
  return parsed.data;
}

function requestId(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) {
    inputInvalid("idempotency-key is invalid");
  }
  return value;
}

function title(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_TITLE_CHARS || value.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    inputInvalid("title is invalid");
  }
  return value;
}

function editText(value: string, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.trim().length === 0) ||
      /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    inputInvalid(`${label} is invalid`);
  }
  return value;
}

function decode(
  raw: unknown,
  expectedDeploymentGeneration: string,
  baseProposalRef: VersionedRef,
  basePageRef: VersionedRef,
): WikiEditProposalView {
  const envelope = record(raw, ["data", "trace_id", "deployment_generation"], "Wiki proposal response");
  const trace = responseIdentifier(envelope.trace_id, "trace_id");
  if (!SAFE_TRACE_ID.test(trace)) invalid("trace_id is invalid");
  const generation = responseIdentifier(envelope.deployment_generation, "deployment_generation");
  if (generation !== expectedDeploymentGeneration) {
    throw new ApiRequestError({ status: 409, code: "WIKI_DEPLOYMENT_CHANGED", message: "The application changed; refresh Wiki proposals.", retryable: true });
  }
  const data = record(envelope.data, ["protocol", "proposal_ref", "page_ref", "risk_class", "state"], "Wiki proposal data");
  if (data.protocol !== PROTOCOL || data.risk_class !== "D2_ANALYTICAL" || data.state !== "PROPOSED") invalid("Wiki edit proposal response is invalid");
  const proposalRef = responseRef(data.proposal_ref, "proposal_ref");
  if (proposalRef.revision !== 1) invalid("Wiki edit proposal revision is invalid");
  const pageRef = responseRef(data.page_ref, "page_ref");
  if (pageRef.id !== basePageRef.id || pageRef.revision !== basePageRef.revision + 1) invalid("Wiki edit proposal page revision does not match the base page");
  if (baseProposalRef.revision !== 1) invalid("Wiki edit proposal base revision is invalid");
  return {
    protocol: PROTOCOL,
    proposal_ref: proposalRef,
    page_ref: pageRef,
    risk_class: "D2_ANALYTICAL",
    state: "PROPOSED",
    deployment_generation: generation,
  };
}

export async function createWikiEditProposal(
  baseProposalRef: VersionedRef,
  basePageRef: VersionedRef,
  expectedHeadRevision: number,
  titleText: string,
  bodyText: string,
  editNote: string,
  expectedDeploymentGeneration: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<WikiEditProposalView> {
  const baseProposal = inputRef(baseProposalRef, "base_proposal_ref");
  if (baseProposal.revision !== 1) inputInvalid("base_proposal_ref revision is unsupported");
  const basePage = inputRef(basePageRef, "base_page_ref");
  if (basePage.revision >= Number.MAX_SAFE_INTEGER) inputInvalid("base_page_ref revision is too large");
  if (!Number.isSafeInteger(expectedHeadRevision) || expectedHeadRevision !== basePage.revision) inputInvalid("expected head revision does not match the base page");
  const titleValue = title(titleText);
  const bodyValue = editText(bodyText, "body_text", MAX_WIKI_BODY_BYTES);
  const bodyBytes = new TextEncoder().encode(bodyValue);
  if (bodyBytes.byteLength === 0 || bodyBytes.byteLength > MAX_WIKI_BODY_BYTES) inputInvalid("body_text exceeds the Wiki body bound");
  const noteValue = editText(editNote, "edit_note", MAX_EDIT_NOTE_CHARS, true);
  const generation = inputIdentifier(expectedDeploymentGeneration, "deployment generation");
  const idem = requestId(idempotencyKey);
  const requestBody = JSON.stringify({
    base_proposal_ref: baseProposal,
    expected_head_revision: expectedHeadRevision,
    title: titleValue,
    body_text: bodyValue,
    edit_note: noteValue,
  });
  if (new TextEncoder().encode(requestBody).byteLength > MAX_WIKI_EDIT_REQUEST_BYTES) {
    throw new ApiRequestError({
      status: 413,
      code: "WIKI_INPUT_INVALID",
      message: "This edit is too large to save as a Wiki draft. Shorten the page and try again.",
    });
  }
  const raw = await requestApi(PATH, {
    method: "POST",
    body: requestBody,
    headers: { "content-type": "application/json", "x-eliotr-csrf": "1", "idempotency-key": idem },
    ...(signal === undefined ? {} : { signal }),
  }, WIKI_EDIT_TIMEOUT_MS);
  return decode(raw, generation, baseProposal, basePage);
}
