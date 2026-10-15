/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopeSnapshot } from "@eliotr/contracts";
import type { RetrievalQueryPorts } from "@eliotr/retrieval";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import type * as RetrievalModule from "@eliotr/retrieval";
import type * as NavigationModule from "@eliotr/cloudflare-navigation";
import {
  AI_SEARCH_PRIMARY_NAMESPACE,
  AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
  aiSearchPhysicalProfileDigest,
  createD1AiSearchGenerationRegistryStore,
  createD1ManagedRequiredSetPort,
  createAiSearchGenerationRegistryService,
  enumerateManagedRequiredSet,
  projectionDigest,
  projectionSha256Utf8,
  revalidateFrozenManagedTargetSelectionV2,
  resolveAiSearchManagedSearchAuthority,
  resolveManagedTargetSelectionV2,
  stableProjectionId,
  type AiSearchManagedSearchAuthority,
} from "@eliotr/cloudflare-projection";
import type { ManagedGenerationPromotionEvidenceAuthorityPort } from "@eliotr/cloudflare-projection/ai-search";
import type { ProjectCopyMembershipFact, resolveProjectCopyScope } from "@eliotr/cloudflare-navigation";
import { createNativeTargetRegistryFixture } from "../../../apps/eliotr-core/test/managed-target-registry-fixture.js";
import { retrieveWithHeldScope, type HeldScopeRetrievalInput } from "../src/research-retrieval-composition.js";
import {
  resolveManagedTargetSelectionV2 as resolveOwnerSelection,
  ManagedSearchProductSelectionError,
} from "../../../apps/eliotr-core/src/managed-search-product-selection.js";
import { registryFence } from "../../../apps/eliotr-core/src/managed-target-manifest-registry-fence.js";

const probes = vi.hoisted(() => ({
  copies: [] as readonly ProjectCopyMembershipFact[],
  scopes: [] as Awaited<ReturnType<typeof resolveProjectCopyScope>>[],
  current: vi.fn(async () => undefined),
}));

// Drive the real caller's SEM lane while isolating unrelated admission, result
// persistence and evidence resolution. Scope currentness and atom/required-set
// facts are explicit fixture inputs; the actual scope fold validates them.
vi.mock("@eliotr/retrieval", async original => {
  const actual = await original<typeof RetrievalModule>();
  return {
    ...actual,
    createD1ScopePorts: () => ({ requireCurrentScope: probes.current }),
    createD1ScopeProfilePort: () => ({ recordBinding: async () => undefined }),
    createRetrievalQueryService: (ports: RetrievalQueryPorts) => ({
      async query(input: { request: Parameters<ReturnType<typeof actual.createSemLaneExecutor>["execute"]>[1] }) {
        const sem = ports.lanes.executorFor("SEM");
        if (sem === null) throw new Error("actual retrieval composition omitted SEM");
        await sem.execute("SEM", input.request);
        return {};
      },
    }),
  };
});

vi.mock("@eliotr/cloudflare-navigation", async original => {
  const actual = await original<typeof NavigationModule>();
  return {
    ...actual,
    createD1ProjectCopyScopeResolver: (input: Parameters<typeof actual.createD1ProjectCopyScopeResolver>[0]) =>
      async (request: Parameters<ReturnType<typeof actual.createD1ProjectCopyScopeResolver>>[0], active: AiSearchManagedSearchAuthority) => {
        if (input.resolve_selection === undefined) throw new Error("serving caller omitted resolve_selection");
        const selection = await input.resolve_selection(active);
        const target = {
          namespace: active.namespace, managed_instance_id: active.instance_id,
          managed_generation: active.index_generation, target_profile_identity_sha256: active.target_profile_identity_sha256,
        };
        const scope = await actual.resolveProjectCopyScope({
          scope_snapshot: request.scope_snapshot, observed_at: request.scope_snapshot.created_at,
          target, selection, require_current_scope: input.require_current_scope,
          resolve_atom: async () => ({
            atom_generation_ref: "project-membership-current",
            members: request.scope_snapshot.member_source_revision_refs.map(source_revision_ref => ({
              source_revision_ref, source_owner_generation: "owner-1", policy_closure_ref: "policy-closure-1",
            })),
          }),
          load_required_set: async (_target, as_of, _refs, requestedSelection) => {
            if (requestedSelection?.decision_version !== 2) throw new Error("serving caller selected V1 fallback");
            return {
              protocol: "eliotr.managed-required-project-revisions.v3", target, as_of,
              target_selection: requestedSelection, assigned_project_count: 1,
              project_revision_copy_count: probes.copies.length, page_count: 1,
              required_set_digest: "a".repeat(64), copies: probes.copies,
              target_fence: {
                protocol: "eliotr.managed-required-set-target-fence.v2", digest: "b".repeat(64),
                target_selection_sha256: await projectionDigest(requestedSelection),
                assignment_heads_sha256: "c".repeat(64), required_set_sha256: "a".repeat(64),
                page_provenance_sha256: "d".repeat(64), assigned_project_count: 1,
                project_revision_copy_count: probes.copies.length, page_count: 1,
              },
            };
          },
        });
        probes.scopes.push(scope);
        return scope;
      },
  };
});

