import { assertErasureIdentifier, assertErasureText, erasureFail } from "./canonical.js";
import { readErasureRootIdentity } from "./empty-location-proof-authority.js";

export async function verifyEvidenceHandleRoot(database: D1Database, handleId: string, revision: number): Promise<void> {
  const row = await database.prepare(
    "SELECT source_revision_ref,source_namespace_id,source_owner_generation FROM evidence_handle " +
    "WHERE handle_id=?1 AND revision=?2 LIMIT 1",
  ).bind(handleId, revision).first<{
    readonly source_revision_ref: unknown;
    readonly source_namespace_id: unknown;
    readonly source_owner_generation: unknown;
  }>();
  if (row === null) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "evidence-handle root does not exist");
  const sourceRevisionRef = assertErasureIdentifier(row.source_revision_ref, "evidence-handle source revision");
  const root = await readErasureRootIdentity(database, sourceRevisionRef, false);
  if (
    assertErasureIdentifier(row.source_namespace_id, "evidence-handle namespace") !== root.source_namespace_id ||
    assertErasureIdentifier(row.source_owner_generation, "evidence-handle owner generation") !== root.source_owner_generation
  ) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "evidence-handle root no longer matches active source ownership");
}

export async function verifyScopeSnapshotRoots(database: D1Database, snapshotId: string, revision: number): Promise<void> {
  const row = await database.prepare(
    "SELECT member_source_revision_refs_json,source_owner_generations_json FROM scope_snapshot " +
    "WHERE snapshot_id=?1 AND revision=?2 LIMIT 1",
  ).bind(snapshotId, revision).first<{
    readonly member_source_revision_refs_json: unknown;
    readonly source_owner_generations_json: unknown;
  }>();
  if (row === null) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "scope-snapshot root does not exist");
  let members: unknown;
  let owners: unknown;
  try {
    members = JSON.parse(assertErasureText(row.member_source_revision_refs_json, "scope members JSON", 262_144)) as unknown;
    owners = JSON.parse(assertErasureText(row.source_owner_generations_json, "scope owner generations JSON", 262_144)) as unknown;
  } catch (cause) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "scope-snapshot root identity is malformed", false, cause);
  }
  if (!Array.isArray(members) || members.length > 10_000 ||
    members.some((value) => typeof value !== "string") ||
    typeof owners !== "object" || owners === null || Array.isArray(owners)) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "scope-snapshot root identity is incomplete");
  }
  const refs = members.map((value) => assertErasureIdentifier(value, "scope source revision"));
  const generations = owners as Record<string, unknown>;
  const ownerRefs = Object.keys(generations).sort();
  if (new Set(refs).size !== refs.length || ownerRefs.length !== refs.length ||
    refs.some((ref) => !ownerRefs.includes(ref))) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "scope-snapshot owner map does not exactly cover its source roots");
  }
  for (const ref of refs) {
    const root = await readErasureRootIdentity(database, ref, false);
    if (assertErasureIdentifier(generations[ref], "scope source owner generation") !== root.source_owner_generation) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "scope-snapshot source owner generation is stale");
    }
  }
}
