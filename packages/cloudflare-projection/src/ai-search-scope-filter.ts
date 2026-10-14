/** One Core-authorized project membership selected for this source revision. */
export interface AiSearchAuthorizedProjectCopy {
  readonly source_revision_ref: string;
  readonly source_owner_generation: string;
  readonly project_id: string;
  readonly project_membership_id: string;
  readonly membership_generation: number;
  readonly folder_prefix: string;
}

export interface AiSearchProjectCopyScope {
  readonly layout: "PROJECT_COPY_V1";
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly scope_snapshot_digest: string;
  readonly target: Readonly<{
    readonly namespace: string;
    readonly managed_instance_id: string;
    readonly managed_generation: string;
    readonly target_profile_identity_sha256: string;
  }>;
  readonly generation_metadata_value: string;
  readonly representative_policy: "ONE_CANONICAL_COPY_PER_SOURCE_REVISION";
  readonly copies: readonly AiSearchAuthorizedProjectCopy[];
}

/** All filters are applied by AI Search before the provider top-K boundary. */
export interface AiSearchScopeFilter {
  readonly source_revision_ref: Readonly<{ readonly $in: readonly string[] }>;
  readonly projection_generation: string;
  readonly folder: Readonly<{ readonly $in: readonly string[] }>;
}

// AI Search filters only the first 64 UTF-8 bytes of each indexed string. Its
// compact JSON filter must remain strictly below 2048 bytes. Folder prefixes
// are per-source Core-authorized membership paths, so the `$in` cannot admit a
// different project's copy for another source revision.
// https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/
const MAX_INDEXED_STRING_BYTES = 64;
const MAX_FILTER_BYTES = 2048;
const MAX_PROJECT_IDS = 256;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const GENERATION_DIGEST = /^[a-f0-9]{64}$/u;
const PROJECT_FOLDER = /^projection\/[A-Za-z0-9_-]{43}\/$/u;

function invalid(message: string): never {
  throw new RangeError(message);
}

function filterIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) ||
      new TextEncoder().encode(value).byteLength > MAX_INDEXED_STRING_BYTES) {
    invalid(`${label} must be a complete ASCII identifier of at most 64 bytes`);
  }
  return value;
}

function canonicalIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value.length > 256) {
    invalid(`${label} must be a canonical identifier`);
  }
  return value;
}

function assertFilterBudget(filter: AiSearchScopeFilter): void {
  if (new TextEncoder().encode(JSON.stringify(filter)).byteLength >= MAX_FILTER_BYTES) {
    invalid("AI Search scope filter must be smaller than 2048 bytes; no provider query was dispatched");
  }
}

/** Check the fixed-size folder envelope before deriving provider path hashes. */
export function assertAiSearchScopeFilterBudget(
  sourceRevisionRefs: readonly string[],
  projectionGenerationMetadataValue: string,
  folderCount: number,
): void {
  if (!Number.isSafeInteger(folderCount) || folderCount !== sourceRevisionRefs.length) {
    invalid("AI Search requires one pre-retrieval project folder per frozen source revision");
  }
  if (!GENERATION_DIGEST.test(projectionGenerationMetadataValue)) {
    invalid("AI Search project-copy generation fence must be a full SHA-256 metadata value");
  }
  const members = sourceRevisionRefs.map((value) => filterIdentifier(value, "source_revision_ref"));
  if (new Set(members).size !== members.length) invalid("AI Search scope contains duplicate source revisions");
  members.sort();
  const placeholders = Array.from({ length: folderCount }, (_, index) =>
    `projection/${index.toString(36).padStart(43, "A")}/`);
  const filter = {
    source_revision_ref: { $in: members },
    projection_generation: projectionGenerationMetadataValue,
    folder: { $in: placeholders },
  };
  assertFilterBudget(filter);
}

/**
 * Compile the frozen source, generation-digest, and project-folder fences into
 * one provider filter. Each source revision must have exactly one authorized
 * representative copy. A nonrepresentable scope fails before provider I/O;
 * it is never truncated, omitted, or split into paid calls.
 */
export function createAiSearchScopeFilter(
  sourceRevisionRefs: readonly string[],
  projectionGenerationMetadataValue: string,
  authorizedCopies: readonly AiSearchAuthorizedProjectCopy[],
): AiSearchScopeFilter {
  if (!Array.isArray(sourceRevisionRefs) || !Array.isArray(authorizedCopies)) {
    invalid("AI Search scope members and project copies must be arrays");
  }
  if (!GENERATION_DIGEST.test(projectionGenerationMetadataValue)) {
    invalid("AI Search project-copy generation fence must be a full SHA-256 metadata value");
  }

  const members: string[] = [];
  const memberSet = new Set<string>();
  for (const raw of sourceRevisionRefs) {
    const member = filterIdentifier(raw, "source_revision_ref");
    if (memberSet.has(member)) invalid("AI Search scope contains duplicate source revisions");
    memberSet.add(member);
    members.push(member);
  }
  members.sort();

  const folders: string[] = [];
  const selectedSources = new Set<string>();
  const selectedProjects = new Set<string>();
  const seenFolders = new Set<string>();
  for (const copy of authorizedCopies) {
    const sourceRevision = filterIdentifier(copy.source_revision_ref, "project copy source_revision_ref");
    canonicalIdentifier(copy.source_owner_generation, "project copy source_owner_generation");
    const projectId = canonicalIdentifier(copy.project_id, "project copy project_id");
    if (!memberSet.has(sourceRevision)) invalid("project copy is outside the frozen source-revision set");
    if (selectedSources.has(sourceRevision)) invalid("AI Search project scope selected multiple copies for one source revision");
    if (!Number.isSafeInteger(copy.membership_generation) || copy.membership_generation < 1 ||
        copy.project_membership_id !== `project:${projectId}:generation:${copy.membership_generation}`) {
      invalid("AI Search project membership does not match its Core identity");
    }
    if (typeof copy.folder_prefix !== "string" || !PROJECT_FOLDER.test(copy.folder_prefix) ||
        new TextEncoder().encode(copy.folder_prefix).byteLength > MAX_INDEXED_STRING_BYTES) {
      invalid("AI Search project folder prefix is not canonical or exceeds 64 bytes");
    }
    if (seenFolders.has(copy.folder_prefix)) invalid("AI Search project folders are not source-unique");
    selectedSources.add(sourceRevision);
    selectedProjects.add(projectId);
    seenFolders.add(copy.folder_prefix);
    folders.push(copy.folder_prefix);
  }
  if (selectedProjects.size > MAX_PROJECT_IDS) {
    invalid("AI Search project scope exceeds the 256-project Core bound");
  }
  if (selectedSources.size !== members.length) {
    invalid("AI Search requires exactly one authorized project copy per frozen source revision");
  }
  folders.sort();

  const filter = Object.freeze({
    source_revision_ref: Object.freeze({ $in: Object.freeze(members) }),
    projection_generation: projectionGenerationMetadataValue,
    folder: Object.freeze({ $in: Object.freeze(folders) }),
  });
  assertFilterBudget(filter);
  return filter;
}