const databases: DatabaseSync[] = [];
function nativeD1(database: DatabaseSync, beforeRead: () => Promise<void> = async () => undefined): D1Database {
  function statement(sql: string, values: readonly SQLInputValue[] = []): D1PreparedStatement {
    const prepared = () => database.prepare(sql);
    const bindings = Object.fromEntries(values.map((value, index) => [String(index + 1), value]));
    return {
      bind: (...bound: SQLInputValue[]) => statement(sql, bound),
      async first(column?: string) {
        if (sql.includes("FROM ai_search_generation_registry ")) await beforeRead();
        const row = prepared().get(bindings) ?? null;
        return column === undefined ? row : row?.[column] ?? null;
      },
      async all() { return { success: true, results: prepared().all(bindings) }; },
      async run() { const result = prepared().run(bindings); return { success: true, results: [], meta: { changes: Number(result.changes) } }; },
    } as unknown as D1PreparedStatement;
  }
  return {
    prepare: (sql: string) => statement(sql),
    async batch(statements: D1PreparedStatement[]) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const item of statements) results.push(await item.all());
        database.exec("COMMIT");
        return results;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
}

async function world(stageB = true) {
  const search = new DatabaseSync(":memory:");
  databases.push(search);
  const migrations = new URL("../../../infra/d1/search/migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) {
    search.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  let readHook: () => Promise<void> = async () => undefined;
  const searchBinding = nativeD1(search, () => readHook());
  const objects = new Map<string, string>();
  const bucket = {
    async put(key: string, bytes: string) { objects.set(key, bytes); },
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes === undefined ? null : { text: async () => bytes, json: async () => JSON.parse(bytes) as unknown };
    },
  } as unknown as R2Bucket;
  const fixture = createNativeTargetRegistryFixture(searchBinding, bucket);
  const a = AI_SEARCH_PRIMARY_PROJECTION_PROFILE.generation;
  const b = "serving-generation-b";
  await fixture.declare(AI_SEARCH_PRIMARY_PROJECTION_PROFILE);
  await fixture.registry.qualify(AI_SEARCH_PRIMARY_NAMESPACE, { generation: a });
  await fixture.registry.promote(AI_SEARCH_PRIMARY_NAMESPACE, {
    expected_active_head_generation: null, target_generation: a, promoted_at: new Date().toISOString(),
  });
  if (stageB) {
    await fixture.declare({ ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE, generation: b });
    await fixture.registry.qualify(AI_SEARCH_PRIMARY_NAMESPACE, { generation: b });
  }
  const rotate = () => fixture.registry.promote(AI_SEARCH_PRIMARY_NAMESPACE, {
    expected_active_head_generation: a, target_generation: b, promoted_at: new Date().toISOString(),
  });
  const searchCall = vi.fn(async () => ({ query_kind: "text", search_query: "needle", chunks: [] }));
  const unexpectedProviderOperation = vi.fn(async () => { throw new Error("unexpected provider operation"); });
  const get = vi.fn(() => ({ search: searchCall, items: {
    get: unexpectedProviderOperation, createOrUpdate: unexpectedProviderOperation,
    uploadAndPoll: unexpectedProviderOperation, delete: unexpectedProviderOperation,
  } }));
  const namespace = {
    get, list: unexpectedProviderOperation, create: unexpectedProviderOperation,
    update: unexpectedProviderOperation, search: unexpectedProviderOperation,
  } satisfies AiSearchNamespaceLike;
  const input: HeldScopeRetrievalInput = {
    access: { principal_ref: "owner-1", client_class: "owner_pwa", credential_generation: "credential-1" },
    scope_snapshot: scopeFixture(), raw_query: "needle", product: "LOCATE", literals: [],
    requested_limit: 1, deadline_ms: Date.now() + 60_000, idempotency_key: "serving-selection",
    signal: new AbortController().signal,
    profile: { version: "serving-fixture-v1", max_sources: 64, max_results: 10 },
  };
  const env = { CORE_DB: searchBinding, SEARCH_DB: searchBinding, EVIDENCE_BUCKET: bucket, AI_SEARCH: namespace };
  return { fixture, bucket, searchBinding, searchCall, get, env, input, a, b, rotate, hook: (fn: () => Promise<void>) => { readHook = fn; } };
}

