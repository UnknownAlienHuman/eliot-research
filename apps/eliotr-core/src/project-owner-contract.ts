import type { ProjectOwnerActor } from "@eliotr/cloudflare-navigation/project-owner-contract.js";

export {
  IDENTIFIER,
  SHA256,
  MAX_TITLE_LENGTH,
  MAX_TITLE_BYTES,
  MAX_SOURCE_IDS,
  MAX_PROJECTS,
  MAX_IDEMPOTENCY_BYTES,
  MAX_RESPONSE_BYTES,
  PROJECT_PROTOCOL,
  PROJECT_LIST_PROTOCOL,
  CLIENT_CLASS,
  ProjectOwnerError,
  fail,
  utf8Length,
  validIdentifier,
  inputIdentifier,
  storedIdentifier,
  storedSha,
  canonicalTime,
  nowValue,
  normalizeTitle,
  normalizeSourceIds,
  normalizeCreate,
  normalizeUpdate,
  authenticatedActorSnapshot,
  contextSnapshot,
  idempotencyKey,
} from "@eliotr/cloudflare-navigation/project-owner-contract.js";
export type {
  ProjectOwnerErrorCode,
  ProjectOwnerCreateInput,
  ProjectOwnerUpdateInput,
  ProjectOwnerResult,
  ProjectOwnerService,
  ProjectBaseRow,
  ProjectBase,
  MembershipRow,
  MutationReceiptRow,
  StoredMutation,
} from "@eliotr/cloudflare-navigation/project-owner-contract.js";

/** Compatibility name retained for existing Core callers. */
export type OwnerContext = ProjectOwnerActor;
