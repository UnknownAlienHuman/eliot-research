import { VersionedRefSchema, type EvidenceHandle, type ScopeSnapshot, type SourceCard, type VersionedRef } from "@eliotr/contracts";
import {
  NavigationError, extractNavigationSections, parseEvidenceHandleCandidate, sameVersionedRef,
  type NavigationStore, type SectionEvidenceHandleRequest,
} from "@eliotr/retrieval";
import { loadEvidenceHandle } from "./authority-load.js";
import { assertEvidenceIdentifier, evidenceSha256Bytes, evidenceUtf8Bytes } from "./canonical.js";
import {
  createNavigationReadAuthority, navigationSourceBindings, type D1NavigationStoreInput,
} from "./navigation-storage-authority.js";
import {
  NAVIGATION_BATCH_SIZE, NAVIGATION_READ_BYTES, NAVIGATION_ROW_BYTES,
  navigationArtifactIdentity, navigationStorageFailure, navigationStorageJson, navigationStorageLimit,
  parseNavigationArtifact, parseStoredNavigationJson, verifyNavigationIdentity,
  type NavigationArtifact, type NavigationArtifactKind,
} from "./navigation-storage-codec.js";

export type { D1NavigationStoreInput } from "./navigation-storage-authority.js";
export type { NavigationArtifactKind, NavigationArtifact } from "./navigation-storage-codec.js";
export interface D1NavigationStore extends NavigationStore {
  putArtifact(kind: NavigationArtifactKind, artifact: unknown): Promise<"CREATED" | "REPLAY">;
}
interface Row {
  readonly artifact_kind: NavigationArtifactKind;
  readonly subject_id: string;
  readonly subject_revision: number;
  readonly artifact_id: string;
  readonly artifact_revision: number;
  readonly body_digest: string;
  readonly body_json: string;
  readonly source_bindings_json: string;
}
interface Metadata extends Omit<Row, "body_json" | "source_bindings_json"> { readonly stored_bytes: number; }
type Bind = string | number | null;
const metadataColumns = "artifact_kind, subject_id, subject_revision, artifact_id, artifact_revision, body_digest";
const rowColumns = `${metadataColumns}, body_json, source_bindings_json`;
const digest = (body: string) => evidenceSha256Bytes(evidenceUtf8Bytes(body));
const reference = (value: VersionedRef) => VersionedRefSchema.parse(value);
function identifiers(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > NAVIGATION_BATCH_SIZE || new Set(values).size !== values.length) {
    navigationStorageFailure("invalid navigation selection");
  }
  return values.map((value) => assertEvidenceIdentifier(value, "navigation selection"));
}

