const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const ITEM_KEY = /^projection-[a-f0-9]{48}$/u;
const PREFIX = "projection/";
export const MANAGED_PROJECT_PROVIDER_KEY_MAX_BYTES = 128;
export const MANAGED_PROJECT_FOLDER_FILTER_MAX_BYTES = 64;

export interface ManagedProjectProviderIdentity {
  readonly instance_id: string;
  readonly projection_generation: string;
  readonly source_revision_ref: string;
  readonly project_id: string;
  readonly project_membership_id: string;
  readonly membership_generation: number;
}

export interface ManagedProjectProviderKeyInput extends ManagedProjectProviderIdentity {
  readonly item_key: string;
}

export interface ManagedProjectProviderKey {
  readonly item_key: string;
  readonly provider_key: string;
  readonly folder_prefix: string;
  readonly source_revision_ref: string;
  readonly project_id: string;
  readonly project_membership_id: string;
  readonly membership_generation: number;
}

export interface ManagedProjectProviderIdentityV2 {
  readonly instance_id: string;
  readonly projection_generation: string;
  readonly source_revision_ref: string;
  readonly project_id: string;
  readonly stable_project_membership_id: string;
  readonly membership_revision: number;
}

export interface ManagedProjectProviderKeyInputV2 extends ManagedProjectProviderIdentityV2 {
  readonly item_key: string;
}

export interface ManagedProjectProviderKeyV2 {
  readonly item_key: string;
  readonly provider_key: string;
  readonly folder_prefix: string;
  readonly source_revision_ref: string;
  readonly project_id: string;
  readonly stable_project_membership_id: string;
  readonly membership_revision: number;
}

export interface ManagedProjectMembershipIdentity {
  readonly project_id: string;
  readonly project_membership_id: string;
  readonly membership_generation: number;
}

function invalid(message: string): never {
  throw new RangeError(message);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    invalid(`${label} must be a canonical identifier`);
  }
  return value;
}

/** Decode only the canonical Core membership identity; never infer a project from a provider path. */
export function parseManagedProjectMembershipId(value: unknown): ManagedProjectMembershipIdentity {
  const membershipId = identifier(value, "project_membership_id");
  const marker = ":generation:";
  const markerAt = membershipId.lastIndexOf(marker);
  if (!membershipId.startsWith("project:") || markerAt <= "project:".length) {
    invalid("project_membership_id must use the canonical project membership form");
  }
  const projectId = identifier(membershipId.slice("project:".length, markerAt), "project_id");
  const generationText = membershipId.slice(markerAt + marker.length);
  if (!/^[1-9][0-9]*$/u.test(generationText)) {
    invalid("project_membership_id generation must be a positive canonical integer");
  }
  const membershipGeneration = Number(generationText);
  if (!Number.isSafeInteger(membershipGeneration)) {
    invalid("project_membership_id generation must be a positive safe integer");
  }
  return Object.freeze({
    project_id: projectId,
    project_membership_id: membershipId,
    membership_generation: membershipGeneration,
  });
}

export function compareManagedProjectMemberships(
  left: ManagedProjectMembershipIdentity,
  right: ManagedProjectMembershipIdentity,
): number {
  return (left.project_id < right.project_id ? -1 : left.project_id > right.project_id ? 1 : 0) ||
    left.membership_generation - right.membership_generation ||
    (left.project_membership_id < right.project_membership_id ? -1 :
      left.project_membership_id > right.project_membership_id ? 1 : 0);
}

/** Choose the same canonical project representative for producers and readers. */
export function selectCanonicalManagedProjectMembership(
  membershipIds: readonly string[],
): ManagedProjectMembershipIdentity {
  if (!Array.isArray(membershipIds) || membershipIds.length < 1 || membershipIds.length > 256) {
    invalid("PROJECT_COPY_V1 requires 1 to 256 current Core project memberships");
  }
  const memberships = membershipIds.map(parseManagedProjectMembershipId);
  if (new Set(memberships.map((membership) => membership.project_membership_id)).size !== memberships.length) {
    invalid("PROJECT_COPY_V1 Core project memberships must be unique");
  }
  memberships.sort(compareManagedProjectMemberships);
  const selected = memberships[0];
  if (selected === undefined) invalid("PROJECT_COPY_V1 has no current Core project membership");
  return selected;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  if (globalThis.crypto?.subtle === undefined) invalid("Web Crypto SHA-256 is unavailable");
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input.buffer));
}

function validatedIdentity(input: ManagedProjectProviderIdentity) {
  const instanceId = identifier(input.instance_id, "instance_id");
  const generation = identifier(input.projection_generation, "projection_generation");
  const sourceRevision = identifier(input.source_revision_ref, "source_revision_ref");
  const projectId = identifier(input.project_id, "project_id");
  const membershipId = identifier(input.project_membership_id, "project_membership_id");
  if (!Number.isSafeInteger(input.membership_generation) || input.membership_generation < 1) {
    invalid("membership_generation must be a positive safe integer");
  }
  if (membershipId !== `project:${projectId}:generation:${input.membership_generation}`) {
    invalid("project membership identity does not match its Core project and generation facts");
  }
  return { instanceId, generation, sourceRevision, projectId, membershipId };
}

