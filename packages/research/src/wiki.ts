import {
  VersionedRefSchema,
  WikiPageRevisionSchema,
  type VersionedRef,
  type WikiPageRevision,
} from "@eliotr/contracts";
import {
  wikiMayAutoPromote,
  wikiMayBePublished,
  wikiTargetsExpectedHead,
  type DraftRiskClass,
  type WikiAutoPromotionAuthority,
} from "@eliotr/domain";

export type { EvidenceLabel as StatementLabel, WikiPageRevision, WikiPageType } from "@eliotr/contracts";
export type { DraftRiskClass, WikiAutoPromotionAuthority } from "@eliotr/domain";

export type WikiPublicationErrorCode =
  | "WIKI_INPUT_INVALID"
  | "WIKI_PROPOSAL_NOT_FOUND"
  | "WIKI_PROPOSAL_READBACK_MISMATCH"
  | "WIKI_PUBLICATION_INCOMPLETE"
  | "WIKI_POLICY_DENIED"
  | "WIKI_HEAD_CONFLICT"
  | "WIKI_IMMUTABLE_READBACK_MISMATCH"
  | "WIKI_SETTLEMENT_UNCERTAIN";

export class WikiPublicationError extends Error {
  public readonly code: WikiPublicationErrorCode;
  public readonly retryable: boolean;

  public constructor(code: WikiPublicationErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WikiPublicationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface WikiProposalRecord {
  readonly proposal_ref: VersionedRef;
  readonly page: WikiPageRevision;
  readonly risk_class: DraftRiskClass;
}

export interface WikiImmutableRevisionReceipt {
  readonly page_ref: VersionedRef;
  readonly manifest_ref: string;
  readonly body_object_ref: string;
  readonly body_sha256: string;
}

export interface WikiHeadReadback {
  readonly page_ref: VersionedRef;
  readonly manifest_ref: string;
  readonly outbox_ref: string;
}

export interface WikiHeadCommit {
  readonly proposal_ref: VersionedRef;
  readonly page: WikiPageRevision;
  readonly expected_head_revision: number | null;
  readonly manifest_ref: string;
  readonly committer_ref: string;
  readonly auto_promotion_policy_receipt_ref?: string;
}

export type WikiHeadCommitDisposition = "COMMITTED" | "EXISTING" | "CONFLICT";

/**
 * Runtime port. commitHeadAndOutbox MUST atomically insert the immutable revision metadata,
 * compare-and-swap wiki_head, supersede the former row when applicable, and append the outbox intent.
 */
export interface WikiPublicationPort {
  saveProposal(page: WikiPageRevision, riskClass: DraftRiskClass): Promise<VersionedRef>;
  readProposal(proposalRef: VersionedRef): Promise<WikiProposalRecord | null>;
  validateEvidenceMap(page: WikiPageRevision): Promise<boolean>;
  validateCoverage(page: WikiPageRevision): Promise<boolean>;
  validateDependencyClosure(page: WikiPageRevision): Promise<boolean>;
  writeImmutableRevision(page: WikiPageRevision): Promise<WikiImmutableRevisionReceipt>;
  readImmutableRevision(pageRef: VersionedRef, manifestRef: string): Promise<WikiPageRevision | null>;
  commitHeadAndOutbox(input: WikiHeadCommit): Promise<WikiHeadCommitDisposition>;
  readHead(pageId: string): Promise<WikiHeadReadback | null>;
}

export interface WikiAutoPromotionReceipt extends WikiAutoPromotionAuthority {
  readonly publisher_ref: string;
}

export interface WikiPublisher {
  propose(page: WikiPageRevision, riskClass: DraftRiskClass): Promise<VersionedRef>;
  publish(proposalRef: VersionedRef, expectedHeadRevision: number, committerRef: string): Promise<WikiPageRevision>;
  autoPromote(
    proposalRef: VersionedRef,
    expectedHeadRevision: number,
    authority: WikiAutoPromotionReceipt,
  ): Promise<WikiPageRevision>;
}

const RISK_CLASSES: readonly DraftRiskClass[] = [
  "D0_MECHANICAL",
  "D1_LOW_RISK_ADDITIVE",
  "D2_ANALYTICAL",
  "D3_AUTHORITY_SENSITIVE",
];
const MAX_CANONICAL_BYTES = 256 * 1024;
const MAX_CANONICAL_DEPTH = 16;
const MAX_CANONICAL_NODES = 4_096;

function fail(code: WikiPublicationErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new WikiPublicationError(code, message, retryable, cause);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && value.length <= 256;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

interface CanonicalState {
  nodes: number;
  readonly ancestors: WeakSet<object>;
}

function canonicalJson(value: unknown, state: CanonicalState, depth = 0): string {
  if (depth > MAX_CANONICAL_DEPTH || state.nodes >= MAX_CANONICAL_NODES) {
    fail("WIKI_INPUT_INVALID", "wiki revision exceeds canonical structure bounds");
  }
  state.nodes += 1;
  if (value === null) return "null";
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) fail("WIKI_INPUT_INVALID", "wiki revision contains malformed Unicode");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("WIKI_INPUT_INVALID", "wiki revision contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") fail("WIKI_INPUT_INVALID", "wiki revision contains non-JSON state");
  if (state.ancestors.has(value)) fail("WIKI_INPUT_INVALID", "wiki revision contains a cycle");
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        fail("WIKI_INPUT_INVALID", "wiki revision contains a sparse or extended array");
      }
      return `[${value.map((item) => canonicalJson(item, state, depth + 1)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("WIKI_INPUT_INVALID", "wiki revision contains a non-plain object");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail("WIKI_INPUT_INVALID", "wiki revision contains symbol state");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const fields: string[] = [];
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
        fail("WIKI_INPUT_INVALID", "wiki revision contains hidden or accessor state");
      }
      fields.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value, state, depth + 1)}`);
    }
    return `{${fields.join(",")}}`;
  } finally {
    state.ancestors.delete(value);
  }
}