/** One frozen scope and principal per store; no global mutable authorization or implicit grants. */
export function createD1NavigationStore(input: D1NavigationStoreInput): D1NavigationStore {
  const authority = createNavigationReadAuthority(input);
  const { database: db } = input;
  const scope = authority.scope;
  const base = "scope_snapshot_id = ?1 AND scope_snapshot_revision = ?2";
  const scopeValues: Bind[] = [scope.snapshot_id, scope.revision];

  async function fetchRows(where: string, values: readonly Bind[], maximum: number): Promise<readonly Row[]> {
    const suffix = ` FROM navigation_artifact WHERE ${base} AND ${where} ORDER BY artifact_id LIMIT ${maximum + 1}`;
    const meta = await db.prepare(`SELECT ${metadataColumns}, length(CAST(body_json AS BLOB)) + ` +
      `length(CAST(source_bindings_json AS BLOB)) AS stored_bytes${suffix}`).bind(...scopeValues, ...values).all<Metadata>();
    if (!meta.success || !Array.isArray(meta.results)) navigationStorageFailure("navigation metadata read failed");
    let bytes = 0;
    if (meta.results.length > maximum) navigationStorageFailure("ambiguous navigation artifact selection");
    for (const row of meta.results) {
      if (!Number.isSafeInteger(row.stored_bytes) || row.stored_bytes < 1 || row.stored_bytes > NAVIGATION_ROW_BYTES) navigationStorageLimit();
      bytes += row.stored_bytes;
      if (bytes > NAVIGATION_READ_BYTES) navigationStorageLimit();
    }
    if (!meta.results.length) return [];
    const result = await db.prepare(`SELECT ${rowColumns}${suffix}`).bind(...scopeValues, ...values).all<Row>();
    if (!result.success || !Array.isArray(result.results) || result.results.length !== meta.results.length) {
      navigationStorageFailure("navigation changed between metadata and payload readback");
    }
    for (let i = 0; i < result.results.length; i += 1) {
      const row = result.results[i]; const observed = meta.results[i];
      if (!row || !observed || ["artifact_kind", "subject_id", "subject_revision", "artifact_id", "artifact_revision", "body_digest"]
        .some((key) => row[key as keyof Metadata & keyof Row] !== observed[key as keyof Metadata])) {
        navigationStorageFailure("navigation readback identity drift");
      }
      const actualBytes = evidenceUtf8Bytes(row.body_json).byteLength + evidenceUtf8Bytes(row.source_bindings_json).byteLength;
      if (actualBytes !== observed.stored_bytes) navigationStorageFailure("navigation payload length drift");
    }
    return result.results;
  }

  async function cardsByRefs(refs: readonly VersionedRef[]): Promise<readonly SourceCard[]> {
    if (!Array.isArray(refs) || refs.length > NAVIGATION_BATCH_SIZE) navigationStorageLimit();
    const parsed = refs.map(reference);
    if (new Set(parsed.map((ref) => JSON.stringify(ref))).size !== parsed.length) navigationStorageFailure("duplicate card selection");
    const rows = await read("SOURCE_CARD", "EXISTS (SELECT 1 FROM json_each(?4) x WHERE " +
      "json_extract(x.value,'$.id') = artifact_id AND json_extract(x.value,'$.revision') = artifact_revision)",
    [JSON.stringify(parsed)], parsed.length);
    return rows.map((artifact) => {
      if (!("card_ref" in artifact)) return navigationStorageFailure("wrong card kind");
      return artifact;
    });
  }

  async function artifactSources(artifact: NavigationArtifact): Promise<readonly string[]> {
    if ("source_revision_ref" in artifact) return [artifact.source_revision_ref];
    if (!sameVersionedRef(artifact.scope_snapshot_ref, { id: scope.snapshot_id, revision: scope.revision })) {
      throw new NavigationError("NAVIGATION_SCOPE_MISMATCH", "Atlas belongs to another snapshot");
    }
    const scopeMembers = new Set(scope.member_source_revision_refs);
    function inspect(value: unknown, key = ""): void {
      if (key === "source_revision_ref") {
        if (typeof value !== "string" || !scopeMembers.has(value)) navigationStorageFailure("Atlas names a foreign source");
      }
      if (key.endsWith("source_revision_refs") || key === "degraded_source_refs") {
        if (!Array.isArray(value) || value.some((ref) => typeof ref !== "string" || !scopeMembers.has(ref))) {
          navigationStorageFailure("Atlas source annotations escape its scope");
        }
      }
      if (Array.isArray(value)) value.forEach((item) => inspect(item));
      else if (value !== null && typeof value === "object") Object.entries(value).forEach(([name, item]) => inspect(item, name));
    }
    inspect(artifact);
    const refs = [...new Map(artifact.nodes.flatMap((node) => node.source_card_refs)
      .map((ref) => [JSON.stringify(ref), ref])).values()];
    if (refs.length > 4096) navigationStorageLimit();
    const sources = new Set<string>();
    for (let start = 0; start < refs.length; start += NAVIGATION_BATCH_SIZE) {
      const chunk = refs.slice(start, start + NAVIGATION_BATCH_SIZE);
      const cards = await cardsByRefs(chunk);
      if (cards.length !== chunk.length) navigationStorageFailure("Atlas references missing persisted cards");
      cards.forEach((card) => sources.add(card.source_revision_ref));
    }
    return [...sources].sort();
  }

  async function checkArtifacts(artifacts: readonly NavigationArtifact[]): Promise<readonly string[]> {
    const sets: (readonly string[])[] = [];
    for (const artifact of artifacts) sets.push(await artifactSources(artifact));
    const refs = [...new Set(sets.flat())].sort();
    const grant = await authority.current();
    const sources = await authority.sources(refs, grant);
    const byRef = new Map(sources.map((source) => [source.source_revision_ref, source]));
    for (const artifact of artifacts) {
      const source = "source_revision_ref" in artifact ? byRef.get(artifact.source_revision_ref) : undefined;
      await verifyNavigationIdentity(artifact, source?.content_sha256);
    }
    // Re-read the grant AND sources after decoding/hash awaits, in bounded batches rather than per artifact.
    const afterGrant = await authority.current();
    const afterSources = await authority.sources(refs, afterGrant);
    const before = navigationStorageJson(await navigationSourceBindings(sources));
    const bindings = await navigationSourceBindings(afterSources);
    if (before !== navigationStorageJson(bindings) || navigationStorageJson(grant) !== navigationStorageJson(afterGrant)) {
      throw new NavigationError("NAVIGATION_SCOPE_NOT_CURRENT", "navigation authority changed during readback");
    }
    return sets.map((members) => {
      const selected = new Set(members);
      return navigationStorageJson(bindings.filter((binding) => selected.has(binding.source_revision_ref)));
    });
  }

  async function decode(row: Row): Promise<NavigationArtifact> {
    const parsed = parseStoredNavigationJson(row.body_json);
    const artifact = parseNavigationArtifact(row.artifact_kind, parsed);
    const identity = navigationArtifactIdentity(artifact);
    if (identity.ref.id !== row.artifact_id || identity.ref.revision !== row.artifact_revision ||
        identity.subject_id !== row.subject_id || identity.subject_revision !== row.subject_revision ||
        await digest(row.body_json) !== row.body_digest) navigationStorageFailure("stored navigation digest or identity mismatch");
    parseStoredNavigationJson(row.source_bindings_json);
    return artifact;
  }

  async function read(kind: NavigationArtifactKind, selection: string, values: readonly Bind[], maximum: number): Promise<readonly NavigationArtifact[]> {
    await authority.current();
    const rows = await fetchRows(`artifact_kind = ?3 AND ${selection}`, [kind, ...values], maximum);
    const artifacts: NavigationArtifact[] = [];
    for (const row of rows) {
      if (row.artifact_kind !== kind) navigationStorageFailure("unexpected navigation kind");
      artifacts.push(await decode(row));
    }
    const bindings = await checkArtifacts(artifacts);
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index]?.source_bindings_json !== bindings[index]) {
        throw new NavigationError("NAVIGATION_SCOPE_NOT_CURRENT", "navigation source authority changed since materialization");
      }
    }
    await authority.current();
    return artifacts;
  }

  async function putArtifact(kind: NavigationArtifactKind, raw: unknown): Promise<"CREATED" | "REPLAY"> {
    const artifact = parseNavigationArtifact(kind, raw);
    const identity = navigationArtifactIdentity(artifact);
    const body = navigationStorageJson(artifact);
    const bindings = (await checkArtifacts([artifact]))[0];
    if (bindings === undefined) navigationStorageFailure("missing source bindings");
    if (evidenceUtf8Bytes(body).byteLength + evidenceUtf8Bytes(bindings).byteLength > NAVIGATION_ROW_BYTES) navigationStorageLimit();
    const bodyDigest = await digest(body);
    const selection = "artifact_kind = ?3 AND subject_id = ?4 AND subject_revision = ?5";
    const values = [kind, identity.subject_id, identity.subject_revision];
    const exactReadback = async () => {
      const rows = await fetchRows(selection, values, 1);
      const row = rows[0];
      if (!row) return false;
      const storedArtifact = await decode(row);
      if ((await checkArtifacts([storedArtifact]))[0] !== row.source_bindings_json) {
        throw new NavigationError("NAVIGATION_SCOPE_NOT_CURRENT", "stored navigation source authority changed");
      }
      if (row.body_json !== body || row.source_bindings_json !== bindings) {
        throw new NavigationError("NAVIGATION_ARTIFACT_INVALID", "immutable navigation slot occupied by different content; re-freeze scope");
      }
      await authority.current();
      return true;
    };
    if (await exactReadback()) return "REPLAY";
    const grant = await authority.current();
    const now = authority.timestamp();
    let inserted: boolean;
    try {
      const row = await db.prepare(
        "INSERT INTO navigation_artifact (scope_snapshot_id, scope_snapshot_revision, artifact_kind, subject_id, subject_revision, " +
        "artifact_id, artifact_revision, body_digest, body_json, source_bindings_json, created_at) " +
        "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11 FROM scope_access_grant g JOIN scope_snapshot s " +
        "ON s.snapshot_id = g.snapshot_id AND s.revision = g.snapshot_revision " +
        "WHERE g.snapshot_id=?1 AND g.snapshot_revision=?2 AND g.authorization_receipt_ref=?12 " +
        "AND g.principal_ref=?13 AND g.client_class=?14 AND g.credential_generation=?15 " +
        "AND g.state='ACTIVE' AND julianday(g.expires_at)>julianday(?11) AND s.invalidated_at IS NULL " +
        "AND julianday(s.expires_at)>julianday(?11) AND s.snapshot_digest=?16 " +
        "AND g.policy_authority_ref=s.policy_authority_ref AND g.allowed_use_json=?17 AND g.disclosure_ceiling=?18 " +
        "ON CONFLICT DO NOTHING RETURNING artifact_id"
      ).bind(...scopeValues, kind, identity.subject_id, identity.subject_revision, identity.ref.id, identity.ref.revision,
        bodyDigest, body, bindings, now, grant.authorization_receipt_ref, authority.access.principal_ref,
        authority.access.client_class, authority.access.credential_generation, scope.digest,
        JSON.stringify(grant.allowed_use), grant.disclosure_ceiling).first();
      inserted = row !== null;
    } catch {
      // A lost acknowledgement never authorizes another write: only exact durable readback can settle it.
      if (await exactReadback()) return "REPLAY";
      throw new NavigationError("NAVIGATION_STORE_FAILED", "navigation mutation unresolved; no automatic retry");
    }
    if (!await exactReadback()) throw new NavigationError("NAVIGATION_STORE_FAILED", "navigation write lacks exact durable readback");
    return inserted ? "CREATED" : "REPLAY";
  }

  async function getEvidenceHandleForSection(request: SectionEvidenceHandleRequest): Promise<EvidenceHandle | null> {
    reference(request.scope_snapshot_ref); assertEvidenceIdentifier(request.section_ref, "navigation section");
    if (!sameVersionedRef(request.scope_snapshot_ref, { id: scope.snapshot_id, revision: scope.revision })) {
      throw new NavigationError("NAVIGATION_SCOPE_MISMATCH", "section belongs to another scope");
    }
    const maps = await bySource("DOCUMENT_MAP", [request.source_revision_ref]);
    const map = maps[0];
    if (!map || !("map_ref" in map)) return null;
    const section = extractNavigationSections(map).find((entry) => entry.section_ref === request.section_ref);
    if (!section || section.normalized_start_byte === undefined || section.normalized_end_byte === undefined) return null;
    const handles = await db.prepare("SELECT handle_id, revision FROM evidence_handle WHERE scope_snapshot_id=?1 AND " +
      "scope_snapshot_revision=?2 AND source_revision_ref=?3 AND terminal_state='LIVE' AND " +
      "(expires_at IS NULL OR julianday(expires_at)>julianday(?4)) AND json_extract(anchor_json,'$.kind')='normalized_byte_range' " +
      "AND json_extract(anchor_json,'$.start')=?5 AND json_extract(anchor_json,'$.end')=?6 ORDER BY handle_id, revision LIMIT 2")
      .bind(...scopeValues, request.source_revision_ref, authority.timestamp(), section.normalized_start_byte, section.normalized_end_byte)
      .all<{ handle_id: string; revision: number }>();
    if (!handles.success || handles.results.length > 1) navigationStorageFailure("ambiguous section evidence handle");
    const ref = handles.results[0];
    const rawHandle = ref ? await loadEvidenceHandle(db, { id: ref.handle_id, revision: ref.revision }) : null;
    let handle: EvidenceHandle | null = null;
    if (rawHandle) {
      handle = parseEvidenceHandleCandidate(rawHandle, request, section);
      const grant = await authority.current();
      const [source] = await authority.sources([request.source_revision_ref], grant);
      if (!source || handle.source_owner_generation !== source.source_owner_generation || handle.source_namespace_id !== source.source_namespace_id ||
          handle.object_residency_key_digest !== source.object_residency_key_digest ||
          (handle.expires_at !== undefined && Date.parse(handle.expires_at) <= Date.parse(authority.timestamp()))) {
        navigationStorageFailure("stale section evidence handle");
      }
    }
    await authority.current();
    return handle;
  }
  async function bySource(kind: NavigationArtifactKind, refs: readonly string[]): Promise<readonly NavigationArtifact[]> {
    const selected = identifiers(refs);
    selected.forEach((ref) => {
      if (!scope.member_source_revision_refs.includes(ref)) throw new NavigationError("NAVIGATION_SCOPE_MISMATCH", "selection outside snapshot");
    });
    return read(kind, "subject_id IN (SELECT value FROM json_each(?4)) AND subject_revision=1", [JSON.stringify(selected)], selected.length);
  }
  // Sanitize transport failures; preserve typed domain failures without reflecting database contents.
  const guarded = <Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) => async (...args: Args): Promise<Result> => {
    try { return await operation(...args); }
    catch (error) {
      if (error instanceof NavigationError) throw error;
      throw new NavigationError("NAVIGATION_STORE_FAILED", "navigation persistence or authorization unavailable");
    }
  };
  return {
    putArtifact: guarded(putArtifact),
    requireCurrentScopeSnapshot: guarded(async (requested: ScopeSnapshot) => {
      await authority.current(requested); return JSON.parse(JSON.stringify(scope)) as ScopeSnapshot;
    }),
    getSourceCards: guarded((refs: readonly string[]) => bySource("SOURCE_CARD", refs)),
    getDocumentMaps: guarded((refs: readonly string[]) => bySource("DOCUMENT_MAP", refs)),
    getSourceCardsByRefs: guarded(cardsByRefs),
    getProjectAtlas: guarded(async (ref: VersionedRef) => {
      const parsed = reference(ref);
      return (await read("PROJECT_ATLAS", "subject_id=?4 AND subject_revision=?5", [parsed.id, parsed.revision], 1))[0] ?? null;
    }),
    getEvidenceHandleForSection: guarded(getEvidenceHandleForSection),
  };
}
