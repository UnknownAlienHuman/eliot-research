import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ErasureBlocker, ErasureReceipt, ErasureRequest, PurgeLocation } from "@eliotr/contracts";
import type { ResearchChangeItem } from "@eliotr/interfaces";
import { canonicalErasureJson, erasureSha256Utf8 } from "../../../packages/cloudflare-erasure/src/canonical.js";
import { appendPurgeLedger } from "../../../packages/cloudflare-erasure/src/ledger.js";
import { persistTerminalErasure } from "../../../packages/cloudflare-erasure/src/authority-terminal.js";
import { createErasureAdmissionPolicyStore } from "../../../packages/cloudflare-erasure/src/admission-policy.js";
import { createResearchChangesService, recordResearchChange } from "../src/research-changes.js";

// FOCUSED NATIVE AUTHORITY TEST, ONE NEW BOUNDED FILE.
//
// Scope: prove the private erasure-completion change-feed candidate records
// exactly one immutable ERASURE_COMPLETED event from a real guarded
// INVALIDATE_DEPENDENTS -> COMPLETE transition, and that the Core
// research-changes service serves that event only to the exact admitted owner.
//
// This file calls the Core service layer directly with a server-owned
// AuthenticatedRequestContext. Signed HTTP transport, live Cloudflare
// bindings, and provider calls are separate subjects and are not claimed.
// No DatabaseSync harness, no fake D1 adapter, and no copied authority or
// provider SQL is used: the terminal mutation is performed by the library
// function the production backend itself calls.

// The native test runtime exposes only the local D1 bindings this bounded
// case needs. RESEARCH_CHANGES_CURSOR_KEY is not a D1 binding, so it is
// supplied by the test rather than read from the environment.
const runtime = env as unknown as {
  CORE_DB: D1Database;
  CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const CURSOR_KEY = "A".repeat(43);
const DEPLOYMENT_GENERATION = "test-generation";
const PRINCIPAL = "erasure-completion-owner";
const CREDENTIAL = "credential-generation-1";
const FOREIGN_PRINCIPAL = "erasure-completion-foreign-owner";
const DRIFTED_CREDENTIAL = "credential-generation-2";
const CLOSURE_DIGEST = "b".repeat(64);
const REQUEST_DIGEST = "d".repeat(64);
const REQUIRED_LOCATIONS: readonly PurgeLocation[] = [
  "BackupRestorePath", "Blob", "CanonicalPayload", "Index",
  "OperationalRecovery", "ProviderCopy", "Projection", "RouteContinuation",
];

// Explicit preterminal clock. Nothing here seeds a completed erasure: every
// terminal fact below is produced by a real authority call.
let NOW_MS = 0;

interface Fixture {
  readonly suffix: string;
  readonly namespace: string;
  readonly ownerSystem: string;
  readonly ownerGeneration: string;
  readonly sourceId: string;
  readonly revision: string;
  readonly permissionId: string;
  readonly legalBasis: string;
  readonly erasureId: string;
}

interface Admitted {
  readonly erasure_ref: { readonly id: string; readonly revision: number };
  readonly exact_subject_refs: readonly string[];
  readonly legal_basis_ref: string;
  readonly admitted_at: string;
  readonly deadline: string;
  readonly request_json: string;
  readonly requested_locations: readonly PurgeLocation[];
}

interface FeedRow {
  readonly change_ref: string;
  readonly kind: string;
  readonly subject_ref: string;
  readonly subject_revision: number;
  readonly payload_ref: string;
  readonly payload_sha256: string;
  readonly visibility_principal_ref: string | null;
  readonly visibility_snapshot_id: string | null;
  readonly visibility_snapshot_revision: number | null;
  readonly occurred_at: string;
  readonly metadata_json: string;
}

function isoNow(): string {
  return new Date(NOW_MS).toISOString();
}

async function newFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  return {
    suffix,
    namespace: "erasure-completion-namespace-" + suffix,
    ownerSystem: "erasure-completion-owner-system-" + suffix,
    ownerGeneration: "erasure-completion-owner-generation-" + suffix,
    sourceId: "erasure-completion-source-" + suffix,
    revision: "erasure-completion-revision-" + suffix,
    permissionId: "erasure-completion-permission-" + suffix,
    legalBasis: "erasure-completion-legal-basis-" + suffix,
    erasureId: "erasure-completion-erasure-" + suffix,
  };
}
/** Explicit owner-owned subscription rows that real admission binds against. */
async function seedOwnedSource(f: Fixture): Promise<void> {
  await runtime.CORE_DB.batch([
    runtime.CORE_DB.prepare(
      "INSERT INTO source_namespace_ownership(source_namespace_id,ownership_record_revision," +
      "owner_system_id,owner_incarnation_ref,source_owner_generation," +
      "source_admission_policy_revision,status,created_at) VALUES (?1,1,?2,?3,?4,1,'ACTIVE',?5)",
    ).bind(f.namespace, f.ownerSystem, "incarnation-" + f.suffix, f.ownerGeneration, isoNow()),
    runtime.CORE_DB.prepare(
      "INSERT INTO source(source_id,source_namespace_id,source_owner_system_id,source_owner_generation," +
      "ownership_mode,kind,title,default_storage_policy,default_residency_profile_id,source_class," +
      "license_policy_ref,default_retention_policy_id,created_at) VALUES " +
      "(?1,?2,?3,?4,'erc_owned','document','Erasure completion fixture','storage-1'," +
      "'residency-1','document','license-1','retention-1',?5)",
    ).bind(f.sourceId, f.namespace, f.ownerSystem, f.ownerGeneration, isoNow()),
    runtime.CORE_DB.prepare(
      "INSERT INTO source_revision(source_revision_ref,source_id,source_owner_generation,content_sha256," +
      "object_residency_key_digest,original_r2_key,normalized_artifact_ref,captured_at," +
      "parser_profile_generation,quality_state,purge_state,currentness_state,source_view_ref," +
      "admitted_at) VALUES (?1,?2,?3,?4,?5,NULL,NULL,?6,'parser-1','standard','LIVE'," +
      "'current_confirmed','source-view-1',?6)",
    ).bind(f.revision, f.sourceId, f.ownerGeneration, "a".repeat(64), "e".repeat(64), isoNow()),
  ]);
}

