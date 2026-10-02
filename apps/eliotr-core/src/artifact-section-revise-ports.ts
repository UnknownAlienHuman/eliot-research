import { z } from "zod";
import { ResolvedEvidenceSchema, VersionedRefSchema, type ResolvedEvidence, type VersionedRef } from "@eliotr/contracts";
import { canonicalJson, canonicalDigest } from "@eliotr/platform-cloudflare";
import { readReauthorizedArtifactDraftCowSnapshot, resolveReauthorizedArtifactEvidence, decodeArtifactDraftVerificationAny,
  type ArtifactCowHistoricalFreeze, type RunArtifactCowRevisionInput } from "@eliotr/cloudflare-research";
import type { createArtifactCowDraftMaterialization } from "@eliotr/cloudflare-research";
import { readArtifactCowHistoricalFreeze } from "@eliotr/cloudflare-research";
import type { ArtifactSectionReviseAttempt } from "@eliotr/cloudflare-workflows";
import { evidenceSha256Bytes, type NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";

type ArtifactCowParent = NonNullable<Awaited<ReturnType<typeof readReauthorizedArtifactDraftCowSnapshot>>> & { readonly freeze: ArtifactCowHistoricalFreeze["freeze"] };
const PackSchema = z.object({ pack_ref: VersionedRefSchema, scope_snapshot_ref: VersionedRefSchema,
  resolved_evidence: z.array(ResolvedEvidenceSchema).max(512),
  omitted_candidates: z.array(z.object({ candidate_id: z.string(), reason_code: z.string() }).strict()).max(512),
  trace_ref: VersionedRefSchema, total_utf8_bytes: z.number().int().nonnegative().max(8_388_608) }).strict();
const key = (ref: VersionedRef) => ref.id + ":" + ref.revision;
function deny(message: string): never { throw new HttpRequestError("ARTIFACT_SECTION_REVISE_STALE", 409, message); }

/** Bounded composition of the existing exact draft, freeze and citation readers. */
export async function createOwnerArtifactCowPorts(input: {
  readonly env: Env; readonly attempt: ArtifactSectionReviseAttempt; readonly navigation: NavigationReadAuthority;
  readonly materialization: Awaited<ReturnType<typeof createArtifactCowDraftMaterialization>>;
}) {
  const { env, attempt, navigation, materialization } = input;
  await materialization.requireCurrent();
  const authorization = await navigation.current();
  const snapshot = await readReauthorizedArtifactDraftCowSnapshot({ database: env.CORE_DB, work_bucket: env.WORK_BUCKET,
    artifact_ref: attempt.request.artifact_ref, access: navigation.access, reauthorization: { navigation, authorization } });
  if (snapshot === null || snapshot.revision.spec_digest !== attempt.request.spec_digest ||
      canonicalJson(snapshot.revision.evidence_freeze_ref) !== canonicalJson(attempt.request.evidence_freeze_ref)) deny("Exact COW parent changed");
  if (snapshot.spec.export_formats.some((format) => format !== "markdown")) {
    throw new HttpRequestError("ARTIFACT_SECTION_REVISE_UNAVAILABLE", 503, "Installed section revision export format is unavailable");
  }
  const historical = await readArtifactCowHistoricalFreeze({ database: env.CORE_DB, work_bucket: env.WORK_BUCKET,
    artifact_ref: attempt.request.artifact_ref, expected_freeze_ref: attempt.request.evidence_freeze_ref,
    expected_scope_snapshot_ref: snapshot.spec.scope_snapshot_ref });
  const parent: ArtifactCowParent = { ...snapshot, freeze: historical.freeze };
  const packs = new Map<string, z.infer<typeof PackSchema>>();
  const saved = new Map<string, ResolvedEvidence>();
  for (const section of parent.sections) {
    const ledger = parent.referenced_objects.find((object) => object.object_ref === section.section.evidence_ledger_ref && object.object_kind === "EVIDENCE_LEDGER");
    if (ledger === undefined) deny("Historical section ledger is unavailable");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(ledger.bytes);
    const pack = PackSchema.parse(JSON.parse(text));
    if (canonicalJson(pack) !== text || canonicalJson(pack.scope_snapshot_ref) !== canonicalJson(parent.spec.scope_snapshot_ref)) deny("Historical EvidencePack changed scope or bytes");
    for (const evidence of pack.resolved_evidence) {
      const frozen = historical.freeze.included_evidence.find((item) => key(item.handle_ref) === key(evidence.handle.handle_ref));
      if (frozen?.digest !== evidence.handle.excerpt_sha256 || canonicalJson(evidence.handle.scope_snapshot_ref) !== canonicalJson(pack.scope_snapshot_ref)) deny("Historical EvidencePack differs from freeze");
      const prior = saved.get(key(evidence.handle.handle_ref));
      if (prior !== undefined && canonicalJson(prior) !== canonicalJson(evidence)) deny("Historical evidence has conflicting provenance");
      saved.set(key(evidence.handle.handle_ref), evidence);
    }
    packs.set(section.section.contract_id, pack);
  }
  const resolve = async (ref: VersionedRef) => {
    await materialization.requireCurrent();
    const original = saved.get(key(ref));
    if (original === undefined) deny("Evidence is outside historical section ledgers");
    const fresh = await resolveReauthorizedArtifactEvidence({ database: env.CORE_DB, search_database: env.SEARCH_DB,
      evidence_bucket: env.EVIDENCE_BUCKET, access: navigation.access, current_navigation: navigation,
      current_authorization: authorization, original_handle_ref: ref,
      original_scope_snapshot_ref: parent.spec.scope_snapshot_ref, expected_excerpt_sha256: original.handle.excerpt_sha256 });
    if (canonicalJson(fresh.original_handle) !== canonicalJson(original.handle) || fresh.resolved.exact_excerpt !== original.exact_excerpt ||
        fresh.resolved.source_revision_content_sha256 !== original.source_revision_content_sha256 ||
        fresh.resolved.instruction_taint !== original.instruction_taint ||
        canonicalJson(fresh.resolved.allowed_effects) !== canonicalJson(original.allowed_effects)) deny("Current evidence differs from immutable historical bytes");
    await materialization.requireCurrent();
    return { original, fresh: fresh.resolved };
  };
  const targetPack = packs.get(attempt.request.section_id);
  if (targetPack === undefined) deny("Requested section EvidencePack is missing");
  const freshEvidence: ResolvedEvidence[] = [];
  for (const item of targetPack.resolved_evidence) freshEvidence.push((await resolve(item.handle.handle_ref)).fresh);
  const freshPackId = await canonicalDigest({ attempt_ref: attempt.attempt_ref, scope_snapshot_ref: attempt.request.scope_snapshot_ref,
    historical_pack_ref: targetPack.pack_ref, handles: freshEvidence.map((item) => item.handle.handle_ref) });
  const fresh_pack = { ...targetPack, pack_ref: { id: "artifact-cow-pack-" + freshPackId, revision: 1 },
    scope_snapshot_ref: attempt.request.scope_snapshot_ref, resolved_evidence: freshEvidence };
  const ports: RunArtifactCowRevisionInput["ports"] = {
    compile: async () => deny("Section revision cannot compile another artifact"),
    readExactParent: async (ref) => { await materialization.requireCurrent(); return key(ref) === key(parent.revision.artifact_ref) ? parent : null; },
    validateParentSection: async ({ section }) => {
      const pack = packs.get(section.section.contract_id);
      if (pack === undefined) deny("Reusable section EvidencePack is missing");
      for (const item of pack.resolved_evidence) await resolve(item.handle.handle_ref);
    },
    loadSectionEvidencePack: async ({ contract }) => {
      const pack = packs.get(contract.section_id);
      if (pack === undefined) deny("Section EvidencePack is missing");
      return pack;
    },
    validateCompiledSection: async ({ section }) => {
      const object = section.referenced_objects.find((item) => item.object_ref === section.section.verification_receipt_ref);
      if (object === undefined) deny("Revised section verification receipt is missing");
      const verified = (await decodeArtifactDraftVerificationAny(object.bytes)).record;
      if (verified.section_sha256 !== section.section.body_sha256 || canonicalJson(verified.freeze_ref) !== canonicalJson(parent.freeze.freeze_ref)) deny("Revised verification differs from immutable section/freeze");
      for (const item of verified.cited_evidence) await resolve(item.handle_ref);
    },
    assembleExports: async ({ spec, sections }) => {
      const text = "# " + spec.title + "\n\n" + sections.map((section) => {
        const contract = spec.section_contracts.find((item) => item.section_id === section.section.contract_id);
        if (contract === undefined) deny("Export section contract is missing");
        return "## " + contract.title + "\n\n" + new TextDecoder("utf-8", { fatal: true }).decode(section.bytes);
      }).join("\n\n") + "\n";
      const bytes = new TextEncoder().encode(text);
      const sha = await canonicalDigest({ text });
      const ref = "artifact-cow-markdown-" + sha;
      return { refs: { markdown: ref }, objects: [{ object_ref: ref, object_kind: "EXPORT", bytes,
        residency: { ...parent.manifest_residency, content_digest: { algorithm: "sha256", digest: await evidenceSha256Bytes(bytes) } } }] };
    },
    createIntent: materialization.createIntent,
    createResidency: async ({ template, bytes }) => ({ ...template,
      content_digest: { algorithm: "sha256", digest: await evidenceSha256Bytes(bytes) } }),
    prepare: materialization.prepare,
  };
  return { parent, historical, pack: targetPack, fresh_pack, ports,
    resolve_current_evidence: async (ref: VersionedRef) => (await resolve(ref)).original };
}