function canonicalPage(page: WikiPageRevision): string {
  const value = canonicalJson(page, { nodes: 0, ancestors: new WeakSet<object>() });
  if (new TextEncoder().encode(value).byteLength > MAX_CANONICAL_BYTES) {
    fail("WIKI_INPUT_INVALID", "wiki revision exceeds its canonical byte bound");
  }
  return value;
}

function parsePage(value: unknown): WikiPageRevision {
  const parsed = WikiPageRevisionSchema.safeParse(value);
  if (!parsed.success) fail("WIKI_INPUT_INVALID", "wiki revision failed strict validation");
  canonicalPage(parsed.data);
  return parsed.data;
}

function parseRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) fail("WIKI_INPUT_INVALID", `${label} failed strict validation`);
  return parsed.data;
}

function parseRisk(value: unknown): DraftRiskClass {
  if (typeof value !== "string" || !RISK_CLASSES.includes(value as DraftRiskClass)) {
    fail("WIKI_INPUT_INVALID", "draft risk class is invalid");
  }
  return value as DraftRiskClass;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function samePage(left: WikiPageRevision, right: WikiPageRevision): boolean {
  try {
    return canonicalPage(parsePage(left)) === canonicalPage(parsePage(right));
  } catch {
    return false;
  }
}

function expectedRevision(value: number): number | null {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("WIKI_INPUT_INVALID", "expected head revision must be a non-negative safe integer");
  }
  return value === 0 ? null : value;
}

function publishedRevision(candidate: WikiPageRevision, expected: number | null, committerRef: string): WikiPageRevision {
  if (!nonEmpty(committerRef)) fail("WIKI_INPUT_INVALID", "committer reference is invalid");
  const raw: Record<string, unknown> = {
    ...candidate,
    status: "PUBLISHED",
    reviewer_ref: committerRef,
  };
  if (expected === null) delete raw.supersedes_ref;
  else raw.supersedes_ref = { id: candidate.page_ref.id, revision: expected };
  const parsed = WikiPageRevisionSchema.safeParse(raw);
  if (!parsed.success || parsed.data.status !== "PUBLISHED") {
    fail("WIKI_INPUT_INVALID", "published wiki revision could not be materialized");
  }
  canonicalPage(parsed.data);
  return parsed.data;
}

async function readProposal(port: WikiPublicationPort, proposalRef: VersionedRef): Promise<WikiProposalRecord> {
  let stored: WikiProposalRecord | null;
  try {
    stored = await port.readProposal(proposalRef);
  } catch (cause) {
    fail("WIKI_SETTLEMENT_UNCERTAIN", "wiki proposal read is unavailable", true, cause);
  }
  if (stored === null) fail("WIKI_PROPOSAL_NOT_FOUND", "wiki proposal does not exist");
  const storedRef = parseRef(stored.proposal_ref, "stored proposal reference");
  const page = parsePage(stored.page);
  const riskClass = parseRisk(stored.risk_class);
  if (!sameRef(storedRef, proposalRef)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "wiki proposal readback has a foreign identity");
  }
  return { proposal_ref: storedRef, page, risk_class: riskClass };
}

