import { applyD1Migrations, reset } from "cloudflare:test";
import {
  canonicalEvidenceJson,
  evidenceSha256,
} from "@eliotr/cloudflare-evidence";
import {
  CitationResolutionReceiptV1Schema,
  CitationResolutionReceiptV2Schema,
  type CitationResolutionOutcome,
} from "@eliotr/contracts";
import { persistCitationResolutionReceipt } from "../../../packages/cloudflare-evidence/src/citation-registry.js";
import type { PersistCitationResolutionInput } from "../../../packages/cloudflare-evidence/src/types.js";
import { expect } from "vitest";
import { runtime } from "./research-workflow-fixture.js";

type Ref = { readonly id: string; readonly revision: number };

type ReceiptShape = {
  readonly schema_version?: 2;
  readonly receipt_ref: Ref;
  readonly scope_snapshot_ref: Ref;
  readonly requested_handle_refs: readonly Ref[];
  readonly outcomes?: readonly unknown[];
  readonly resolved: readonly unknown[];
  readonly rejected: readonly unknown[];
  readonly requested_count: number;
  readonly resolved_count: number;
  readonly all_material_citations_resolved: boolean;
  readonly created_at: string;
  readonly receipt_digest: string;
};

type ReceiptDraft = Omit<ReceiptShape, "receipt_digest">;

type ReceiptRow = {
  readonly receipt_id: string;
  readonly revision: number;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly requested_handle_refs_json: string;
  readonly resolved_json: string;
  readonly rejected_json: string;
  readonly requested_count: number;
  readonly resolved_count: number;
  readonly all_material_citations_resolved: number;
  readonly receipt_json: string;
  readonly receipt_sha256: string;
  readonly created_at: string;
  readonly outcomes_json: string | null;
};

type StoredReceipt = Pick<
  ReceiptRow,
  | "receipt_json"
  | "receipt_sha256"
  | "requested_handle_refs_json"
  | "resolved_json"
  | "rejected_json"
  | "outcomes_json"
> & { readonly verified: number | null };

type NativeFixture = {
  readonly database: D1Database;
  readonly scope_ref: Ref;
  readonly scope_authority: PersistCitationResolutionInput["scope"];
  readonly historical_v1: ReceiptShape;
  readonly historical_v1_json: string;
  readonly historical_v1_sha256: string;
};

const CREATED_AT = "2026-10-08T20:00:00.000Z";
const PRINCIPAL_REF = "citation-outcomes-owner";
const CREDENTIAL_GENERATION = "citation-outcomes-credential";
const POLICY_AUTHORITY_REF = "citation-outcomes-policy-authority";
const AUTHORIZATION_RECEIPT_REF = "citation-outcomes-authorization";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

async function sealReceipt(draft: ReceiptDraft): Promise<ReceiptShape> {
  return { ...draft, receipt_digest: await evidenceSha256(draft) };
}