/** True destructive permission install; the test never fabricates its bytes. */
async function installPermission(f: Fixture): Promise<void> {
  await createErasureAdmissionPolicyStore({ database: runtime.CORE_DB, now: () => NOW_MS }).install({
    permission_ref: { id: f.permissionId, revision: 1 },
    source_namespace_id: f.namespace,
    owner_system_id: f.ownerSystem,
    source_owner_generation: f.ownerGeneration,
    principal_ref: PRINCIPAL,
    credential_generation: CREDENTIAL,
    authorization_binding_ref: "operator-receipt-" + f.suffix,
    legal_basis_ref: f.legalBasis,
    valid_from: new Date(NOW_MS - 60_000).toISOString(),
    expires_at: new Date(NOW_MS + 7 * 24 * 60 * 60_000).toISOString(),
  });
}

/**
 * True admission through the real policy store, then read the admitted bytes
 * back. No completed erasure admission or status receipt is seeded: the
 * terminal state used below is produced only by persistTerminalErasure.
 */
async function admitErasure(f: Fixture): Promise<Admitted> {
  await createErasureAdmissionPolicyStore({ database: runtime.CORE_DB, now: () => NOW_MS }).admit(
    { principal_ref: PRINCIPAL, credential_generation: CREDENTIAL },
    { id: f.permissionId, revision: 1 },
    {
      protocol: "erc.privacy.erasure.v1",
      erasure_ref: { id: f.erasureId, revision: 1 },
      requested_by_principal_ref: PRINCIPAL,
      exact_subject_refs: ["source-revision:" + f.revision],
      required_locations: REQUIRED_LOCATIONS.map((location) => location),
      legal_basis_ref: f.legalBasis,
      admitted_at: isoNow(),
      deadline: new Date(NOW_MS + 24 * 60 * 60_000).toISOString(),
    },
  );
  const row = await runtime.CORE_DB.prepare(
    "SELECT request_json FROM erasure_admission_request " +
    "WHERE erasure_id=?1 AND erasure_revision=1 LIMIT 1",
  ).bind(f.erasureId).first<{ request_json: unknown }>();
  if (row === null || typeof row.request_json !== "string") {
    throw new Error("real erasure admission did not persist its exact request");
  }
  const admitted = JSON.parse(row.request_json) as ErasureRequest;
  return {
    erasure_ref: { id: admitted.erasure_ref.id, revision: admitted.erasure_ref.revision },
    exact_subject_refs: admitted.exact_subject_refs,
    legal_basis_ref: admitted.legal_basis_ref,
    admitted_at: admitted.admitted_at,
    deadline: admitted.deadline,
    request_json: row.request_json,
    requested_locations: admitted.required_locations,
  };
}