function scopeFixture(): ScopeSnapshot {
  return {
    snapshot_id: "scope-serving", revision: 1, resolved_scope_expression: { kind: "PROJECT", project_id: "project-1" },
    participant_generations: {}, member_source_revision_refs: ["revision-1"], source_owner_generations: { "revision-1": "owner-1" },
    policy_authority_ref: "policy-1", disclosure_closure_digest: "e".repeat(64), purge_ledger_revision: 0,
    digest: "f".repeat(64), created_at: "2026-10-14T12:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z",
  };
}

async function membership(version: 1 | 2): Promise<ProjectCopyMembershipFact> {
  const membership_id = JSON.stringify(["project-1", "source-1"]);
  const stable = await stableProjectionId("project-membership", membership_id);
  const legacy = version === 1 ? "project:project-1:generation:1" : null;
  return {
    source_id: "source-1", source_revision_ref: "revision-1", source_owner_generation: "owner-1", project_id: "project-1",
    project_membership_id: legacy ?? stable, stable_project_membership_id: stable, legacy_project_membership_id: legacy,
    project_membership_identity_version: version, membership_id, membership_revision: 2,
    membership_generation: 1, project_membership_generation: 3, assignment_decision_version: version,
  };
}

beforeEach(() => { probes.copies = []; probes.scopes.length = 0; probes.current.mockClear(); });
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("research serving selection V2", () => {
  it("shares reviewed ACTIVE/SHADOW selection with Core and preserves owner HTTP errors", async () => {
    const w = await world();
    const active = await resolveManagedTargetSelectionV2(w.searchBinding, "ACTIVE");
    expect(await resolveOwnerSelection(w.searchBinding, "ACTIVE")).toEqual(active);
    expect(active.target.target_profile_identity_sha256).toBe(await aiSearchPhysicalProfileDigest(AI_SEARCH_PRIMARY_PROJECTION_PROFILE));
    expect((await resolveOwnerSelection(w.searchBinding, "SHADOW", w.b)).target.managed_generation).toBe(w.b);
    await expect(resolveOwnerSelection(w.searchBinding, "SHADOW", ""))
      .rejects.toBeInstanceOf(ManagedSearchProductSelectionError);
    await expect(resolveOwnerSelection(w.searchBinding, "SHADOW", ""))
      .rejects.toMatchObject({ code: "MANAGED_SEARCH_PRODUCT_GENERATION_NOT_FOUND" });
  });

  it("bootstraps undeclared B from frozen V2 Core owners and an R2-backed desired manifest", async () => {
    const w = await world(false);
    const before = await w.fixture.registry.read(AI_SEARCH_PRIMARY_NAMESPACE);
    const captured = await resolveManagedTargetSelectionV2(w.searchBinding, "SHADOW", w.b);
    expect(captured.target.managed_generation).toBe(w.b);
    expect(captured.registry_revision).toBe(before?.artifact.revision);
    expect(captured.registry_artifact_sha256).toBe(before?.artifact_sha256);
    expect((await registryFence(before, captured.target, AI_SEARCH_PRIMARY_PROJECTION_PROFILE)).generation_state)
      .toBe("UNDECLARED");
    expect(await w.fixture.registry.read(AI_SEARCH_PRIMARY_NAMESPACE)).toEqual(before);
    expect((await resolveManagedTargetSelectionV2(w.searchBinding, "ACTIVE")).target.managed_generation).toBe(w.a);
    await expect(resolveManagedTargetSelectionV2(w.searchBinding, "ACTIVE", w.b))
      .rejects.toMatchObject({ code: "MANAGED_SEARCH_PRODUCT_GENERATION_NOT_FOUND" });

    const core = new DatabaseSync(":memory:");
    databases.push(core);
    const migrations = new URL("../../../infra/d1/core/migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) {
      core.exec(readFileSync(new URL(name, migrations), "utf8"));
    }
    for (const project of ["opted-in", "disabled-by-default"]) {
      core.prepare("INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
        "default_model_profile_ref,default_depth_profile_ref,generation,membership_generation,created_at) " +
        "VALUES (?,?,'private','retention-1','source-policy-1','model-1','depth-1',1,1,'2026-10-14T12:00:00.000Z')")
        .run(project, project);
      core.prepare("INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) " +
        "VALUES (?,'owner-1','deployment-1','2026-10-14T12:00:00.000Z','2026-10-14T12:00:00.000Z')").run(project);
    }
    core.prepare("INSERT INTO managed_target_assignment_event(project_id,event_revision,expected_event_revision,event_kind," +
      "project_generation,project_owner_principal_ref,target_namespace,managed_instance_id,managed_generation," +
      "target_profile_identity_sha256,previous_assignment_revision,actor_kind,actor_principal_ref,authorization_receipt_ref," +
      "created_at,decision_version,selection_mode,product_alias) VALUES ('opted-in',1,0,'ASSIGN',1,'owner-1',?,?,?,?,NULL," +
      "'OWNER','owner-1','explicit-opt-in-receipt','2026-10-14T12:00:00.000Z',2,'STABLE_PHYSICAL_PROFILE_V2','primary')")
      .run(captured.target.namespace, captured.target.managed_instance_id, w.a, captured.target.target_profile_identity_sha256);
    const coreBinding = nativeD1(core);
    const coreNow = () => {
      const value = core.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS checked_at").get()?.checked_at;
      if (typeof value !== "string") throw new Error("trusted fixture Core clock is unavailable");
      return value;
    };
    let currentCoreReads = 0;
    const currentCore = async () => {
      currentCoreReads += 1;
      return enumerateManagedRequiredSet(createD1ManagedRequiredSetPort(coreBinding), {
        target: captured.target, selection: captured, as_of: coreNow(),
        on_copy: () => { throw new Error("empty opted-in projects cannot fabricate provider items"); },
      });
    };
    const required = await currentCore();
    expect(required.assigned_project_count).toBe(1);
    expect(required.project_revision_copy_count).toBe(0);
    const emptySet = await projectionDigest([]);
    const treeJson = JSON.stringify([]);
    const treeSha = await projectionSha256Utf8(treeJson);
    const treeRef = `planned-fixture/${treeSha}.json`;
    await w.bucket.put(treeRef, treeJson);
    // Declaration-only fixture: counts come from actual migrated Core, and
    // readers dereference the stored bytes. No B qualification is supplied.
    const root = {
      protocol: "eliotr.managed-target-desired-items.v3", copy_layout: "PROJECT_COPY_V2",
      target: captured.target, target_selection: captured, as_of: required.as_of, target_fence: required.target_fence,
      registry_revision_before: captured.registry_revision, registry_revision_after: captured.registry_revision,
      assigned_project_count: required.assigned_project_count, project_revision_copy_count: required.project_revision_copy_count,
      desired_item_count: required.project_revision_copy_count, desired_item_set_digest: emptySet,
      eligibility_digest: emptySet, required_set_digest: required.required_set_digest, source_authority_digest: emptySet,
      canonical_source_summary: {
        protocol: "eliotr.managed-target-canonical-source-summary.v1", canonical_projection_generation_count: 0,
        canonical_section_count: 0, canonical_source_set_sha256: emptySet, canonical_section_set_sha256: emptySet,
      },
      provider_copy_summary: {
        protocol: "eliotr.managed-target-provider-copy-summary.v1", provider_copy_count: required.project_revision_copy_count,
        provider_copy_set_sha256: emptySet, provider_item_count: required.project_revision_copy_count, provider_item_set_sha256: emptySet,
      },
      manifest_tree_ref: treeRef, manifest_tree_sha256: treeSha,
    };
    const rootJson = JSON.stringify(root);
    const rootSha = await projectionSha256Utf8(rootJson);
    const rootRef = `planned-fixture/${rootSha}.json`;
    await w.bucket.put(rootRef, rootJson);
    const readDesiredManifest: ManagedGenerationPromotionEvidenceAuthorityPort["readDesiredManifest"] = async target => {
      expect(target).toEqual(captured.target);
      const snapshot = await w.fixture.registry.read(AI_SEARCH_PRIMARY_NAMESPACE);
      const registered = snapshot?.artifact.registry.generations.some(record => record.generation === w.b);
      if (registered) expect(await revalidateFrozenManagedTargetSelectionV2(w.searchBinding, captured)).toBe(captured);
      else expect((await registryFence(snapshot, target, AI_SEARCH_PRIMARY_PROJECTION_PROFILE)).generation_state).toBe("UNDECLARED");
      const fresh = await currentCore();
      expect(fresh.target_fence.assignment_heads_sha256).toBe(required.target_fence.assignment_heads_sha256);
      expect(fresh.assigned_project_count).toBe(root.assigned_project_count);
      expect(fresh.project_revision_copy_count).toBe(root.project_revision_copy_count);
      const object = await w.bucket.get(rootRef);
      if (object === null) throw new Error("desired manifest readback is missing");
      const bytes = await object.text();
      expect(await projectionSha256Utf8(bytes)).toBe(rootSha);
      const tree = await w.bucket.get(treeRef);
      if (tree === null) throw new Error("empty desired manifest tree is missing");
      expect(await projectionSha256Utf8(await tree.text())).toBe(treeSha);
      return { ...JSON.parse(bytes), manifest_ref: rootRef, manifest_sha256: rootSha, manifest_size_bytes: new TextEncoder().encode(bytes).byteLength };
    };
    const unavailable = async (): Promise<never> => { throw new Error("declaration cannot claim qualification, provider inventory or writer hold"); };
    const authority: ManagedGenerationPromotionEvidenceAuthorityPort = {
      readDesiredManifest, readCurrentEvidence: unavailable, readFreshCurrentAuthority: unavailable,
      runWithTargetWriterDrain: unavailable, assertTargetWriterDrainHold: unavailable,
      reconcileTargetWriterDrain: unavailable, readGenerationArchiveAuthorization: unavailable,
    };
    const registry = createAiSearchGenerationRegistryService(createD1AiSearchGenerationRegistryStore(w.searchBinding), { promotion_evidence: authority });
    await registry.declare({ namespace: captured.target.namespace, generation: w.b, profile: AI_SEARCH_PRIMARY_PROJECTION_PROFILE, declared_at: coreNow() });
    const declared = await registry.read(AI_SEARCH_PRIMARY_NAMESPACE);
    expect(declared?.artifact.registry.generations.find(record => record.generation === w.b))
      .toMatchObject({ state: "DECLARED", expected_item_count: required.project_revision_copy_count });
    expect(declared?.artifact.revision).toBeGreaterThan(captured.registry_revision);
    const reread = await readDesiredManifest(captured.target);
    expect(reread).toMatchObject({ target_selection: captured, registry_revision_before: captured.registry_revision, registry_revision_after: captured.registry_revision });
    expect(currentCoreReads).toBeGreaterThanOrEqual(3);
    expect(w.get).not.toHaveBeenCalled();
  });

  it("retains the captured SHADOW receipt through a qualified registry promotion", async () => {
    const w = await world();
    const captured = await resolveManagedTargetSelectionV2(w.searchBinding, "SHADOW", w.b);
    const capturedJson = JSON.stringify(captured);
    expect(await revalidateFrozenManagedTargetSelectionV2(w.searchBinding, captured)).toBe(captured);
    await w.rotate();
    const current = await w.fixture.registry.read(AI_SEARCH_PRIMARY_NAMESPACE);
    expect(current?.artifact.revision).toBeGreaterThan(captured.registry_revision);
    expect(current?.artifact_sha256).not.toBe(captured.registry_artifact_sha256);
    expect(await revalidateFrozenManagedTargetSelectionV2(w.searchBinding, captured)).toBe(captured);
    expect(JSON.stringify(captured)).toBe(capturedJson);
    await expect(revalidateFrozenManagedTargetSelectionV2(w.searchBinding, {
      ...captured, target: { ...captured.target, target_profile_identity_sha256: "0".repeat(64) },
    })).rejects.toMatchObject({ code: "MANAGED_SEARCH_PRODUCT_PROFILE_MISMATCH" });
    expect(w.get).not.toHaveBeenCalled();
  });

  it("rejects a declared B on a foreign physical instance instead of planning around it", async () => {
    const w = await world(false);
    await w.fixture.declare({ ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE, id: "foreign-instance", generation: w.b });
    await expect(resolveManagedTargetSelectionV2(w.searchBinding, "SHADOW", w.b))
      .rejects.toMatchObject({ code: "MANAGED_SEARCH_PRODUCT_PROFILE_MISMATCH" });
    expect(w.get).not.toHaveBeenCalled();
  });

  it("passes ACTIVE selection through the actual serving caller for an exact V1 row", async () => {
    const w = await world();
    probes.copies = [await membership(1)];
    await retrieveWithHeldScope(w.env, w.input);
    expect(w.searchCall).toHaveBeenCalledTimes(1);
    expect(probes.scopes[0]).toMatchObject({
      layout: "PROJECT_COPY_V2", target_selection: { purpose: "ACTIVE", target: { managed_generation: w.a } },
      copies: [{ membership_identity_version: 1, legacy_project_membership_id: "project:project-1:generation:1" }],
    });
  });

  it("retains explicit V2 membership selection across qualified A-to-B rotation in the actual caller", async () => {
    const w = await world();
    probes.copies = [await membership(2)];
    await retrieveWithHeldScope(w.env, w.input);
    await w.rotate();
    await retrieveWithHeldScope(w.env, { ...w.input, idempotency_key: "serving-selection-b" });
    expect(w.searchCall).toHaveBeenCalledTimes(2);
    expect(probes.scopes.map(scope => scope.target.managed_generation)).toEqual([w.a, w.b]);
    expect(probes.scopes[1]).toMatchObject({
      layout: "PROJECT_COPY_V2", target_selection: { purpose: "ACTIVE", target: { managed_generation: w.b } },
      copies: [{ membership_identity_version: 2, membership_revision: 2, project_membership_generation: 3 }],
    });
    expect(probes.scopes[0]?.copies[0]?.project_membership_id).toBe(probes.scopes[1]?.copies[0]?.project_membership_id);
    expect(probes.scopes[0]?.copies[0]?.folder_prefix).not.toBe(probes.scopes[1]?.copies[0]?.folder_prefix);
  });

  it.each([
    { registry_revision: 999 }, { registry_artifact_sha256: "0".repeat(64) }, { namespace: "foreign" },
    { instance_id: "foreign-instance" }, { index_generation: "foreign-generation" },
    { target_profile_identity_sha256: "0".repeat(64) }, { active: false },
  ])("rejects stale or foreign serving authority %j before provider I/O", async patch => {
    const w = await world();
    const snapshot = await createAiSearchGenerationRegistryService(createD1AiSearchGenerationRegistryStore(w.searchBinding)).read(AI_SEARCH_PRIMARY_NAMESPACE);
    const authority = await resolveAiSearchManagedSearchAuthority(snapshot, {
      expected_namespace: AI_SEARCH_PRIMARY_NAMESPACE, max_preview_bytes: 4096, match_threshold: 0,
    });
    const physicalAuthority = { ...authority, target_profile_identity_sha256: await aiSearchPhysicalProfileDigest(AI_SEARCH_PRIMARY_PROJECTION_PROFILE) };
    await expect(resolveManagedTargetSelectionV2(w.searchBinding, "ACTIVE", undefined, { ...physicalAuthority, ...patch }))
      .rejects.toMatchObject({ code: "MANAGED_SEARCH_PRODUCT_REGISTRY_INVALID" });
    expect(w.get).not.toHaveBeenCalled();
    expect(w.searchCall).not.toHaveBeenCalled();
  });

  it("rejects a registry advance between managed authority and scope selection before provider access", async () => {
    const w = await world();
    probes.copies = [await membership(2)];
    let reads = 0;
    w.hook(async () => {
      if (++reads === 2) { w.hook(async () => undefined); await w.rotate(); }
    });
    await expect(retrieveWithHeldScope(w.env, w.input)).rejects.toMatchObject({ code: "MANAGED_SEARCH_PRODUCT_REGISTRY_INVALID" });
    expect(w.get).not.toHaveBeenCalled();
    expect(w.searchCall).not.toHaveBeenCalled();
  });
});