async function seedScope(database: D1Database): Promise<{
  readonly reference: Ref;
  readonly authority: PersistCitationResolutionInput["scope"];
}> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const scopeExpression = { kind: "GLOBAL_LIBRARY" as const };
  const participantGenerations = { "member-policy-closure": POLICY_AUTHORITY_REF };
  const sourceOwnerGenerations = {};
  const scopeIdentity = {
    protocol: "eliotr.scope-snapshot.v1",
    revision: 1,
    resolved_scope_expression: scopeExpression,
    participant_generations: participantGenerations,
    member_source_revision_refs: [],
    source_owner_generations: sourceOwnerGenerations,
    policy_authority_ref: POLICY_AUTHORITY_REF,
    disclosure_closure_digest: "d".repeat(64),
    purge_ledger_revision: 0,
    created_at: now,
    expires_at: expiresAt,
  };
  const snapshotId = `scope-${(await evidenceSha256(scopeIdentity)).slice(0, 48)}`;
  const snapshotDigest = await evidenceSha256({ snapshot_id: snapshotId, ...scopeIdentity });
  const databaseBatch = [
    database.prepare(
      "INSERT INTO investigation_current_policy VALUES (?1,?2,'ACTIVE',?3)",
    ).bind("citation-outcomes-policy", POLICY_AUTHORITY_REF, now),
    database.prepare(
      "INSERT INTO investigation_current_deployment(deployment_generation,state,created_at) " +
        "VALUES ('citation-outcomes-deployment','ACTIVE',?1)",
    ).bind(now),
    database.prepare(
      "INSERT INTO scope_snapshot (snapshot_id, revision, resolved_scope_expression_json, " +
        "participant_generations_json, member_source_revision_refs_json, source_owner_generations_json, " +
        "policy_authority_ref, disclosure_closure_digest, purge_ledger_revision, snapshot_digest, created_at, expires_at) " +
        "VALUES (?1,1,?2,?3,'[]',?4,?5,?6,0,?7,?8,?9)",
    ).bind(
      snapshotId,
      canonicalEvidenceJson(scopeExpression),
      canonicalEvidenceJson(participantGenerations),
      canonicalEvidenceJson(sourceOwnerGenerations),
      POLICY_AUTHORITY_REF,
      scopeIdentity.disclosure_closure_digest,
      snapshotDigest,
      now,
      expiresAt,
    ),
    database.prepare(
      "INSERT INTO scope_access_grant (snapshot_id, snapshot_revision, principal_ref, client_class, " +
        "credential_generation, policy_authority_ref, allowed_use_json, disclosure_ceiling, authorization_receipt_ref, " +
        "state, expires_at, created_at) VALUES (?1,1,?2,'owner_pwa',?3,?4,'[\"research\"]','exact',?5,'ACTIVE',?6,?7)",
    ).bind(
      snapshotId,
      PRINCIPAL_REF,
      CREDENTIAL_GENERATION,
      POLICY_AUTHORITY_REF,
      AUTHORIZATION_RECEIPT_REF,
      expiresAt,
      now,
    ),
  ];
  await database.batch(databaseBatch);
  return {
    reference: { id: snapshotId, revision: 1 },
    authority: {
      snapshot: {
        snapshot_id: snapshotId,
        revision: 1,
        resolved_scope_expression: scopeExpression,
        participant_generations: participantGenerations,
        member_source_revision_refs: [],
        source_owner_generations: sourceOwnerGenerations,
        policy_authority_ref: POLICY_AUTHORITY_REF,
        disclosure_closure_digest: scopeIdentity.disclosure_closure_digest,
        purge_ledger_revision: 0,
        digest: snapshotDigest,
        created_at: now,
        expires_at: expiresAt,
      },
      invalidated_at: null,
      invalidation_reason: null,
    },
  };
}

function toReceiptRow(receipt: ReceiptShape): ReceiptRow {
  return {
    receipt_id: receipt.receipt_ref.id,
    revision: receipt.receipt_ref.revision,
    scope_snapshot_id: receipt.scope_snapshot_ref.id,
    scope_snapshot_revision: receipt.scope_snapshot_ref.revision,
    requested_handle_refs_json: canonicalEvidenceJson(receipt.requested_handle_refs),
    resolved_json: canonicalEvidenceJson(receipt.resolved),
    rejected_json: canonicalEvidenceJson(receipt.rejected),
    requested_count: receipt.requested_count,
    resolved_count: receipt.resolved_count,
    all_material_citations_resolved: receipt.all_material_citations_resolved ? 1 : 0,
    receipt_json: canonicalEvidenceJson(receipt),
    receipt_sha256: "",
    created_at: receipt.created_at,
    outcomes_json: receipt.schema_version === 2
      ? canonicalEvidenceJson(receipt.outcomes ?? [])
      : null,
  };
}

async function receiptRow(receipt: ReceiptShape): Promise<ReceiptRow> {
  return { ...toReceiptRow(receipt), receipt_sha256: await evidenceSha256(receipt) };
}

