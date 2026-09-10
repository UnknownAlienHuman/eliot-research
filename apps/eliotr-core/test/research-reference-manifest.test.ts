import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalEvidenceJson,
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createNavigationReadAuthority,
  createR2EvidenceContentPort,
  evidenceSha256Bytes,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import type { LocatorCandidate, ObjectResidencyKey, ResolvedEvidence } from "@eliotr/contracts";
import { createD1ScopePorts, type RetrievalQueryAccess } from "@eliotr/retrieval";
import {
  buildAllowedReferenceManifest,
  type ReferenceManifestPolicyProfile,
} from "../../../packages/cloudflare-research/src/research-reference-manifest.js";
import {
  createResearchReferenceManifestStore,
  type ReferenceManifestStorageContext,
} from "../../../packages/cloudflare-research/src/research-reference-manifest-store.js";
import {
  importAndProject,
  prepareQ1Namespace,
  type Q1Namespace,
  type Q1Runtime,
} from "./retrieval-q1-fixture.js";
import { body, db, principal, run, runtime, setupOrientationDatabase } from "./orientation-fixture.js";
import { loadHeldResearchScope, retrieveWithHeldScope } from "../src/research-retrieval-composition.js";

const q1Runtime = env as unknown as Q1Runtime;
const access: RetrievalQueryAccess = {
  principal_ref: principal,
  client_class: "owner_pwa",
  credential_generation: "credential-v1",
};
const deployment = "test-generation";
const policy: ReferenceManifestPolicyProfile = {
  allowed_tool_definition_refs: ["tool-research-query"],
  allowed_verifier_refs: ["verifier-evidence-exact"],
  permitted_anchor_and_precision_ceilings: ["normalized_byte_range"],
  provider_and_policy_generations: { retrieval: "retrieval-v1", evidence: "evidence-v1" },
  permitted_acquisition_or_expansion_routes: ["frozen-scope-search"],
  disclosure_ceiling: "owner-only",
  allowed_use: ["research"],
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
};

async function addReadPolicy(world: Q1Namespace): Promise<void> {
  const decision = await db.prepare(
    "SELECT allowed_use_json, disclosure_ceiling FROM source_admission_decision WHERE source_revision_ref = ?1 LIMIT 1",
  ).bind(world.revision).first<{ readonly allowed_use_json: string; readonly disclosure_ceiling: string }>();
  if (decision === null) throw new Error("Missing Q1 admission decision");
  const now = new Date().toISOString();
  await db.prepare(
    "INSERT INTO scope_read_policy (source_namespace_id, principal_ref, client_class, policy_ref, generation, allowed_use_json, disclosure_ceiling, state, expires_at, created_at) VALUES (?1,?2,'owner_pwa',?3,1,?4,?5,'ACTIVE',?6,?7)",
  ).bind(world.namespace, principal, `manifest-read-${world.namespace}`, decision.allowed_use_json, decision.disclosure_ceiling,
    new Date(Date.now() + 86_400_000).toISOString(), now).run();
}

function request(sourceId: string, key: string): Request {
  return new Request("https://research.example/api/v1/research/run", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({
      query: "Reference manifest source",
      product: "RESEARCH",
      scope_expression: { kind: "SELECTED_SOURCES", source_ids: [sourceId] },
      literals: [], evidence_grade: "E1", budget_ref: "research-budget-v1", max_results: 8,
    }),
  });
}

function objectResidency(tag: string, contentDigest: string): ObjectResidencyKey {
  return {
    scope_domain_id: `manifest-scope-${tag}`,
    access_domain_id: `manifest-access-${tag}`,
    confidentiality_domain_id: `manifest-confidential-${tag}`,
    encryption_key_domain_id: `manifest-key-${tag}`,
    retention_domain_id: `manifest-retention-${tag}`,
    erasure_domain_id: `manifest-erasure-${tag}`,
    content_digest: { algorithm: "sha256", digest: contentDigest },
  };
}

function failureBucket(bucket: R2Bucket): R2Bucket {
  return new Proxy(bucket, {
    get(target, property, receiver) {
      if (property === "put") return async () => { throw new Error("controlled manifest R2 failure"); };
      return Reflect.get(target, property, receiver);
    },
  });
}