/** Explicit preterminal prerequisite rows required by the guarded transition. */
async function seedPrerequisites(f: Fixture, admitted: Admitted): Promise<void> {
  const now = isoNow();
  await runtime.CORE_DB.batch([
    runtime.CORE_DB.prepare(
      "INSERT INTO erasure_case(erasure_id,revision,state,exact_subject_refs_json," +
      "requested_locations_json,completed_locations_json,blocked_locations_json,legal_basis_ref," +
      "deadline,created_at,updated_at) VALUES (?1,1,'INVALIDATE_DEPENDENTS',?2,?3,'[]','[]',?4,?5,?6,?6)",
    ).bind(
      f.erasureId,
      canonicalErasureJson(["source-revision:" + f.revision]),
      canonicalErasureJson(admitted.requested_locations),
      f.legalBasis,
      new Date(NOW_MS + 24 * 60 * 60_000).toISOString(),
      now,
    ),
    runtime.CORE_DB.prepare(
      "INSERT INTO erasure_execution(erasure_id,revision,request_json,request_sha256,state," +
      "lease_owner,lease_generation,lease_until,closure_digest,created_at,updated_at) VALUES " +
      "(?1,1,?2,?3,'INVALIDATE_DEPENDENTS',?4,7,?5,?6,?7,?7)",
    ).bind(
      f.erasureId,
      admitted.request_json,
      await erasureSha256Utf8(admitted.request_json),
      "lease-owner-" + f.suffix,
      NOW_MS + 120_000,
      CLOSURE_DIGEST,
      now,
    ),
    runtime.CORE_DB.prepare(
      "INSERT INTO erasure_stage_receipt(erasure_id,erasure_revision,stage,lease_generation," +
      "receipt_ref,payload_digest,created_at) VALUES " +
      "(?1,1,'INVALIDATE_DEPENDENTS',7,'invalidate-receipt-1',?3,?2)",
     ).bind(f.erasureId, now, "c".repeat(64)),
  ]);
}


/**
 * The canonical purge-ledger prerequisite is appended with the existing
 * authority appendPurgeLedger implementation; its disposition follows the real
 * completed-versus-blocked comparison rather than a fabricated value.
 */
async function appendCanonicalLedger(
  admitted: Admitted,
  blockers: readonly ErasureBlocker[],
): Promise<{ readonly ledger_entry_ref: string; readonly ledger_revision: number }> {
  return appendPurgeLedger(
    runtime.CORE_DB,
    {
      protocol: "erc.privacy.erasure.v1",
      erasure_ref: admitted.erasure_ref,
      requested_by_principal_ref: PRINCIPAL,
      exact_subject_refs: [...admitted.exact_subject_refs],
      required_locations: [...admitted.requested_locations],
      legal_basis_ref: admitted.legal_basis_ref,
      admitted_at: admitted.admitted_at,
      deadline: admitted.deadline,
    },
    {
      erasure_ref: admitted.erasure_ref,
      request_digest: REQUEST_DIGEST,
      closure_digest: CLOSURE_DIGEST,
      targets: [],
    },
    [],
  blockers,
    NOW_MS,
  );
}