async function receiptRowWithJsonDrift(
  row: ReceiptRow,
  mutate: (receipt: Record<string, unknown>) => void,
): Promise<ReceiptRow> {
  const receipt = JSON.parse(row.receipt_json) as Record<string, unknown>;
  delete receipt.receipt_digest;
  mutate(receipt);
  const driftedReceipt = {
    ...receipt,
    receipt_digest: await evidenceSha256(receipt),
  };
  return {
    ...row,
    receipt_json: canonicalEvidenceJson(driftedReceipt),
    receipt_sha256: await evidenceSha256(driftedReceipt),
  };
}

function insertHistoricalReceipt(database: D1Database, row: ReceiptRow): D1PreparedStatement {
  return database.prepare(
    "INSERT INTO citation_resolution_receipt(receipt_id,revision,scope_snapshot_id,scope_snapshot_revision," +
      "principal_ref,client_class,credential_generation,authorization_receipt_ref,requested_handle_refs_json," +
      "resolved_json,rejected_json,requested_count,resolved_count,all_material_citations_resolved,receipt_json," +
      "receipt_sha256,created_at) VALUES (?1,?2,?3,?4,?5,'owner_pwa',?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
  ).bind(
    row.receipt_id,
    row.revision,
    row.scope_snapshot_id,
    row.scope_snapshot_revision,
    PRINCIPAL_REF,
    CREDENTIAL_GENERATION,
    AUTHORIZATION_RECEIPT_REF,
    row.requested_handle_refs_json,
    row.resolved_json,
    row.rejected_json,
    row.requested_count,
    row.resolved_count,
    row.all_material_citations_resolved,
    row.receipt_json,
    row.receipt_sha256,
    row.created_at,
  );
}

function insertReceipt(database: D1Database, row: ReceiptRow): D1PreparedStatement {
  return database.prepare(
    "INSERT INTO citation_resolution_receipt(receipt_id,revision,scope_snapshot_id,scope_snapshot_revision," +
      "principal_ref,client_class,credential_generation,authorization_receipt_ref,requested_handle_refs_json," +
      "resolved_json,rejected_json,requested_count,resolved_count,all_material_citations_resolved,receipt_json," +
      "receipt_sha256,created_at,outcomes_json) VALUES (?1,?2,?3,?4,?5,'owner_pwa',?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
  ).bind(
    row.receipt_id,
    row.revision,
    row.scope_snapshot_id,
    row.scope_snapshot_revision,
    PRINCIPAL_REF,
    CREDENTIAL_GENERATION,
    AUTHORIZATION_RECEIPT_REF,
    row.requested_handle_refs_json,
    row.resolved_json,
    row.rejected_json,
    row.requested_count,
    row.resolved_count,
    row.all_material_citations_resolved,
    row.receipt_json,
    row.receipt_sha256,
    row.created_at,
    row.outcomes_json,
  );
}

function insertGuard(database: D1Database, row: ReceiptRow): D1PreparedStatement {
  return database.prepare(
    "INSERT INTO citation_resolution_guard(receipt_id,receipt_revision,verified,created_at) " +
      "VALUES (?1,?2,1,?3)",
  ).bind(row.receipt_id, row.revision, row.created_at);
}

async function storedReceipt(database: D1Database, row: ReceiptRow): Promise<StoredReceipt | null> {
  return database.prepare(
    "SELECT r.receipt_json,r.receipt_sha256,r.requested_handle_refs_json,r.resolved_json," +
      "r.rejected_json,r.outcomes_json,g.verified FROM citation_resolution_receipt r " +
      "LEFT JOIN citation_resolution_guard g ON g.receipt_id=r.receipt_id AND g.receipt_revision=r.revision " +
      "WHERE r.receipt_id=?1 AND r.revision=?2 LIMIT 1",
  ).bind(row.receipt_id, row.revision).first<StoredReceipt>();
}