async function validatePublication(port: WikiPublicationPort, page: WikiPageRevision): Promise<void> {
  let results: readonly boolean[];
  try {
    results = await Promise.all([
      port.validateEvidenceMap(page),
      port.validateCoverage(page),
      port.validateDependencyClosure(page),
    ]);
  } catch (cause) {
    fail("WIKI_SETTLEMENT_UNCERTAIN", "wiki publication authority readback is unavailable", true, cause);
  }
  if (results.some((result) => result !== true)) {
    fail("WIKI_PUBLICATION_INCOMPLETE", "wiki publication evidence, coverage, or dependency closure is incomplete");
  }
}

type Reconciliation = "MATCH" | "DIFFERENT" | "ABSENT" | "UNKNOWN";

async function reconcileHead(
  port: WikiPublicationPort,
  page: WikiPageRevision,
  manifestRef?: string,
): Promise<Reconciliation> {
  let head: WikiHeadReadback | null;
  try {
    head = await port.readHead(page.page_ref.id);
  } catch {
    return "UNKNOWN";
  }
  if (head === null) return "ABSENT";
  let headRef: VersionedRef;
  try { headRef = parseRef(head.page_ref, "wiki head reference"); }
  catch { return "UNKNOWN"; }
  if (!sameRef(headRef, page.page_ref)
    || !nonEmpty(head.manifest_ref)
    || !nonEmpty(head.outbox_ref)
    || (manifestRef !== undefined && head.manifest_ref !== manifestRef)) {
    return "DIFFERENT";
  }
  let stored: WikiPageRevision | null;
  try {
    stored = await port.readImmutableRevision(page.page_ref, head.manifest_ref);
  } catch {
    return "UNKNOWN";
  }
  if (stored === null) return "UNKNOWN";
  return samePage(stored, page) ? "MATCH" : "DIFFERENT";
}

function verifyImmutableReceipt(page: WikiPageRevision, receipt: WikiImmutableRevisionReceipt): void {
  let ref: VersionedRef;
  try { ref = parseRef(receipt.page_ref, "immutable revision receipt"); }
  catch (cause) { fail("WIKI_IMMUTABLE_READBACK_MISMATCH", "immutable revision receipt is malformed", false, cause); }
  if (!sameRef(ref, page.page_ref)
    || !nonEmpty(receipt.manifest_ref)
    || receipt.body_object_ref !== page.body_object_ref
    || receipt.body_sha256 !== page.body_sha256) {
    fail("WIKI_IMMUTABLE_READBACK_MISMATCH", "immutable revision receipt does not bind the published bytes");
  }
}

