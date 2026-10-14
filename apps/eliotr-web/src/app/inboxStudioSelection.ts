import type { VersionedRef, WikiProposalListView, WikiProposalReadView } from "@eliotr/owner-api-client";
import type { SessionContext } from "./privacy";

export const INBOX_STUDIO_SELECTION_PROTOCOL = "eliotr.inbox-studio-selection.v1" as const;

export interface InboxStudioSelection {
  readonly protocol: typeof INBOX_STUDIO_SELECTION_PROTOCOL;
  readonly proposalRef: VersionedRef;
  readonly title: string;
  readonly principal: string;
  readonly credentialGeneration: string;
  readonly deploymentGeneration: string;
  readonly cacheEpoch: number;
  readonly expiresAt: string;
}

type ProposalSummary = WikiProposalListView["items"][number];

const SELECTION_KEYS = [
  "protocol", "proposalRef", "title", "principal", "credentialGeneration",
  "deploymentGeneration", "cacheEpoch", "expiresAt",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && ownKeys.every(key => typeof key === "string" && keys.includes(key));
}

function safeText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isVersionedRef(value: unknown): value is VersionedRef {
  return isRecord(value) && hasExactKeys(value, ["id", "revision"]) &&
    safeText(value.id, 256) && typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) && value.revision > 0;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sessionMatches(selection: InboxStudioSelection, context: SessionContext): boolean {
  return selection.principal === context.principal &&
    selection.credentialGeneration === context.credentialGeneration &&
    selection.deploymentGeneration === context.deploymentGeneration &&
    selection.cacheEpoch === context.cacheEpoch && selection.expiresAt === context.expiresAt;
}

function decodeSelection(value: unknown): InboxStudioSelection | undefined {
  if (!isRecord(value) || !hasExactKeys(value, SELECTION_KEYS) ||
    value.protocol !== INBOX_STUDIO_SELECTION_PROTOCOL || !isVersionedRef(value.proposalRef) ||
    !safeText(value.title, 512) ||
    !safeText(value.principal, 256) || !safeText(value.credentialGeneration, 256) ||
    !safeText(value.deploymentGeneration, 256) || typeof value.cacheEpoch !== "number" ||
    !Number.isSafeInteger(value.cacheEpoch) || value.cacheEpoch < 0 || !safeText(value.expiresAt, 64)) return undefined;
  return Object.freeze({
    protocol: INBOX_STUDIO_SELECTION_PROTOCOL,
    proposalRef: Object.freeze({ id: value.proposalRef.id, revision: value.proposalRef.revision }),
    title: value.title,
    principal: value.principal,
    credentialGeneration: value.credentialGeneration,
    deploymentGeneration: value.deploymentGeneration,
    cacheEpoch: value.cacheEpoch,
    expiresAt: value.expiresAt,
  });
}

/** Inbox item IDs are presentation keys; proposal refs are never encoded into or parsed from them. */
export function inboxProposalItemId(index: number): string {
  return Number.isSafeInteger(index) && index >= 0 ? `wiki-proposal-${index}` : "";
}

export function createInboxStudioSelection(
  proposal: ProposalSummary,
  context: SessionContext,
): InboxStudioSelection | undefined {
  if (proposal.state !== "PROPOSED" ||
    !isVersionedRef(proposal.proposal_ref) || !safeText(proposal.title, 512) ||
    !safeText(context.principal, 256) || !safeText(context.credentialGeneration, 256) ||
    !safeText(context.deploymentGeneration, 256) || !Number.isSafeInteger(context.cacheEpoch) ||
    context.cacheEpoch < 0 || !safeText(context.expiresAt, 64)) return undefined;
  return Object.freeze({
    protocol: INBOX_STUDIO_SELECTION_PROTOCOL,
    proposalRef: Object.freeze({ id: proposal.proposal_ref.id, revision: proposal.proposal_ref.revision }),
    title: proposal.title,
    principal: context.principal,
    credentialGeneration: context.credentialGeneration,
    deploymentGeneration: context.deploymentGeneration,
    cacheEpoch: context.cacheEpoch,
    expiresAt: context.expiresAt,
  });
}

export function hasInboxStudioSelectionState(value: unknown): boolean {
  return isRecord(value) && value.protocol === INBOX_STUDIO_SELECTION_PROTOCOL;
}

/** Accept only when the exact proposal ref and its captured title still identify one current Inbox row. */
export function resolveInboxStudioSelection(
  routeState: unknown,
  context: SessionContext,
  proposals: WikiProposalListView,
  existingIntent?: { readonly phase: string },
): InboxStudioSelection | undefined {
  const selection = decodeSelection(routeState);
  if (!selection || existingIntent || !sessionMatches(selection, context) ||
    proposals.deployment_generation !== context.deploymentGeneration) return undefined;

  const refMatches = proposals.items.filter(row => sameRef(row.proposal_ref, selection.proposalRef));
  if (refMatches.length !== 1 || refMatches[0]?.state !== "PROPOSED" || refMatches[0].title !== selection.title) return undefined;
  return selection;
}

export function matchesInboxStudioReadback(
  selection: InboxStudioSelection,
  context: SessionContext,
  proposal: WikiProposalReadView,
): boolean {
  return sessionMatches(selection, context) && proposal.deployment_generation === context.deploymentGeneration &&
    proposal.state === "PROPOSED" && sameRef(proposal.proposal_ref, selection.proposalRef) &&
    proposal.page.title === selection.title;
}