function v2Draft(scopeRef: Ref, receiptId: string): ReceiptDraft {
  const handles = {
    resolved: { id: `${receiptId}-resolved`, revision: 1 },
    invalid: { id: `${receiptId}-invalid`, revision: 1 },
    revoked: { id: `${receiptId}-revoked`, revision: 1 },
    quarantined: { id: `${receiptId}-quarantined`, revision: 1 },
    mismatch: { id: `${receiptId}-mismatch`, revision: 1 },
    verifyUnavailable: { id: `${receiptId}-verify-unavailable`, revision: 1 },
    storageUnavailable: { id: `${receiptId}-storage-unavailable`, revision: 1 },
    effectUnknown: { id: `${receiptId}-effect-unknown`, revision: 1 },
  };
  const outcomes: CitationResolutionOutcome[] = [
    {
      handle_ref: handles.resolved,
      outcome: "RESOLVED",
      excerpt_sha256: SHA_A,
      verification_receipt_ref: "evidence-resolution-v1",
    },
    { handle_ref: handles.invalid, outcome: "INVALID_REFERENCE" },
    { handle_ref: handles.revoked, outcome: "AUTHORITY_REVOKED" },
    { handle_ref: handles.quarantined, outcome: "SOURCE_QUARANTINED" },
    { handle_ref: handles.mismatch, outcome: "CONTENT_MISMATCH" },
    { handle_ref: handles.verifyUnavailable, outcome: "VERIFY_UNAVAILABLE" },
    { handle_ref: handles.storageUnavailable, outcome: "STORAGE_UNAVAILABLE" },
    { handle_ref: handles.effectUnknown, outcome: "EFFECT_UNKNOWN" },
  ];
  return {
    schema_version: 2,
    receipt_ref: { id: receiptId, revision: 1 },
    scope_snapshot_ref: scopeRef,
    requested_handle_refs: [
      handles.resolved,
      handles.invalid,
      handles.revoked,
      handles.quarantined,
      handles.mismatch,
      handles.verifyUnavailable,
      handles.storageUnavailable,
      handles.effectUnknown,
    ],
    outcomes,
    resolved: [{
      handle_ref: handles.resolved,
      excerpt_sha256: SHA_A,
      verification_receipt_ref: "evidence-resolution-v1",
    }],
    rejected: [
      { handle_ref: handles.invalid, reason_code: "INVALID_REFERENCE" },
      { handle_ref: handles.revoked, reason_code: "AUTHORITY_REVOKED" },
      { handle_ref: handles.mismatch, reason_code: "CONTENT_MISMATCH" },
    ],
    requested_count: outcomes.length,
    resolved_count: 1,
    all_material_citations_resolved: false,
    created_at: CREATED_AT,
  };
}

function v2ProjectionOrderDraft(scopeRef: Ref, receiptId: string): ReceiptDraft {
  const handles = {
    resolvedFirst: { id: `${receiptId}-resolved-first`, revision: 1 },
    resolvedSecond: { id: `${receiptId}-resolved-second`, revision: 1 },
    invalidFirst: { id: `${receiptId}-invalid-first`, revision: 1 },
    invalidSecond: { id: `${receiptId}-invalid-second`, revision: 1 },
  };
  const outcomes: CitationResolutionOutcome[] = [
    {
      handle_ref: handles.resolvedFirst,
      outcome: "RESOLVED",
      excerpt_sha256: SHA_A,
      verification_receipt_ref: `${receiptId}-verification-first`,
    },
    {
      handle_ref: handles.resolvedSecond,
      outcome: "RESOLVED",
      excerpt_sha256: SHA_B,
      verification_receipt_ref: `${receiptId}-verification-second`,
    },
    { handle_ref: handles.invalidFirst, outcome: "INVALID_REFERENCE" },
    { handle_ref: handles.invalidSecond, outcome: "CONTENT_MISMATCH" },
  ];
  return {
    schema_version: 2,
    receipt_ref: { id: receiptId, revision: 1 },
    scope_snapshot_ref: scopeRef,
    requested_handle_refs: [
      handles.resolvedFirst,
      handles.resolvedSecond,
      handles.invalidFirst,
      handles.invalidSecond,
    ],
    outcomes,
    resolved: [
      {
        handle_ref: handles.resolvedFirst,
        excerpt_sha256: SHA_A,
        verification_receipt_ref: `${receiptId}-verification-first`,
      },
      {
        handle_ref: handles.resolvedSecond,
        excerpt_sha256: SHA_B,
        verification_receipt_ref: `${receiptId}-verification-second`,
      },
    ],
    rejected: [
      { handle_ref: handles.invalidFirst, reason_code: "INVALID_REFERENCE" },
      { handle_ref: handles.invalidSecond, reason_code: "CONTENT_MISMATCH" },
    ],
    requested_count: outcomes.length,
    resolved_count: 2,
    all_material_citations_resolved: false,
    created_at: CREATED_AT,
  };
}