/** Return only the bounded folder token; its slash is part of the filter value. */
export async function managedProjectFolderPrefix(
  input: ManagedProjectProviderIdentity,
): Promise<string> {
  const { instanceId, generation, sourceRevision, projectId, membershipId } = validatedIdentity(input);
  const identity = JSON.stringify([
    "PROJECT_COPY_V1",
    instanceId,
    generation,
    sourceRevision,
    projectId,
    membershipId,
    input.membership_generation,
  ]);
  const digest = base64Url(await sha256(new TextEncoder().encode(identity)));
  const folderPrefix = `${PREFIX}${digest}/`;
  if (new TextEncoder().encode(folderPrefix).byteLength >= MANAGED_PROJECT_FOLDER_FILTER_MAX_BYTES) {
    invalid("PROJECT_COPY_V1 folder prefix exceeds the 64-byte filterable metadata prefix");
  }
  return folderPrefix;
}

/**
 * Build the one canonical provider path for a PROJECT_COPY_V1 item.
 *
 * The folder token commits the complete instance, generation, source, project,
 * and membership identities. It is a full SHA-256 digest encoded as 43
 * base64url characters; no identity is truncated or placed in provider
 * metadata. Core facts remain the authority for mapping the token back to its
 * source and project membership.
 */
export async function createManagedProjectProviderKey(
  input: ManagedProjectProviderKeyInput,
): Promise<ManagedProjectProviderKey> {
  const { sourceRevision, projectId, membershipId } = validatedIdentity(input);
  if (typeof input.item_key !== "string" || !ITEM_KEY.test(input.item_key)) {
    invalid("PROJECT_COPY_V1 item_key must retain its canonical 59-character projection hash");
  }
  const folderPrefix = await managedProjectFolderPrefix(input);
  const providerKey = `${folderPrefix}${input.item_key}.md`;
  const encoder = new TextEncoder();
  if (encoder.encode(providerKey).byteLength > MANAGED_PROJECT_PROVIDER_KEY_MAX_BYTES) {
    invalid("PROJECT_COPY_V1 provider key exceeds the 128-byte Items key limit");
  }
  return Object.freeze({
    item_key: input.item_key,
    provider_key: providerKey,
    folder_prefix: folderPrefix,
    source_revision_ref: sourceRevision,
    project_id: projectId,
    project_membership_id: membershipId,
    membership_generation: input.membership_generation,
  });
}

function validatedIdentityV2(input: ManagedProjectProviderIdentityV2) {
  const instanceId = identifier(input.instance_id, "instance_id");
  const generation = identifier(input.projection_generation, "projection_generation");
  const sourceRevision = identifier(input.source_revision_ref, "source_revision_ref");
  const projectId = identifier(input.project_id, "project_id");
  const stableMembershipId = identifier(input.stable_project_membership_id, "stable_project_membership_id");
  if (!Number.isSafeInteger(input.membership_revision) || input.membership_revision < 1) {
    invalid("membership_revision must be a positive safe integer");
  }
  return { instanceId, generation, sourceRevision, projectId, stableMembershipId };
}

/** Return the bounded V2 membership folder; V1 folder bytes remain owned by managedProjectFolderPrefix. */
export async function managedProjectFolderPrefixV2(
  input: ManagedProjectProviderIdentityV2,
): Promise<string> {
  const { instanceId, generation, sourceRevision, projectId, stableMembershipId } = validatedIdentityV2(input);
  const identity = JSON.stringify([
    "PROJECT_COPY_V2",
    instanceId,
    generation,
    sourceRevision,
    projectId,
    stableMembershipId,
    input.membership_revision,
  ]);
  const digest = base64Url(await sha256(new TextEncoder().encode(identity)));
  const folderPrefix = `${PREFIX}${digest}/`;
  if (new TextEncoder().encode(folderPrefix).byteLength >= MANAGED_PROJECT_FOLDER_FILTER_MAX_BYTES) {
    invalid("PROJECT_COPY_V2 folder prefix exceeds the 64-byte filterable metadata prefix");
  }
  return folderPrefix;
}

/** Build a V2 provider key from the bounded membership ID and per-pair revision only. */
export async function createManagedProjectProviderKeyV2(
  input: ManagedProjectProviderKeyInputV2,
): Promise<ManagedProjectProviderKeyV2> {
  const { sourceRevision, projectId, stableMembershipId } = validatedIdentityV2(input);
  if (typeof input.item_key !== "string" || !ITEM_KEY.test(input.item_key)) {
    invalid("PROJECT_COPY_V2 item_key must retain its canonical 59-character projection hash");
  }
  const folderPrefix = await managedProjectFolderPrefixV2(input);
  const providerKey = `${folderPrefix}${input.item_key}.md`;
  const encoder = new TextEncoder();
  if (encoder.encode(providerKey).byteLength > MANAGED_PROJECT_PROVIDER_KEY_MAX_BYTES) {
    invalid("PROJECT_COPY_V2 provider key exceeds the 128-byte Items key limit");
  }
  return Object.freeze({
    item_key: input.item_key,
    provider_key: providerKey,
    folder_prefix: folderPrefix,
    source_revision_ref: sourceRevision,
    project_id: projectId,
    stable_project_membership_id: stableMembershipId,
    membership_revision: input.membership_revision,
  });
}

/** Store a long generation identity in the existing bounded metadata slot. */
export async function managedProjectGenerationMetadataValue(generationValue: string): Promise<string> {
  const generation = identifier(generationValue, "projection_generation");
  const digest = await sha256(new TextEncoder().encode(`eliotr.project-copy-generation.v1\0${generation}`));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
