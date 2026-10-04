import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "@eliotr/cloudflare-access";
import { evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import type { ApplicationLifecycle } from "@eliotr/interfaces";
import { createSourceNamespaceOwnerService } from "../src/source-namespace-owner-service.js";
import { handleHttp } from "../src/http.js";
import type { NamespaceBootstrapProfileReader } from "@eliotr/cloudflare-navigation";
import { readOwnerPolicyLeaseHistory } from "../../../packages/cloudflare-navigation/src/owner-policy-lease-history.js";
import { originalReport, runtime } from "./artifact-cow-http-fixture.js";
import { principal } from "./research-evidence-freeze-fixture.js";

const unusedProfiles = {
  listCurrent: () => [],
  requireCurrent: () => { throw new Error("history renewal must not load a bootstrap profile"); },
} as unknown as NamespaceBootstrapProfileReader;

const reportRuntime = { ...runtime, DEPLOYMENT_GENERATION: principal.deployment_generation };

function appFactory() {
  const owner = createSourceNamespaceOwnerService({ database: runtime.CORE_DB, profiles: unusedProfiles, now: Date.now });
  return () => ({
    services: { owner: { renewSourceNamespace: owner.renew }, semantic: {}, federation: {} },
    readiness: async () => ({ ready: true, blocking_reason_codes: [] }),
    reconcile: async () => ({ repaired: 0, still_pending: 0 }),
  }) as unknown as ApplicationLifecycle;
}

function verifier(credentialGeneration: string, expiresAt: string): AccessVerifier {
  return { async verify() {
    return { principal_ref: principal.principal_ref, credential_generation: credentialGeneration,
      authentication_method: "cloudflare_access", expires_at: expiresAt };
  } };
}

async function readMetadata(artifactRef: { readonly id: string; readonly revision: number }, accessVerifier: AccessVerifier) {
  return handleHttp(new Request(
    `https://research.example/api/v1/research/artifact/${encodeURIComponent(`${artifactRef.id}:${artifactRef.revision}`)}/reauthorize`,
    { method: "POST" },
  ), reportRuntime, {} as ExecutionContext, { accessVerifier, applicationFactory: appFactory() });
}

async function readSection(
  artifactRef: { readonly id: string; readonly revision: number },
  sectionRef: { readonly id: string; readonly revision: number },
  accessVerifier: AccessVerifier,
) {
  return handleHttp(new Request(
    `https://research.example/api/v1/research/artifact/${encodeURIComponent(`${artifactRef.id}:${artifactRef.revision}`)}` +
    `/sections/${encodeURIComponent(`${sectionRef.id}:${sectionRef.revision}`)}/reauthorize`,
    { method: "POST" },
  ), reportRuntime, {} as ExecutionContext, { accessVerifier, applicationFactory: appFactory() });
}

async function sectionProblemCode(response: Response): Promise<string> {
  try {
    const body = await response.clone().json() as { readonly code?: unknown };
    return typeof body.code === "string" ? body.code : "unknown-problem";
  } catch {
    return "non-json-error";
  }
}

describe("owner session lease history over native HTTP and D1", () => {
  it("reopens an original REPORT after same-owner lease refresh with identical bytes and no new model work", async () => {
    const report = await originalReport("observation", true, { seedVerifiedOwnerNamespace: true });
    const sourceRevisionRef = report.freeze.scope.member_source_revision_refs[0];
    const section = report.snapshot.sections[0]?.section;
    if (sourceRevisionRef === undefined || section === undefined) throw new Error("original REPORT source or section is missing");
    const namespace = await runtime.CORE_DB.prepare(
      "SELECT s.source_namespace_id FROM source_revision r JOIN source s ON s.source_id=r.source_id " +
      "WHERE r.source_revision_ref=?1",
    ).bind(sourceRevisionRef).first<{ readonly source_namespace_id: string }>();
    if (namespace === null) throw new Error("original REPORT namespace is missing");
    const initialization = await runtime.CORE_DB.prepare(
      "SELECT i.owner_incarnation_ref,i.source_owner_generation,i.scope_policy_ref,o.owner_system_id " +
      "FROM source_namespace_initialization i JOIN source_namespace_ownership o " +
      "ON o.source_namespace_id=i.source_namespace_id AND o.ownership_record_revision=i.ownership_record_revision " +
      "WHERE i.source_namespace_id=?1 AND i.principal_ref=?2",
    ).bind(namespace.source_namespace_id, principal.principal_ref).first<{
      readonly owner_incarnation_ref: string;
      readonly source_owner_generation: string;
      readonly scope_policy_ref: string;
      readonly owner_system_id: string;
    }>();
    expect(initialization).toMatchObject({
      owner_system_id: "eliotr", owner_incarnation_ref: "owner-history-incarnation-v1",
      source_owner_generation: "owner-history-generation-v1",
      scope_policy_ref: `freeze-read-${namespace.source_namespace_id}`,
    });

    const oldCredential = verifier(principal.credential_generation, new Date(Date.now() + 7_200_000).toISOString());
    const beforeMetadata = await readMetadata(report.artifact_ref, oldCredential);
    expect(beforeMetadata.status).toBe(200);
    const beforeBody = await beforeMetadata.json() as { readonly data: { readonly artifact: unknown } };
    const beforeSection = await readSection(report.artifact_ref, section.section_ref, oldCredential);
    expect(beforeSection.status, beforeSection.status === 200 ? "" : await sectionProblemCode(beforeSection)).toBe(200);
    const originalBytes = new Uint8Array(await beforeSection.arrayBuffer());
    expect(await evidenceSha256Bytes(originalBytes)).toBe(section.body_sha256);
    const modelAttemptCount = await runtime.CORE_DB.prepare(
      "SELECT COUNT(*) AS count FROM research_model_attempt",
    ).first<{ readonly count: number }>();
    if (modelAttemptCount === null) throw new Error("model attempt count is unavailable");
    const reportIntent = await runtime.CORE_DB.prepare(
      "SELECT * FROM operation_intent WHERE intent_id=(SELECT intent_id FROM research_report_admission WHERE operation_id=?1)",
    ).bind(report.freeze.operation_id).first<Record<string, unknown>>();
    const reportOutbox = await runtime.CORE_DB.prepare(
      "SELECT * FROM outbox WHERE intent_id=(SELECT intent_id FROM research_report_admission WHERE operation_id=?1)",
    ).bind(report.freeze.operation_id).first<Record<string, unknown>>();

    const nextExpiry = new Date(Date.now() + 21_600_000).toISOString();
    const newCredential = `history-refresh-${crypto.randomUUID()}`;
    const renewed = await handleHttp(new Request(
      `https://research.example/api/v1/library/namespaces/${encodeURIComponent(namespace.source_namespace_id)}/renew`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_generation: 1 }) },
    ), reportRuntime, {} as ExecutionContext, {
      accessVerifier: verifier(newCredential, nextExpiry), applicationFactory: appFactory(),
    });
    expect(renewed.status, JSON.stringify(await renewed.clone().json())).toBe(200);
    expect(await renewed.json()).toMatchObject({ data: {
      source_namespace_id: namespace.source_namespace_id, read_policy_generation: 2,
      read_expires_at: nextExpiry, read_access: "ACTIVE",
    } });

    const leaseHistory = await readOwnerPolicyLeaseHistory({
      database: runtime.CORE_DB,
      snapshot_id: report.freeze.scope.snapshot_id,
      snapshot_revision: report.freeze.scope.revision,
      principal_ref: principal.principal_ref,
      now: new Date().toISOString(),
      allow_lease_refresh: true,
    });
    expect(leaseHistory).not.toBeNull();
    if (leaseHistory === null) throw new Error("original REPORT owner lease-history proof is missing");
    expect(leaseHistory.has_lease_events).toBe(true);
    expect(leaseHistory.original_access).toMatchObject({ principal_ref: principal.principal_ref, client_class: "owner_pwa" });
    expect(leaseHistory.baseline_policies).toHaveLength(1);

    const afterMetadata = await readMetadata(report.artifact_ref, verifier(newCredential, nextExpiry));
    expect(afterMetadata.status, JSON.stringify(await afterMetadata.clone().json())).toBe(200);
    const afterBody = await afterMetadata.json() as { readonly data: { readonly artifact: unknown } };
    expect(afterBody.data.artifact).toEqual(beforeBody.data.artifact);
    const afterSection = await readSection(report.artifact_ref, section.section_ref, verifier(newCredential, nextExpiry));
    expect(afterSection.status, afterSection.status === 200 ? "" : await sectionProblemCode(afterSection)).toBe(200);
    expect(new Uint8Array(await afterSection.arrayBuffer())).toEqual(originalBytes);
    expect(await runtime.CORE_DB.prepare("SELECT COUNT(*) AS count FROM research_model_attempt")
      .first<{ readonly count: number }>()).toEqual(modelAttemptCount);
    expect(await runtime.CORE_DB.prepare(
      "SELECT * FROM operation_intent WHERE intent_id=(SELECT intent_id FROM research_report_admission WHERE operation_id=?1)",
    ).bind(report.freeze.operation_id).first<Record<string, unknown>>()).toEqual(reportIntent);
    expect(await runtime.CORE_DB.prepare(
      "SELECT * FROM outbox WHERE intent_id=(SELECT intent_id FROM research_report_admission WHERE operation_id=?1)",
    ).bind(report.freeze.operation_id).first<Record<string, unknown>>()).toEqual(reportOutbox);

    const receipt = await runtime.CORE_DB.prepare(
      "SELECT receipt_sequence,refresh_id,state,old_generation,new_generation,old_created_at,old_expires_at,new_expires_at,access_expires_at " +
      "FROM scope_read_policy_lease_refresh_receipt WHERE source_namespace_id=?1 AND principal_ref=?2",
    ).bind(namespace.source_namespace_id, principal.principal_ref).first<{
      readonly receipt_sequence: number;
      readonly refresh_id: string;
      readonly state: string;
      readonly old_generation: number;
      readonly new_generation: number;
      readonly old_created_at: string;
      readonly old_expires_at: string;
      readonly new_expires_at: string;
      readonly access_expires_at: string;
    }>();
    if (receipt === null) throw new Error("lease refresh receipt is missing");
    expect(receipt).toMatchObject({ state: "APPLIED", old_generation: 1, new_generation: 2,
      new_expires_at: nextExpiry, access_expires_at: nextExpiry });
    const event = await runtime.CORE_DB.prepare(
      "SELECT history_event_sequence,event_kind,receipt_sequence,refresh_id,old_created_at,new_created_at " +
      "FROM scope_read_policy_history_event WHERE receipt_sequence=?1 AND refresh_id=?2",
    ).bind(receipt.receipt_sequence, receipt.refresh_id).first<{
      readonly history_event_sequence: number;
      readonly event_kind: string;
      readonly receipt_sequence: number;
      readonly refresh_id: string;
      readonly old_created_at: string;
      readonly new_created_at: string;
    }>();
    if (event === null) throw new Error("APPLIED lease receipt has no shared history event");
    expect(event).toEqual({ history_event_sequence: expect.any(Number), event_kind: "LEASE_REFRESH",
      receipt_sequence: receipt.receipt_sequence, refresh_id: receipt.refresh_id,
      old_created_at: receipt.old_created_at, new_created_at: receipt.old_created_at });
    const baseline = await runtime.CORE_DB.prepare(
      "SELECT history_event_sequence_floor,receipt_sequence_floor " +
      "FROM scope_read_policy_snapshot_baseline WHERE snapshot_id=?1 AND snapshot_revision=?2",
    ).bind(report.freeze.scope.snapshot_id, report.freeze.scope.revision).first<{
      readonly history_event_sequence_floor: number;
      readonly receipt_sequence_floor: number;
    }>();
    if (baseline === null) throw new Error("original report snapshot baseline is missing");
    expect(event.history_event_sequence).toBeGreaterThan(baseline.history_event_sequence_floor);
    expect(receipt.receipt_sequence).toBeGreaterThan(baseline.receipt_sequence_floor);
    expect(report.original_model_calls).toBeGreaterThan(0);
  }, 30_000);
});