function v2DraftFrom(
  receipt: ReturnType<typeof CitationResolutionReceiptV2Schema.parse>,
  changes: {
    readonly outcomes?: readonly unknown[];
    readonly resolved?: readonly unknown[];
    readonly rejected?: readonly unknown[];
  } = {},
): ReceiptDraft {
  return {
    schema_version: 2,
    receipt_ref: receipt.receipt_ref,
    scope_snapshot_ref: receipt.scope_snapshot_ref,
    requested_handle_refs: receipt.requested_handle_refs,
    outcomes: changes.outcomes ?? receipt.outcomes,
    resolved: changes.resolved ?? receipt.resolved,
    rejected: changes.rejected ?? receipt.rejected,
    requested_count: receipt.requested_count,
    resolved_count: receipt.resolved_count,
    all_material_citations_resolved: receipt.all_material_citations_resolved,
    created_at: receipt.created_at,
  };
}

function unavailableOnlyDraft(scopeRef: Ref, receiptId: string): ReceiptDraft {
  const draft = v2Draft(scopeRef, receiptId);
  return {
    ...draft,
    outcomes: draft.requested_handle_refs.map((handle_ref) => ({
      handle_ref,
      outcome: "VERIFY_UNAVAILABLE",
    })),
    resolved: [],
    rejected: [],
    resolved_count: 0,
  };
}

async function persistUnboundReceipt(
  nativeFixture: NativeFixture,
  receipt: ReturnType<typeof CitationResolutionReceiptV2Schema.parse>,
  access: PersistCitationResolutionInput["access"] = {
    principal_ref: PRINCIPAL_REF,
    client_class: "owner_pwa",
    credential_generation: CREDENTIAL_GENERATION,
  },
): Promise<ReturnType<typeof CitationResolutionReceiptV2Schema.parse>> {
  const persisted = await persistCitationResolutionReceipt(nativeFixture.database, {
    receipt,
    receipt_json: canonicalEvidenceJson(receipt),
    receipt_sha256: await evidenceSha256(receipt),
    access,
    scope: nativeFixture.scope_authority,
    authorization: {
      authorization_receipt_ref: AUTHORIZATION_RECEIPT_REF,
      policy_authority_ref: POLICY_AUTHORITY_REF,
      allowed_use: ["research"],
      disclosure_ceiling: "exact",
      expires_at: nativeFixture.scope_authority.snapshot.expires_at,
    },
  });
  return CitationResolutionReceiptV2Schema.parse(persisted);
}

async function expectGuardRefusal(database: D1Database, draft: ReceiptDraft): Promise<void> {
  const receipt = await sealReceipt(draft);
  const row = await receiptRow(receipt);
  await insertReceipt(database, row).run();
  let failure: unknown;
  try {
    await insertGuard(database, row).run();
  } catch (error) {
    failure = error;
  }
  expect(String(failure)).toContain("CITATION_OUTCOMES_MISMATCH");
  const stored = await storedReceipt(database, row);
  expect(stored).toMatchObject({ verified: null });
}