describe("research reference manifest over real D1/R2", () => {
  let world: Q1Namespace;
  let held: Awaited<ReturnType<typeof loadHeldResearchScope>>;
  let evidencePack: Awaited<ReturnType<typeof retrieveWithHeldScope>>["evidence_pack"];
  let navigation: NavigationReadAuthority;
  let resolver: ReturnType<typeof createCloudflareEvidenceResolver>;
  let sourceRef: string;
  let secondEvidence: ResolvedEvidence;

  beforeAll(async () => {
    await setupOrientationDatabase();
    world = {
      db,
      searchDb: q1Runtime.SEARCH_DB,
      runtime: q1Runtime,
      owner: principal,
      ...(await prepareQ1Namespace(q1Runtime, db, q1Runtime.SEARCH_DB, principal)),
    };
    await importAndProject(world);
    await addReadPolicy(world);
    const response = await run(request(`source-${world.namespace}`, "manifest-scope-run"));
    const payload = await body<{ readonly workflow_instance_id: string }>(response);
    expect(response.status, JSON.stringify(payload)).toBe(200);
    held = await loadHeldResearchScope(
      { CORE_DB: runtime.CORE_DB, SEARCH_DB: runtime.SEARCH_DB }, access,
      payload.data.workflow_instance_id, deployment,
    );
    const retrieval = await retrieveWithHeldScope(
      { CORE_DB: runtime.CORE_DB, SEARCH_DB: runtime.SEARCH_DB, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET },
      {
        access, scope_snapshot: held.scope_snapshot, raw_query: "Pinned", product: "FAST_SEARCH",
        literals: [], requested_limit: 8, deadline_ms: Date.now() + 30_000,
        idempotency_key: "manifest-evidence", signal: new AbortController().signal,
        profile: { version: "retrieval-scope-v1", max_sources: 64, max_results: 16 },
      },
    );
    evidencePack = retrieval.evidence_pack;
    const firstEvidence = evidencePack.resolved_evidence[0];
    if (firstEvidence === undefined) throw new Error("Missing projected evidence");
    sourceRef = firstEvidence.handle.source_revision_ref;
    const item = await q1Runtime.SEARCH_DB.prepare(
      "SELECT item_key, source_revision_ref, canonical_section_id, project_membership_ids_json, source_class, title, heading_path, document_context_header, section_text, normalized_offset_map_ref, content_sha256, instruction_taint, projection_generation, updated_at FROM projection_item WHERE source_revision_ref = ?1 AND active = 1 LIMIT 1",
    ).bind(sourceRef).first<{
      readonly item_key: string; readonly source_revision_ref: string; readonly canonical_section_id: string;
      readonly project_membership_ids_json: string; readonly source_class: string; readonly title: string;
      readonly heading_path: string; readonly document_context_header: string; readonly section_text: string;
      readonly normalized_offset_map_ref: string; readonly content_sha256: string; readonly instruction_taint: string;
      readonly projection_generation: string; readonly updated_at: string;
    }>();
    if (item === null) throw new Error("Missing projected item for second excerpt");
    const secondItem = { ...item, item_key: `manifest-second-${world.namespace}`, canonical_section_id: `${item.canonical_section_id}-excerpt` };
    await q1Runtime.SEARCH_DB.prepare(
      "INSERT INTO projection_item (item_key, source_revision_ref, canonical_section_id, project_membership_ids_json, source_class, title, heading_path, document_context_header, section_text, normalized_offset_map_ref, content_sha256, instruction_taint, projection_generation, active, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,1,?14)",
    ).bind(secondItem.item_key, secondItem.source_revision_ref, secondItem.canonical_section_id, secondItem.project_membership_ids_json,
      secondItem.source_class, secondItem.title, secondItem.heading_path, secondItem.document_context_header, secondItem.section_text,
      secondItem.normalized_offset_map_ref, secondItem.content_sha256, secondItem.instruction_taint, secondItem.projection_generation, secondItem.updated_at).run();
    await q1Runtime.SEARCH_DB.prepare(
      "INSERT INTO projection_span (item_key, source_revision_ref, normalized_start_byte, normalized_end_byte, precision_kind, projection_generation) VALUES (?1,?2,0,11,'normalized_bytes',?3)",
    ).bind(secondItem.item_key, sourceRef, secondItem.projection_generation).run();
    navigation = createNavigationReadAuthority({
      database: db,
      scope_snapshot: held.scope_snapshot,
      access,
      require_current: async (scope) => {
        await createD1ScopePorts(db, access).requireCurrentScope(scope);
        return scope;
      },
    });
    resolver = createCloudflareEvidenceResolver({
      authority: createD1EvidenceAuthorityPort({ core_database: db, search_database: q1Runtime.SEARCH_DB }),
      content: createR2EvidenceContentPort({ evidence_bucket: runtime.EVIDENCE_BUCKET }),
    });
    const candidate: LocatorCandidate = {
      candidate_id: secondItem.item_key, lane: "LEX", source_revision_ref: sourceRef,
      canonical_section_id: secondItem.canonical_section_id, preview: "", raw_score: 0.5, rank: 1,
      index_generation: secondItem.projection_generation,
      metadata: { item_key: secondItem.item_key, source_revision_ref: sourceRef, canonical_section_id: secondItem.canonical_section_id,
        projection_generation: secondItem.projection_generation, content_sha256: secondItem.content_sha256 },
    };
    secondEvidence = await resolver.resolveCandidate({
      candidate,
      scope_snapshot_ref: { id: held.scope_snapshot.snapshot_id, revision: held.scope_snapshot.revision },
      access,
    });
  }, 30_000);

  it("builds a deduplicated-source manifest from exact evidence and replays immutable D1/R2 bytes", async () => {
    const firstEvidence = evidencePack.resolved_evidence[0];
    if (firstEvidence === undefined) throw new Error("Missing first evidence");
    const evidence = [firstEvidence, secondEvidence];
    const pack = {
      ...evidencePack,
      resolved_evidence: evidence,
      total_utf8_bytes: evidence.reduce((sum, item) => sum + new TextEncoder().encode(item.exact_excerpt).byteLength, 0),
    };
    const build = (manifestId: string) => buildAllowedReferenceManifest({
      evidence_pack: pack,
      navigation,
      resolver,
      policy,
      manifest_ref: { id: manifestId, revision: 1 },
      model_route_ref: "model-route-reference",
      max_context_bytes: 64 * 1024,
    });
    const built = await build("reference-manifest");
    expect(built.manifest.allowed_source_revision_refs).toEqual([sourceRef]);
    expect(built.manifest.allowed_evidence_handle_refs).toHaveLength(2);
    expect(new Set(built.manifest.allowed_evidence_handle_refs.map((ref) => `${ref.id}:${ref.revision}`)).size).toBe(2);
    expect(built.resolved_evidence.map((item) => item.handle.source_revision_ref)).toEqual([sourceRef, sourceRef]);
    const manifestBytes = new TextEncoder().encode(canonicalEvidenceJson(built.manifest));
    const manifestResidency = objectResidency("success", await evidenceSha256Bytes(manifestBytes));
    const context: ReferenceManifestStorageContext = {
      principal_ref: access.principal_ref,
      credential_generation: access.credential_generation,
      scope_snapshot_ref: held.scope_snapshot_ref,
      manifest_residency_key: manifestResidency,
      policy_authority_ref: held.policy_authority_ref,
      authorization_receipt_ref: held.authorization_receipt_ref,
      scope_snapshot_digest: held.scope_snapshot.digest,
      pack_ref: pack.pack_ref,
      trace_ref: pack.trace_ref,
      stage_attempt_ref: "w3-reference-stage",
      stage_request_sha256: "c".repeat(64),
      created_at: new Date().toISOString(),
    };
    const store = createResearchReferenceManifestStore({ database: db, work_bucket: runtime.WORK_BUCKET, context, navigation });
    const first = await store.persist(built.manifest);
    expect(first).toMatchObject({ manifest_ref: built.manifest.manifest_ref, manifest_digest: built.manifest.manifest_digest, existed_identically: false });
    const object = await runtime.WORK_BUCKET.get(first.r2_key);
    expect(object).not.toBeNull();
    if (object === null) throw new Error("Manifest R2 object missing");
    const bytes = new Uint8Array(await object.arrayBuffer());
    expect(await evidenceSha256Bytes(bytes)).toBe(first.r2_content_sha256);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(canonicalEvidenceJson(built.manifest));
    expect(await store.get(built.manifest.manifest_ref)).toEqual(built.manifest);
    const replay = await store.persist(built.manifest);
    expect(replay).toMatchObject({ ...first, existed_identically: true });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM research_reference_manifest WHERE manifest_id = ?1 AND manifest_revision = 1").bind(built.manifest.manifest_ref.id).first<{ readonly n: number }>()).toEqual({ n: 1 });

    const failed = await build("reference-manifest-failure");
    const failedBytes = new TextEncoder().encode(canonicalEvidenceJson(failed.manifest));
    const failedContext = { ...context, manifest_residency_key: objectResidency("failure", await evidenceSha256Bytes(failedBytes)) };
    const failedStore = createResearchReferenceManifestStore({ database: db, work_bucket: failureBucket(runtime.WORK_BUCKET), context: failedContext, navigation });
    await expect(failedStore.persist(failed.manifest)).rejects.toMatchObject({ code: "REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN" });
    expect(await failedStore.readReceipt(failed.manifest.manifest_ref)).toBeNull();
    expect(await db.prepare("SELECT state FROM research_reference_manifest WHERE manifest_id = ?1 AND manifest_revision = 1").bind(failed.manifest.manifest_ref.id).first<{ readonly state: string }>()).toEqual({ state: "WRITING" });
  });

  it("checks current owner scope before R2 reads and again after continuation", async () => {
    const built = await buildAllowedReferenceManifest({
      evidence_pack: evidencePack,
      navigation,
      resolver,
      policy,
      manifest_ref: { id: "reference-currentness", revision: 1 },
      model_route_ref: "model-route-reference",
      max_context_bytes: 64 * 1024,
    });
    const bytes = new TextEncoder().encode(canonicalEvidenceJson(built.manifest));
    const context: ReferenceManifestStorageContext = {
      principal_ref: access.principal_ref, credential_generation: access.credential_generation,
      scope_snapshot_ref: held.scope_snapshot_ref, manifest_residency_key: objectResidency("currentness", await evidenceSha256Bytes(bytes)),
      policy_authority_ref: held.policy_authority_ref, authorization_receipt_ref: held.authorization_receipt_ref,
      scope_snapshot_digest: held.scope_snapshot.digest, pack_ref: evidencePack.pack_ref, trace_ref: evidencePack.trace_ref,
      stage_attempt_ref: "w3-currentness-stage", stage_request_sha256: "d".repeat(64), created_at: new Date().toISOString(),
    };
    const normal = createResearchReferenceManifestStore({ database: db, work_bucket: runtime.WORK_BUCKET, context, navigation });
    await normal.persist(built.manifest);
    let reads = 0;
    let revoked = false;
    const continuationBucket = new Proxy(runtime.WORK_BUCKET, {
      get(target, property, receiver) {
        if (property === "get") return async (...args: Parameters<R2Bucket["get"]>) => {
          reads += 1;
          const value = await Reflect.apply(Reflect.get(target, property, target) as (...callArgs: Parameters<R2Bucket["get"]>) => ReturnType<R2Bucket["get"]>, target, args);
          if (!revoked) {
            revoked = true;
            await db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE authorization_receipt_ref = ?1").bind(held.authorization_receipt_ref).run();
          }
          return value;
        };
        return Reflect.get(target, property, receiver);
      },
    });
    const continuationStore = createResearchReferenceManifestStore({ database: db, work_bucket: continuationBucket, context, navigation });
    await expect(continuationStore.get(built.manifest.manifest_ref)).rejects.toMatchObject({ code: "REFERENCE_MANIFEST_SCOPE_STALE" });
    expect(reads).toBe(1);
    await expect(continuationStore.get(built.manifest.manifest_ref)).rejects.toMatchObject({ code: "REFERENCE_MANIFEST_SCOPE_STALE" });
    expect(reads).toBe(1);
  });
});