async function terminalReceipt(
  admitted: Admitted,
  ledgerEntryRef: string,
): Promise<{ readonly receipt_json: string; readonly receipt_sha256: string }> {
  const locations = admitted.requested_locations.map((location) => location);
  const receipt: ErasureReceipt = {
    protocol: "erc.privacy.erasure.v1",
    erasure_ref: admitted.erasure_ref,
    state: "COMPLETE",
    requested_locations: locations,
    completed_locations: locations,
    blocked_locations: [],
    purge_ledger_entry_ref: ledgerEntryRef,
    issued_at: isoNow(),
  };
  const receiptJson = canonicalErasureJson(receipt);
  return { receipt_json: receiptJson, receipt_sha256: await erasureSha256Utf8(receiptJson) };
}

/**
 * The terminal mutation always runs through the real library function the
 * production backend calls, so the change feed records only what the exact
 * guarded transition actually commits.
 */
async function settle(admitted: Admitted, leaseOwner: string): Promise<void> {
  const ledger = await appendCanonicalLedger(admitted, []);
  const receipt = await terminalReceipt(admitted, ledger.ledger_entry_ref);
  await persistTerminalErasure(runtime.CORE_DB, {
    fence: {
      erasure_id: admitted.erasure_ref.id,
      revision: admitted.erasure_ref.revision,
      lease_owner: leaseOwner,
      lease_generation: 7,
      lease_until_ms: NOW_MS + 120_000,
    },
    closure_digest: CLOSURE_DIGEST,
    terminal_state: "COMPLETE",
    requested_locations_json: canonicalErasureJson(admitted.requested_locations),
    completed_locations_json: canonicalErasureJson(admitted.requested_locations),
    blocked_locations_json: "[]",
    receipt_json: receipt.receipt_json,
    receipt_sha256: receipt.receipt_sha256,
    ledger_entry_ref: ledger.ledger_entry_ref,
    ledger_revision: ledger.ledger_revision,
    expected_non_absent_targets: 0,
    now: isoNow(),
    now_ms: NOW_MS,
  });
}

async function feedRows(erasureId: string): Promise<readonly FeedRow[]> {
  const result = await runtime.CORE_DB.prepare(
    "SELECT change_ref,kind,subject_ref,subject_revision,payload_ref,payload_sha256," +
    "visibility_principal_ref,visibility_snapshot_id,visibility_snapshot_revision," +
    "occurred_at,metadata_json FROM research_change_feed WHERE subject_ref=?1",
  ).bind(erasureId).all<FeedRow>();
  if (!result.success || !Array.isArray(result.results)) {
    throw new Error("change feed readback did not settle");
  }
  return result.results;
}

async function feedCount(erasureId: string): Promise<number> {
  const row = await runtime.CORE_DB.prepare(
    "SELECT COUNT(*) AS count FROM research_change_feed WHERE subject_ref=?1",
  ).bind(erasureId).first<{ count: number }>();
  return row?.count ?? 0;
}


function context(key: string, principalRef: string, credentialGeneration: string) {
  return {
    request: new Request("https://research.example/api/v1/research/changes", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
    }),
    principal_ref: principalRef,
    client_class: "owner_pwa" as const,
    credential_generation: credentialGeneration,
    trace_id: "trace-" + key,
  };
}

/** Real Core service composition, including the injected erasure authorizer. */
function changes() {
  return createResearchChangesService({
    CORE_DB: runtime.CORE_DB,
    DEPLOYMENT_GENERATION,
    RESEARCH_CHANGES_CURSOR_KEY: CURSOR_KEY,
  }, { now: () => NOW_MS });
}

async function readCompletions(
  principalRef: string,
  credentialGeneration: string,
): Promise<readonly ResearchChangeItem[]> {
  const result = await changes()(
    context("read", principalRef, credentialGeneration),
    { after_cursor: null, limit: 10, kinds: ["ERASURE_COMPLETED"] },
  );
  return result.items;
}