async function expectReceiptJsonDriftRefusal(
  database: D1Database,
  draft: ReceiptDraft,
  mutate: (receipt: Record<string, unknown>) => void,
): Promise<void> {
  const receipt = CitationResolutionReceiptV2Schema.parse(await sealReceipt(draft));
  const alignedRow = await receiptRow(receipt);
  const driftedRow = await receiptRowWithJsonDrift(alignedRow, mutate);
  expect(driftedRow).toMatchObject({
    requested_handle_refs_json: alignedRow.requested_handle_refs_json,
    resolved_json: alignedRow.resolved_json,
    rejected_json: alignedRow.rejected_json,
    requested_count: alignedRow.requested_count,
    resolved_count: alignedRow.resolved_count,
    outcomes_json: alignedRow.outcomes_json,
  });
  await insertReceipt(database, driftedRow).run();
  let failure: unknown;
  try {
    await insertGuard(database, driftedRow).run();
  } catch (error) {
    failure = error;
  }
  expect(String(failure)).toContain("CITATION_OUTCOMES_MISMATCH");
  const stored = await storedReceipt(database, driftedRow);
  expect(stored).toMatchObject({
    receipt_json: driftedRow.receipt_json,
    receipt_sha256: driftedRow.receipt_sha256,
    requested_handle_refs_json: alignedRow.requested_handle_refs_json,
    resolved_json: alignedRow.resolved_json,
    rejected_json: alignedRow.rejected_json,
    outcomes_json: alignedRow.outcomes_json,
    verified: null,
  });
}

export async function createNativeCitationOutcomesFixture(): Promise<NativeFixture> {
  await reset();
  const database = runtime.CORE_DB;
  const migrations = runtime.CORE_MIGRATIONS;
  const migrationIndex = migrations.findIndex(({ name }) =>
    name.includes("0124_citation_resolution_outcomes"),
  );
  if (migrationIndex < 0) throw new Error("0124 citation outcomes migration is not configured in native D1");
  const outcomesMigration = migrations[migrationIndex];
  if (outcomesMigration === undefined) throw new Error("0124 citation outcomes migration entry is missing");
  await applyD1Migrations(database, migrations.slice(0, migrationIndex));
  const seededScope = await seedScope(database);
  const scopeRef = seededScope.reference;

  const historicalHandle = { id: "historical-v1-handle", revision: 1 };
  const historicalDraft: ReceiptDraft = {
    receipt_ref: { id: "historical-v1-citation", revision: 1 },
    scope_snapshot_ref: scopeRef,
    requested_handle_refs: [historicalHandle],
    resolved: [],
    rejected: [{ handle_ref: historicalHandle, reason_code: "EVIDENCE_HANDLE_NOT_FOUND" }],
    requested_count: 1,
    resolved_count: 0,
    all_material_citations_resolved: false,
    created_at: CREATED_AT,
  };
  const historicalV1 = CitationResolutionReceiptV1Schema.parse(await sealReceipt(historicalDraft));
  const historicalRecord: ReceiptShape = historicalV1;
  const historicalRow = await receiptRow(historicalRecord);
  await insertHistoricalReceipt(database, historicalRow).run();
  await applyD1Migrations(database, [outcomesMigration]);

  return {
    database,
    scope_ref: scopeRef,
    scope_authority: seededScope.authority,
    historical_v1: historicalRecord,
    historical_v1_json: historicalRow.receipt_json,
    historical_v1_sha256: historicalRow.receipt_sha256,
  };

}

export {
  CREATED_AT,
  CREDENTIAL_GENERATION,
  SHA_A,
  SHA_B,
  expectGuardRefusal,
  expectReceiptJsonDriftRefusal,
  insertGuard,
  insertReceipt,
  persistUnboundReceipt,
  receiptRow,
  sealReceipt,
  storedReceipt,
  toReceiptRow,
  unavailableOnlyDraft,
  v2Draft,
  v2DraftFrom,
  v2ProjectionOrderDraft,
};
export type { NativeFixture, ReceiptDraft };
