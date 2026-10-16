import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectClientGrant } from "@eliotr/contracts";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { resolveResearchOwnerSpendPolicy } from "@eliotr/cloudflare-research-configuration/research-owner-spend-policy.js";
import { resolveResearchExecutionSpend } from "../src/research-client-execution.js";
import type { Env } from "../src/env.js";
import { admissionTestConfiguration } from "./research-current-dispatch-config.js";

const db = (env as unknown as { CORE_DB: D1Database }).CORE_DB;
const owner = "spend-grantor";
const service = "spend-service.access";
const operation = "run-spend-regression";
const runDeployment = "persisted-run-deployment";
const templateDeployment = "original-template-deployment";
const policyGeneration = "run-policy-generation";
const expires = new Date(Date.now() + 30 * 60 * 1_000).toISOString();
const scope = { snapshot_id: "spend-scope", revision: 1, policy_authority_ref: "spend-authority", expires_at: expires };
const authorization = { authorization_receipt_ref: "spend-authorization", policy_authority_ref: scope.policy_authority_ref,
  allowed_use: ["research"], disclosure_ceiling: "private", expires_at: expires };

function navigation(ownerCaller = false): NavigationReadAuthority {
  return {
    access: { principal_ref: ownerCaller ? owner : service, client_class: ownerCaller ? "owner_pwa" : "trusted_agent",
      credential_generation: "run-credential" },
    scope,
    current: async () => authorization,
  } as unknown as NavigationReadAuthority;
}

// Real local D1 readers and policy decoders; the scope-authority port is controlled.
// No Workflow execution, provider transport or credential verification is involved.
beforeEach(async () => {
  await reset();
  await db.batch([
    db.prepare("CREATE TABLE project_client_grant (grant_id TEXT,revision INTEGER,project_id TEXT," +
      "grantor_principal_ref TEXT,grantee_issuer TEXT,grantee_method TEXT,grantee_subject TEXT,state TEXT," +
      "expires_at TEXT,record_json TEXT,record_sha256 TEXT,request_sha256 TEXT,spend_policy_protocol TEXT," +
      "spend_policy_sha256 TEXT,spend_deployment_generation TEXT,spend_expires_at TEXT)"),
    db.prepare("CREATE VIEW project_client_grant_current AS SELECT * FROM project_client_grant"),
    db.prepare("CREATE TABLE scope_access_grant_effective (snapshot_id TEXT,snapshot_revision INTEGER," +
      "principal_ref TEXT,credential_generation TEXT,client_class TEXT,project_client_operation TEXT," +
      "project_client_run_operation_id TEXT,project_client_grant_id TEXT,project_client_grant_revision INTEGER," +
      "state TEXT,expires_at TEXT)"),
  ]);
});

async function sponsoredFixture(version: "v1" | "v2") {
  const source = admissionTestConfiguration(templateDeployment, owner, "delegated-spend-regression").spend_policy;
  if (source.protocol !== "eliotr.research-owner-spend-template.v1") throw new Error("Expected the existing v1 fixture");
  const original = { ...source, rules: source.rules.map((rule) => ({ ...rule,
    deployment: { ...rule.deployment, parameters_digest: "a".repeat(64) },
  })) };
  const { deployment_generation, expires_at, ...permanent } = original;
  const template = version === "v1" ? original : { ...permanent, protocol: "eliotr.research-owner-spend-template.v2" as const };
  const raw = canonicalJson(template);
  const hash = await sha256Utf8(raw);
  const grant: ProjectClientGrant = {
    protocol: "eliotr.project-client-grant.v1", grant_id: "spend-grant", revision: 2, project_id: "spend-project",
    grantor_principal_ref: owner, state: "ACTIVE",
    grantee: { issuer: "https://team-example.cloudflareaccess.com", authentication_method: "service_token", subject: service },
    allowed_operations: ["run", "recover", "evidence"], ingest_namespace_ids: [], spend_policy_ref: template.policy_ref,
    expires_at: expires, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const record = canonicalJson(grant);
  const bindingExpiry = version === "v1"
    ? new Date(Math.min(Date.parse(expires), Date.parse(expires_at))).toISOString() : expires;
  await db.batch([
    db.prepare("INSERT INTO project_client_grant VALUES (?1,?2,?3,?4,?5,'service_token',?6,'ACTIVE',?7,?8,?9,?10,?11,?12,?13,?14)")
      .bind(grant.grant_id, grant.revision, grant.project_id, owner, grant.grantee.issuer, service, expires,
        record, await sha256Utf8(record), "b".repeat(64), template.protocol, hash,
        version === "v1" ? deployment_generation : null, bindingExpiry),
    db.prepare("INSERT INTO scope_access_grant_effective VALUES (?1,1,?2,'run-credential','trusted_agent','run',?3,?4,2,'ACTIVE',?5)")
      .bind(scope.snapshot_id, service, operation, grant.grant_id, expires),
  ]);
  const runtime = { CORE_DB: db, DEPLOYMENT_GENERATION: "new-active-deployment",
    ELIOTR_MODEL_SPEND_POLICY_JSON: raw,
    ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: template.config_provenance_ref } as unknown as Env;
  return { template, raw, hash, runtime };
}

describe("delegated Research execution spend policy on native D1", () => {
  it("binds a generation-free v2 sponsor template to the persisted service run deployment", async () => {
    const fixture = await sponsoredFixture("v2");
    expect(fixture.template).not.toHaveProperty("deployment_generation");
    const policy = await resolveResearchExecutionSpend(fixture.runtime, navigation(), operation, runDeployment, policyGeneration);
    expect(policy).toMatchObject({ protocol: "eliotr.research-delegated-model-spend-policy.v1",
      principal_ref: service, client_class: "trusted_agent", credential_generation: "run-credential",
      deployment_generation: runDeployment, policy_generation: policyGeneration,
      sponsor_principal_ref: owner, sponsor_policy_sha256: fixture.hash,
      policy_ref: fixture.template.policy_ref, config_provenance_ref: fixture.template.config_provenance_ref });
    expect(policy.rules).toEqual(fixture.template.rules);
    expect(fixture.runtime.ELIOTR_MODEL_SPEND_POLICY_JSON).toBe(fixture.raw);
    expect(await db.prepare("SELECT spend_policy_sha256,spend_deployment_generation FROM project_client_grant")
      .first()).toEqual({ spend_policy_sha256: fixture.hash, spend_deployment_generation: null });
  });

  it("keeps the owner v2 binding identical to the existing owner resolver", async () => {
    const fixture = await sponsoredFixture("v2");
    const ownerNavigation = navigation(true);
    const expected = resolveResearchOwnerSpendPolicy({ raw: fixture.raw,
      provenance: fixture.template.config_provenance_ref, access: ownerNavigation.access,
      deployment_generation: runDeployment, policy_generation: policyGeneration,
      policy_authority_ref: scope.policy_authority_ref, scope_expires_at: expires, authorization }).policy;
    expect(await resolveResearchExecutionSpend(fixture.runtime, ownerNavigation, operation, runDeployment, policyGeneration))
      .toEqual(expected);
    expect(expected.principal_ref).toBe(owner);
  });

  it("still denies v1 sponsorship bound to a different deployment", async () => {
    const fixture = await sponsoredFixture("v1");
    await expect(resolveResearchExecutionSpend(fixture.runtime, navigation(), operation, runDeployment, policyGeneration))
      .rejects.toMatchObject({ code: "CLIENT_RUN_AUTHORITY_STALE", status: 403 });
  });
});