describe("D1 erasure completion change feed", () => {
  beforeEach(async () => {
    await reset();
    NOW_MS = Date.now();
    await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
    // Use the ordinary migration list once; the candidate must be integrated before native execution.
    expect(await runtime.CORE_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name=?1",
    ).bind("erasure_execution_completion_change_feed").first()).not.toBeNull();
    expect(await runtime.CORE_DB.prepare(
      "SELECT value FROM schema_state WHERE key=?1",
    ).bind("erasure_completion_feed_generation").first()).toEqual({
      value: "erasure-completion-feed-v1",
    });
  });

  it("records exactly one immutable authorized event and no repeated terminal effect", async () => {
    const f = await newFixture();
    await seedOwnedSource(f);
    await installPermission(f);
    const admitted = await admitErasure(f);
    await seedPrerequisites(f, admitted);
    await settle(admitted, "lease-owner-" + f.suffix);

    const rows = await feedRows(admitted.erasure_ref.id);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error("expected exactly one completion event");

    expect(row.change_ref).toBe("erasure-completed:" + admitted.erasure_ref.id + ":1");
    expect(row.kind).toBe("ERASURE_COMPLETED");
    expect(row.subject_ref).toBe(admitted.erasure_ref.id);
    expect(row.subject_revision).toBe(1);
    expect(row.visibility_principal_ref).toBe(PRINCIPAL);
    expect(row.visibility_snapshot_id).toBeNull();
    expect(row.visibility_snapshot_revision).toBeNull();
    expect(row.metadata_json).toBe("{}");

    // The event carries the canonical terminal receipt digest and the exact
    // purge ledger entry the guarded transition committed.
    const execution = await runtime.CORE_DB.prepare(
      "SELECT terminal_receipt_json,terminal_receipt_sha256,purge_ledger_revision FROM " +
      "erasure_execution WHERE erasure_id=?1 AND revision=1",
    ).bind(admitted.erasure_ref.id).first<{
      terminal_receipt_json: unknown;
      terminal_receipt_sha256: unknown;
      purge_ledger_revision: unknown;
    }>();
    if (typeof execution?.terminal_receipt_json !== "string" ||
        typeof execution.terminal_receipt_sha256 !== "string" ||
        typeof execution.purge_ledger_revision !== "number") {
      throw new Error("terminal erasure execution is incomplete");
    }
    expect(row.payload_sha256).toBe(execution.terminal_receipt_sha256);
    expect(row.payload_sha256).toBe(await erasureSha256Utf8(execution.terminal_receipt_json));
    const ledger = await runtime.CORE_DB.prepare(
      "SELECT receipt_ref,erasure_id,disposition FROM purge_ledger WHERE ledger_revision=?1",
    ).bind(execution.purge_ledger_revision).first<{
      receipt_ref: unknown;
      erasure_id: unknown;
      disposition: unknown;
    }>();
    expect(row.payload_ref).toBe(ledger?.receipt_ref);
    expect(ledger?.erasure_id).toBe(admitted.erasure_ref.id);
    expect(ledger?.disposition).toBe("COMPLETE");
    const receipt = JSON.parse(execution.terminal_receipt_json) as ErasureReceipt;
    expect(row.occurred_at).toBe(receipt.issued_at);
    expect(row.payload_ref).toBe(receipt.purge_ledger_entry_ref);

    const guard = await runtime.CORE_DB.prepare(
      "SELECT terminal_state,verified FROM erasure_terminal_guard " +
      "WHERE erasure_id=?1 AND erasure_revision=1",
    ).bind(admitted.erasure_ref.id).first<{ terminal_state: unknown; verified: unknown }>();
    expect(guard).toEqual({ terminal_state: "COMPLETE", verified: 1 });
    const guardSnapshot = await runtime.CORE_DB.prepare(
      "SELECT closure_digest,receipt_sha256,purge_ledger_revision,terminal_state,verified " +
      "FROM erasure_terminal_guard WHERE erasure_id=?1 AND erasure_revision=1",
    ).bind(admitted.erasure_ref.id).first();
    const settled = await runtime.CORE_DB.prepare(
      "SELECT state FROM erasure_case WHERE erasure_id=?1 AND revision=1",
    ).bind(admitted.erasure_ref.id).first<{ state: unknown }>();
    expect(settled?.state).toBe("COMPLETE");

    // Immutable: the feed refuses both rewrites of the settled event.
    await expect(runtime.CORE_DB.prepare(
      "UPDATE research_change_feed SET metadata_json='{}' WHERE change_ref=?1",
    ).bind(row.change_ref).run()).rejects.toThrow();
    await expect(runtime.CORE_DB.prepare(
      "DELETE FROM research_change_feed WHERE change_ref=?1",
    ).bind(row.change_ref).run()).rejects.toThrow();
    expect(await feedRows(admitted.erasure_ref.id)).toEqual(rows);

    // A repeated terminal settlement cannot create a second effect: the feed
    // row, the guard row, and the reader page survive it unchanged. Whether
    // the library resolves an identical replay as a no-op or refuses it is
    // not pinned here, because the durable invariant is what this case owns.
    const replay = await settle(admitted, "lease-owner-" + f.suffix)
      .then(() => "settled" as const)
      .catch(() => "refused" as const);
    expect(["settled", "refused"]).toContain(replay);
    expect(await feedCount(admitted.erasure_ref.id)).toBe(1);
    expect(await feedRows(admitted.erasure_ref.id)).toEqual(rows);
    expect(await runtime.CORE_DB.prepare(
      "SELECT closure_digest,receipt_sha256,purge_ledger_revision,terminal_state,verified " +
      "FROM erasure_terminal_guard WHERE erasure_id=?1 AND erasure_revision=1",
    ).bind(admitted.erasure_ref.id).first()).toEqual(guardSnapshot);
    expect((await readCompletions(PRINCIPAL, CREDENTIAL)).map((item) => item.change_ref))
      .toEqual(rows.map((item) => item.change_ref));
  });

  it("serves the exact authorized owner one immutable page and replays identically", async () => {
    const f = await newFixture();
    await seedOwnedSource(f);
    await installPermission(f);
    const admitted = await admitErasure(f);
    await seedPrerequisites(f, admitted);
    await settle(admitted, "lease-owner-" + f.suffix);

    const request = { after_cursor: null, limit: 10, kinds: ["ERASURE_COMPLETED"] as const };
    const first = await changes()(context("read", PRINCIPAL, CREDENTIAL), request);
    const items = first.items;
    expect(items.map((item) => item.change_ref)).toEqual([
      "erasure-completed:" + admitted.erasure_ref.id + ":1",
    ]);
    const item = items[0];
    if (item === undefined) throw new Error("expected the exact completion page");
    expect(item.kind).toBe("ERASURE_COMPLETED");
    expect(item.subject_ref).toBe(admitted.erasure_ref.id);
    expect(item.visibility_principal_ref).toBe(PRINCIPAL);
    expect(item.visibility_scope_ref).toBeUndefined();
    expect(item.metadata).toEqual({});
    expect(item.occurred_at).toBe(isoNow());

    // The same principal, credential, deployment and filter replay the full
    // ordered result and deterministic cursor under the fixture's fixed clock.
    const replay = await changes()(context("read", PRINCIPAL, CREDENTIAL), request);
    expect(replay).toEqual(first);
    expect(first.has_more).toBe(false);
    expect(first.next_cursor).not.toBeNull();
  });


  it("records no completion event and no partial terminal state for a stale fence", async () => {
    const f = await newFixture();
    await seedOwnedSource(f);
    await installPermission(f);
    const admitted = await admitErasure(f);
    await seedPrerequisites(f, admitted);

    // A fence that does not own the live lease cannot clear the guarded
    // transition, so nothing is recorded and nothing is committed.
    await expect(settle(admitted, "lease-owner-stale-" + f.suffix)).rejects.toMatchObject({
      code: "ERASURE_LEASE_LOST",
    });

    expect(await feedCount(admitted.erasure_ref.id)).toBe(0);
    const execution = await runtime.CORE_DB.prepare(
      "SELECT state,terminal_receipt_json,lease_owner FROM erasure_execution " +
      "WHERE erasure_id=?1 AND revision=1",
    ).bind(admitted.erasure_ref.id).first<{
      state: unknown;
      terminal_receipt_json: unknown;
      lease_owner: unknown;
    }>();
    expect(execution?.state).toBe("INVALIDATE_DEPENDENTS");
    expect(execution?.terminal_receipt_json).toBeNull();
    expect(execution?.lease_owner).toBe("lease-owner-" + f.suffix);
    const caseRow = await runtime.CORE_DB.prepare(
      "SELECT state,completed_locations_json,blocked_locations_json FROM erasure_case " +
      "WHERE erasure_id=?1 AND revision=1",
    ).bind(admitted.erasure_ref.id).first<{
      state: unknown;
      completed_locations_json: unknown;
      blocked_locations_json: unknown;
    }>();
    expect(caseRow).toEqual({
      state: "INVALIDATE_DEPENDENTS",
      completed_locations_json: "[]",
      blocked_locations_json: "[]",
    });
    const guard = await runtime.CORE_DB.prepare(
      "SELECT COUNT(*) AS count FROM erasure_terminal_guard " +
      "WHERE erasure_id=?1 AND erasure_revision=1",
    ).bind(admitted.erasure_ref.id).first<{ count: number }>();
    expect(guard?.count).toBe(0);
    expect(await readCompletions(PRINCIPAL, CREDENTIAL)).toEqual([]);
  });

  it("withholds foreign and credential-drifted principals and an unsupported event", async () => {
    const f = await newFixture();
    await seedOwnedSource(f);
    await installPermission(f);
    const admitted = await admitErasure(f);
    await seedPrerequisites(f, admitted);
    await settle(admitted, "lease-owner-" + f.suffix);

    // A foreign principal never observes the owner-scoped event, and the same
    // principal under a different credential generation receives nothing.
    expect(await readCompletions(FOREIGN_PRINCIPAL, "credential-foreign")).toEqual([]);
    expect(await readCompletions(PRINCIPAL, DRIFTED_CREDENTIAL)).toEqual([]);

    // An unsupported ERASURE_COMPLETED event for a real admission with no
    // terminal receipt cannot pass the canonical status reader, so the only
    // served item is the authorized one this test settled.
    const unsettled = await newFixture();
    await seedOwnedSource(unsettled);
    await installPermission(unsettled);
    const unsettledAdmitted = await admitErasure(unsettled);
    await recordResearchChange(runtime.CORE_DB, {
      change_ref: "erasure-completed:" + unsettledAdmitted.erasure_ref.id + ":1",
      kind: "ERASURE_COMPLETED",
      subject_ref: unsettledAdmitted.erasure_ref.id,
      subject_revision: 1,
      payload_ref: "purge-ledger-unsigned-" + unsettled.suffix,
      payload_sha256: "f".repeat(64),
      visibility_principal_ref: PRINCIPAL,
      occurred_at: isoNow(),
      metadata: {},
    });
    expect(await feedCount(unsettledAdmitted.erasure_ref.id)).toBe(1);
    expect((await readCompletions(PRINCIPAL, CREDENTIAL)).map((item) => item.change_ref)).toEqual([
      "erasure-completed:" + admitted.erasure_ref.id + ":1",
    ]);
  });
  it("rolls back terminal case, execution and guard when the deterministic change reference is occupied", async () => {
    const f = await newFixture();
    await seedOwnedSource(f);
    await installPermission(f);
    const admitted = await admitErasure(f);
    await seedPrerequisites(f, admitted);
    await recordResearchChange(runtime.CORE_DB, {
      change_ref: "erasure-completed:" + admitted.erasure_ref.id + ":1",
      kind: "SOURCE_UPDATED", subject_ref: admitted.erasure_ref.id, subject_revision: 1,
      payload_ref: "payload:occupied", payload_sha256: "f".repeat(64), occurred_at: isoNow(),
    });
    const snapshot = async () => Promise.all(
      ["erasure_execution", "erasure_case", "erasure_terminal_guard"].map(async (table) =>
        (await runtime.CORE_DB.prepare("SELECT * FROM " + table + " WHERE erasure_id=?1")
          .bind(admitted.erasure_ref.id).all()).results),
    );
    const before = await snapshot(), occupied = await feedRows(admitted.erasure_ref.id);
    await expect(settle(admitted, "lease-owner-" + f.suffix)).rejects.toMatchObject({ code: "ERASURE_SETTLEMENT_UNCERTAIN" });
    expect(await snapshot()).toEqual(before);
    expect(await feedRows(admitted.erasure_ref.id)).toEqual(occupied);
  });
});