async function publishStored(
  port: WikiPublicationPort,
  stored: WikiProposalRecord,
  expectedHeadRevision: number,
  committerRef: string,
  autoPromotionPolicyReceiptRef?: string,
): Promise<WikiPageRevision> {
  const expected = expectedRevision(expectedHeadRevision);
  if (!wikiMayBePublished(stored.page)) {
    fail("WIKI_PUBLICATION_INCOMPLETE", "wiki proposal does not satisfy publication invariants");
  }
  const published = publishedRevision(stored.page, expected, committerRef);

  let head: WikiHeadReadback | null;
  try { head = await port.readHead(stored.page.page_ref.id); }
  catch (cause) { fail("WIKI_SETTLEMENT_UNCERTAIN", "wiki head read is unavailable", true, cause); }
  if (head !== null && sameRef(parseRef(head.page_ref, "wiki head reference"), published.page_ref)) {
    const replay = await reconcileHead(port, published);
    if (replay === "MATCH") return published;
    if (replay === "DIFFERENT") fail("WIKI_HEAD_CONFLICT", "wiki revision is already occupied by different immutable bytes");
    fail("WIKI_SETTLEMENT_UNCERTAIN", "wiki head replay cannot be settled", true);
  }
  const currentRevision = head === null ? null : parseRef(head.page_ref, "wiki head reference").revision;
  if (!wikiTargetsExpectedHead(stored.page, currentRevision, expected)) {
    fail("WIKI_HEAD_CONFLICT", "wiki head no longer matches the expected revision");
  }

  await validatePublication(port, stored.page);

  let immutable: WikiImmutableRevisionReceipt;
  try {
    immutable = await port.writeImmutableRevision(published);
  } catch (cause) {
    fail("WIKI_SETTLEMENT_UNCERTAIN", "immutable wiki revision write is uncertain", true, cause);
  }
  verifyImmutableReceipt(published, immutable);
  let immutableReadback: WikiPageRevision | null;
  try {
    immutableReadback = await port.readImmutableRevision(published.page_ref, immutable.manifest_ref);
  } catch (cause) {
    fail("WIKI_SETTLEMENT_UNCERTAIN", "immutable wiki revision readback is unavailable", true, cause);
  }
  if (immutableReadback === null || !samePage(immutableReadback, published)) {
    fail("WIKI_IMMUTABLE_READBACK_MISMATCH", "immutable wiki revision failed exact readback");
  }

  const commit: WikiHeadCommit = {
    proposal_ref: stored.proposal_ref,
    page: published,
    expected_head_revision: expected,
    manifest_ref: immutable.manifest_ref,
    committer_ref: committerRef,
    ...(autoPromotionPolicyReceiptRef === undefined
      ? {}
      : { auto_promotion_policy_receipt_ref: autoPromotionPolicyReceiptRef }),
  };
  let disposition: WikiHeadCommitDisposition;
  try {
    disposition = await port.commitHeadAndOutbox(commit);
  } catch (cause) {
    const reconciled = await reconcileHead(port, published, immutable.manifest_ref);
    if (reconciled === "MATCH") return published;
    if (reconciled === "DIFFERENT") fail("WIKI_HEAD_CONFLICT", "another wiki publisher won the expected-head CAS");
    fail("WIKI_SETTLEMENT_UNCERTAIN", "wiki head mutation outcome is unknown", true, cause);
  }
  if (disposition === "CONFLICT") {
    fail("WIKI_HEAD_CONFLICT", "another wiki publisher won the expected-head CAS");
  }
  if (disposition !== "COMMITTED" && disposition !== "EXISTING") {
    fail("WIKI_SETTLEMENT_UNCERTAIN", "wiki store returned an unknown commit disposition", true);
  }
  const reconciled = await reconcileHead(port, published, immutable.manifest_ref);
  if (reconciled === "MATCH") return published;
  if (reconciled === "DIFFERENT") fail("WIKI_HEAD_CONFLICT", "wiki head readback belongs to another revision");
  fail("WIKI_SETTLEMENT_UNCERTAIN", "wiki publication lacks exact head and outbox readback", true);
}

export function createWikiPublisher(port: WikiPublicationPort): WikiPublisher {
  return {
    async propose(rawPage, rawRiskClass) {
      const page = parsePage(rawPage);
      const riskClass = parseRisk(rawRiskClass);
      if (!wikiMayBePublished(page)) {
        fail("WIKI_PUBLICATION_INCOMPLETE", "wiki draft does not satisfy publication invariants");
      }
      let proposalRef: VersionedRef;
      try {
        proposalRef = parseRef(await port.saveProposal(page, riskClass), "proposal reference");
      } catch (cause) {
        if (cause instanceof WikiPublicationError) throw cause;
        fail("WIKI_SETTLEMENT_UNCERTAIN", "wiki proposal write is uncertain", true, cause);
      }
      const stored = await readProposal(port, proposalRef);
      if (stored.risk_class !== riskClass || !samePage(stored.page, page)) {
        fail("WIKI_PROPOSAL_READBACK_MISMATCH", "wiki proposal failed exact readback");
      }
      return proposalRef;
    },

    async publish(rawProposalRef, expectedHeadRevision, committerRef) {
      const proposalRef = parseRef(rawProposalRef, "proposal reference");
      const stored = await readProposal(port, proposalRef);
      return publishStored(port, stored, expectedHeadRevision, committerRef);
    },

    async autoPromote(rawProposalRef, expectedHeadRevision, authority) {
      const proposalRef = parseRef(rawProposalRef, "proposal reference");
      const stored = await readProposal(port, proposalRef);
      if (!nonEmpty(authority.publisher_ref)
        || !wikiMayAutoPromote(stored.page, stored.risk_class, authority)) {
        fail("WIKI_POLICY_DENIED", "wiki draft is not eligible for automatic promotion");
      }
      return publishStored(
        port,
        stored,
        expectedHeadRevision,
        authority.publisher_ref,
        authority.policy_receipt_ref,
      );
    },
  };
}
