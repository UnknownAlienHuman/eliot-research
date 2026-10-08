import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readDeploymentWorker } from "./lib/deployment-verification.mjs";
import { createMaintenanceMcpAccessBaselineObservation, createMaintenanceMcpAccessTransitionIntent,
  loadMaintenanceMcpAccessTransition, readVerifiedMcpAccessEvidence,
  requireUnchangedMaintenanceMcpAccessTransition } from "./lib/deployment-mcp-access-transition.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const repositoryRoot = resolve(tmpdir());
const accountId = "a".repeat(32);
const hostname = ["eliotr-core", "example-subdomain", "workers.dev"].join(".");
const teamDomain = "https://example.cloudflareaccess.com";
const pwaAud = "fixture-pwa-audience";
const mcpAud = "fixture-managed-mcp-audience";
const oldMcpAud = "fixture-old-mcp-audience";
const ownerEmail = "owner@example.test";
const ownerHash = sha256(Buffer.from(ownerEmail, "utf8"));
const sourceHead = "b".repeat(40);
const candidateGeneration = `git-${sourceHead.slice(0, 12)}`;
const deploymentId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const applicationId = "33333333-3333-4333-8333-333333333333";
const policyId = "44444444-4444-4444-8444-444444444444";
const candidateConfig = {
  name: "eliotr-core",
  compatibility_date: "2026-08-28",
  compatibility_flags: [],
  exports: { ResearchSession: { type: "durable-object", storage: "sqlite" } },
  d1_databases: [], r2_buckets: [], queues: { producers: [] }, durable_objects: { bindings: [] },
  workflows: [], analytics_engine_datasets: [], ai: { binding: "AI" }, assets: { binding: "ASSETS" },
  wasm_modules: {}, ai_search_namespaces: [], ai_search: [],
  vars: {
    DEPLOYMENT_GENERATION: candidateGeneration,
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_AUDIENCE: pwaAud,
    ACCESS_SERVICE_PRINCIPALS: "",
    MCP_HOSTNAME: hostname,
    MCP_ACCESS_TEAM_DOMAIN: teamDomain,
    MCP_ACCESS_AUDIENCE: mcpAud,
    MCP_ACCESS_AUTH_PROFILE: "managed-oauth",
  },
};
const candidateConfigurationSha256 = sha256(Buffer.from(JSON.stringify(candidateConfig), "utf8"));
const identity = { worker_id: "eliotr-core", deployment_id: deploymentId, version_id: versionId,
  generation: "git-old-baseline" };
const input = { apiBase: "https://api.cloudflare.com/client/v4" };
const environment = { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: "fixture-token" };
const candidateRuntime = Object.freeze({ protocol: "eliotr.approved-runtime-candidate.v1",
  deployment_generation: candidateGeneration, configuration_sha256: candidateConfigurationSha256 });

function json(data) {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

function workerVersion(overrides = {}) {
  const bindings = {
    DEPLOYMENT_GENERATION: { type: "plain_text", text: identity.generation },
    ACCESS_TEAM_DOMAIN: { type: "plain_text", text: teamDomain },
    ACCESS_AUDIENCE: { type: "plain_text", text: pwaAud },
    ACCESS_SERVICE_PRINCIPALS: { type: "plain_text", text: "" },
    MCP_HOSTNAME: { type: "plain_text", text: hostname },
    MCP_ACCESS_TEAM_DOMAIN: { type: "plain_text", text: teamDomain },
    MCP_ACCESS_AUDIENCE: { type: "plain_text", text: oldMcpAud },
    MCP_ACCESS_AUTH_PROFILE: { type: "plain_text", text: "service-token" },
    MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS: { type: "plain_text", text: '["fixture-worker.access"]' },
    AI: { type: "ai" },
    ASSETS: { type: "assets" },
    ...overrides.bindings,
  };
  return {
    id: versionId,
    number: 3,
    resources: {
      bindings,
      script: { etag: "fixture-etag" },
      script_runtime: {
        compatibility_date: "2026-08-28T00:00:00Z",
        compatibility_flags: [],
        exports: { default: { type: "worker" }, ResearchSession: { type: "durable-object", storage: "sqlite" } },
      },
    },
  };
}

function mockFetch(version = workerVersion()) {
  const worker = { id: "eliotr-core", compatibility_date: "2026-08-28", has_assets: true };
  const deployment = { id: deploymentId, created_on: "2026-10-03T00:00:00.000Z", strategy: "percentage",
    versions: [{ version_id: versionId, percentage: 100 }] };
  return async (url) => {
    const value = String(url);
    if (value.endsWith("/workers/scripts")) return json({ success: true, result: [worker] });
    if (value.endsWith("/deployments")) return json({ success: true, result: { deployments: [deployment] } });
    if (value.endsWith(`/versions/${versionId}`)) return json({ success: true, result: version });
    assert.fail(`unexpected Worker readback URL: ${value}`);
  };
}

function accessFixture() {
  const receipt = {
    protocol: "eliotr.cloudflare-access-receipt.v1",
    account_id: accountId,
    hostname,
    aud: pwaAud,
    team_domain: teamDomain,
    application: { id: "55555555-5555-4555-8555-555555555555", name: "Fixture PWA",
      destination: hostname, disposition: "VERIFIED" },
    policy: { id: "66666666-6666-4666-8666-666666666666", name: "Fixture PWA owners",
      owner_email_count: 1, owner_email_set_sha256: ownerHash, disposition: "VERIFIED" },
    mcp: {
      hostname, path: "/mcp", path_cookie_attribute: true, team_domain: teamDomain, aud: mcpAud,
      auth_profile: "managed-oauth", oauth_configuration_enabled: true,
      application: { id: applicationId, name: "Fixture MCP", destination: `${hostname}/mcp`, disposition: "UNCHANGED" },
      policy: { id: policyId, name: "Fixture MCP owners", decision: "allow", selector: "email",
        owner_email_count: 1, owner_email_set_sha256: ownerHash, disposition: "UNCHANGED" },
    },
  };
  const apiSummary = {
    kind: "cloudflare-access-api-readback-summary",
    protocol: "eliotr.cloudflare-access-api-readback-summary.v1",
    source: "Authenticated Cloudflare connector create response plus exact follow-up GET readback",
    observed_on: "2026-10-03",
    account_id: accountId,
    application: { id: applicationId, name: "Fixture MCP", type: "self_hosted", domain: `${hostname}/mcp`,
      destination: `${hostname}/mcp`, session_duration: "24h", app_launcher_visible: false,
      path_cookie_attribute: true, oauth_configuration_enabled: true, aud: mcpAud,
      create_status: 201, readback_status: 200, readback_exact: true },
    policy: { count: 1, decision: "allow", approved_email: ownerEmail, excludes: 0, requires: 0, readback_exact: true },
    organization: { team_domain: teamDomain, readback_exact: true },
    preserved_application: { id: receipt.application.id, name: receipt.application.name,
      session_duration: "168h", aud: pwaAud, policy_count: 1, unchanged: true },
    limitation: "Local summary of exact GET readbacks; supported runtime receipt is verified separately.",
    runtime_receipt_generated: false,
  };
  const apiBytes = Buffer.from(`${JSON.stringify(apiSummary, null, 2)}\n`, "utf8");
  const configHash = candidateConfigurationSha256;
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  const summary = {
    protocol: "eliotr.cloudflare-access-verify-existing-summary.v1",
    disposition: "VERIFIED",
    method: "supported-provisioner --verify-existing",
    receipt_protocol: receipt.protocol,
    receipt_sha256: sha256(receiptBytes),
    api_readback_summary_sha256: sha256(apiBytes),
    account_id: accountId,
    managed_oauth_profile: "managed-oauth",
    team_domain: teamDomain,
    hostname,
    mcp: { application_id: applicationId, application_name: "Fixture MCP", destination: `${hostname}/mcp`,
      aud: mcpAud, path: "/mcp", policy_id: policyId, policy_decision: "allow", selector: "email",
      owner_email_count: 1, owner_email_set_sha256: ownerHash, session_duration: "24h" },
    preserved_pwa: { application_id: receipt.application.id, aud: pwaAud, session_duration: "168h" },
    generated_worker_config_sha256_before: configHash,
    generated_worker_config_sha256_after: configHash,
    static_token_environment_scrubbed: true,
    child_exit_code: 0,
    verified_at: "2026-10-03T00:00:00.000Z",
  };
  return { receipt, apiBytes, summary, receiptBytes };
}

let checks = 0;
async function check(name, action) {
  await action();
  checks += 1;
  console.log(`Managed-OAuth MCP transition: ${name}: PASS`);
}

async function withEvidence(action) {
  const root = await mkdtemp(join(repositoryRoot, "eliotr-mcp-access-transition-"));
  if (dirname(resolve(root)) !== repositoryRoot || !basename(root).startsWith("eliotr-mcp-access-transition-")) {
    throw new Error("MCP transition fixture escaped the OS temporary directory");
  }
  const state = resolve(root, ".eliotr-state");
  const completion = resolve(state, "completion-20261003");
  await mkdir(completion, { recursive: true });
  const paths = {
    receipt: resolve(state, "cloudflare-access-receipt.json"),
    api: resolve(completion, "mcp-access-api-readback-summary.json"),
    summary: resolve(completion, "mcp-access-verify-existing-summary.json"),
    intent: resolve(completion, "mcp-access-transition-intent.json"),
  };
  const fixture = accessFixture();
  await writeFile(paths.receipt, fixture.receiptBytes, { flag: "wx" });
  await writeFile(paths.api, fixture.apiBytes, { flag: "wx" });
  await writeFile(paths.summary, `${JSON.stringify(fixture.summary, null, 2)}\n`, { flag: "wx" });
  try {
    await action({ root, paths, fixture });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readBaseline({ evidence, version }) {
  const observation = createMaintenanceMcpAccessBaselineObservation({ evidence, accountId, sourceHead,
    candidateGeneration, candidateConfigurationSha256, candidateConfig, activeWorkerIdentity: identity });
  return readDeploymentWorker(environment, input, candidateConfig, {
    fetchImpl: mockFetch(version), observedDeploymentGeneration: identity.generation,
    approvedRuntimeCandidate: candidateRuntime, mcpAccessBaselineObservation: observation,
  });
}

await check("verified standard receipt and pinned API readback authorize only the managed-OAuth candidate", async () => {
  await withEvidence(async ({ root, paths, fixture }) => {
    const evidence = await readVerifiedMcpAccessEvidence({ root, receiptPath: paths.receipt,
      summaryPath: paths.summary, apiReadbackSummaryPath: paths.api, accountId, publicHostname: hostname,
      expectedConfigurationSha256: candidateConfigurationSha256, candidateConfig });
    assert.equal(evidence.authority.mcp.auth_profile, "managed-oauth");
    const readback = await readBaseline({ evidence, root });
    assert.equal(readback.configuration_baseline.configuration.variables.MCP_ACCESS_AUTH_PROFILE.value, "service-token");
    assert.equal(readback.configuration_baseline.configuration.variables.MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS.value,
      '["fixture-worker.access"]');
    assert.equal(readback.deployment_id, deploymentId);
    assert.equal(fixture.summary.mcp.session_duration, "24h");
  });
});

await check("exact baseline intent permits the approved MCP transition and revalidation", async () => {
  await withEvidence(async ({ root, paths }) => {
    const evidence = await readVerifiedMcpAccessEvidence({ root, receiptPath: paths.receipt,
      summaryPath: paths.summary, apiReadbackSummaryPath: paths.api, accountId, publicHostname: hostname,
      expectedConfigurationSha256: candidateConfigurationSha256, candidateConfig });
    const readback = await readBaseline({ evidence, root });
    const intent = createMaintenanceMcpAccessTransitionIntent({ evidence, accountId, sourceHead,
      candidateGeneration, candidateConfigurationSha256, candidateConfig, activeWorkerIdentity: identity,
      baselineConfigurationBaseline: readback.configuration_baseline });
    await writeFile(paths.intent, `${JSON.stringify(intent, null, 2)}\n`, { flag: "wx" });
    const transition = await loadMaintenanceMcpAccessTransition({ path: paths.intent, root, accountId, sourceHead,
      candidateGeneration, candidateConfigurationSha256, candidateConfig, activeWorkerIdentity: identity });
    const verified = await readDeploymentWorker(environment, input, candidateConfig, {
      fetchImpl: mockFetch(), observedDeploymentGeneration: identity.generation,
      expectedConfigurationBaseline: readback.configuration_baseline, approvedRuntimeCandidate: candidateRuntime,
      approvedMcpAccessTransition: transition,
    });
    assert.deepEqual(verified.configuration_baseline, readback.configuration_baseline);
    assert.equal((await requireUnchangedMaintenanceMcpAccessTransition({ transition })).state, "PASS");
    const candidateVersion = workerVersion({ bindings: Object.fromEntries(Object.entries(candidateConfig.vars).map(([name, value]) =>
      [name, typeof value === "string" ? { type: "plain_text", text: value } : { type: "json", json: value }])) });
    delete candidateVersion.resources.bindings.MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS;
    const finalReadback = await readDeploymentWorker(environment, input, candidateConfig, {
      fetchImpl: mockFetch(candidateVersion),
    });
    assert.equal(finalReadback.deployment_generation_binding, "PASS");
    assert.equal(finalReadback.vars_readback.state, "PASS");
    await assert.rejects(readDeploymentWorker(environment, input, candidateConfig, { fetchImpl: mockFetch() }),
      /generation binding drift/u);
  });
});

await check("ordinary Access drift and changed MCP baseline fail before upload", async () => {
  await withEvidence(async ({ root, paths }) => {
    const evidence = await readVerifiedMcpAccessEvidence({ root, receiptPath: paths.receipt,
      summaryPath: paths.summary, apiReadbackSummaryPath: paths.api, accountId, publicHostname: hostname,
      expectedConfigurationSha256: candidateConfigurationSha256, candidateConfig });
    const initial = await readBaseline({ evidence, root });
    const intent = createMaintenanceMcpAccessTransitionIntent({ evidence, accountId, sourceHead,
      candidateGeneration, candidateConfigurationSha256, candidateConfig, activeWorkerIdentity: identity,
      baselineConfigurationBaseline: initial.configuration_baseline });
    await writeFile(paths.intent, `${JSON.stringify(intent, null, 2)}\n`, { flag: "wx" });
    const transition = await loadMaintenanceMcpAccessTransition({ path: paths.intent, root, accountId, sourceHead,
      candidateGeneration, candidateConfigurationSha256, candidateConfig, activeWorkerIdentity: identity });
    const pwaDrift = workerVersion({ bindings: { ACCESS_AUDIENCE: { type: "plain_text", text: "drifted-pwa" } } });
    await assert.rejects(readDeploymentWorker(environment, input, candidateConfig, {
      fetchImpl: mockFetch(pwaDrift), observedDeploymentGeneration: identity.generation,
      expectedConfigurationBaseline: initial.configuration_baseline, approvedRuntimeCandidate: candidateRuntime,
      approvedMcpAccessTransition: transition,
    }), /variable readback drift/u);
    const mcpDrift = workerVersion({ bindings: { MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS: {
      type: "plain_text", text: '["different-worker.access"]',
    } } });
    await assert.rejects(readDeploymentWorker(environment, input, candidateConfig, {
      fetchImpl: mockFetch(mcpDrift), observedDeploymentGeneration: identity.generation,
      expectedConfigurationBaseline: initial.configuration_baseline, approvedRuntimeCandidate: candidateRuntime,
      approvedMcpAccessTransition: transition,
    }), /pinned baseline/u);
  });
});

await check("all-absent MCP baseline is exact, partial or drifted state fails, and candidate readback stays strict", async () => {
  await withEvidence(async ({ root, paths }) => {
    const evidence = await readVerifiedMcpAccessEvidence({ root, receiptPath: paths.receipt,
      summaryPath: paths.summary, apiReadbackSummaryPath: paths.api, accountId, publicHostname: hostname,
      expectedConfigurationSha256: candidateConfigurationSha256, candidateConfig });
    const absentVersion = workerVersion();
    for (const name of ["MCP_HOSTNAME", "MCP_ACCESS_TEAM_DOMAIN", "MCP_ACCESS_AUDIENCE", "MCP_ACCESS_AUTH_PROFILE",
      "MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID", "MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS"]) {
      delete absentVersion.resources.bindings[name];
    }
    const baseline = await readBaseline({ evidence, version: absentVersion });
    assert.equal(Object.keys(baseline.configuration_baseline.configuration.variables)
      .some((name) => name.startsWith("MCP_")), false);
    const intent = createMaintenanceMcpAccessTransitionIntent({ evidence, accountId, sourceHead,
      candidateGeneration, candidateConfigurationSha256, candidateConfig, activeWorkerIdentity: identity,
      baselineConfigurationBaseline: baseline.configuration_baseline });
    await writeFile(paths.intent, `${JSON.stringify(intent, null, 2)}\n`, { flag: "wx" });
    const transition = await loadMaintenanceMcpAccessTransition({ path: paths.intent, root, accountId, sourceHead,
      candidateGeneration, candidateConfigurationSha256, candidateConfig, activeWorkerIdentity: identity });
    const unchanged = await readDeploymentWorker(environment, input, candidateConfig, {
      fetchImpl: mockFetch(absentVersion), observedDeploymentGeneration: identity.generation,
      expectedConfigurationBaseline: baseline.configuration_baseline, approvedRuntimeCandidate: candidateRuntime,
      approvedMcpAccessTransition: transition,
    });
    assert.deepEqual(unchanged.configuration_baseline, baseline.configuration_baseline);

    const oneVariableDrift = structuredClone(absentVersion);
    oneVariableDrift.resources.bindings.MCP_HOSTNAME = { type: "plain_text", text: hostname };
    await assert.rejects(readDeploymentWorker(environment, input, candidateConfig, {
      fetchImpl: mockFetch(oneVariableDrift), observedDeploymentGeneration: identity.generation,
      expectedConfigurationBaseline: baseline.configuration_baseline, approvedRuntimeCandidate: candidateRuntime,
      approvedMcpAccessTransition: transition,
    }), /exact pinned baseline/u);

    const partialVersion = structuredClone(absentVersion);
    partialVersion.resources.bindings.MCP_ACCESS_AUTH_PROFILE = { type: "plain_text", text: "service-token" };
    await assert.rejects(readBaseline({ evidence, version: partialVersion }), /fully absent or have a complete configured profile/u);
    const unknownVersion = structuredClone(absentVersion);
    unknownVersion.resources.bindings.MCP_ACCESS_UNEXPECTED = { type: "plain_text", text: "fixture-value" };
    await assert.rejects(readBaseline({ evidence, version: unknownVersion }), /undeclared binding or secret/u);

    const candidateVersion = workerVersion({ bindings: Object.fromEntries(Object.entries(candidateConfig.vars).map(([name, value]) =>
      [name, typeof value === "string" ? { type: "plain_text", text: value } : { type: "json", json: value }])) });
    for (const name of ["MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID", "MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS"]) {
      delete candidateVersion.resources.bindings[name];
    }
    delete candidateVersion.resources.bindings.MCP_ACCESS_AUDIENCE;
    await assert.rejects(readDeploymentWorker(environment, input, candidateConfig, {
      fetchImpl: mockFetch(candidateVersion),
    }), /Worker version variable readback drift/u);
  });
});

await check("candidate with wrong audience and forged service-token receipt are denied", async () => {
  await withEvidence(async ({ root, paths, fixture }) => {
    const wrongCandidate = structuredClone(candidateConfig);
    wrongCandidate.vars.MCP_ACCESS_AUDIENCE = "unverified-mcp-audience";
    await assert.rejects(readVerifiedMcpAccessEvidence({ root, receiptPath: paths.receipt,
      summaryPath: paths.summary, apiReadbackSummaryPath: paths.api, accountId, publicHostname: hostname,
      expectedConfigurationSha256: candidateConfigurationSha256, candidateConfig: wrongCandidate }));
    const forgedReceipt = structuredClone(fixture.receipt);
    forgedReceipt.mcp.service_token_id = "secret-fixture-token";
    const receiptBytes = Buffer.from(`${JSON.stringify(forgedReceipt, null, 2)}\n`, "utf8");
    await writeFile(paths.receipt, receiptBytes);
    const summary = structuredClone(fixture.summary);
    summary.receipt_sha256 = sha256(receiptBytes);
    await writeFile(paths.summary, `${JSON.stringify(summary, null, 2)}\n`);
    await assert.rejects(readVerifiedMcpAccessEvidence({ root, receiptPath: paths.receipt,
      summaryPath: paths.summary, apiReadbackSummaryPath: paths.api, accountId, publicHostname: hostname,
      expectedConfigurationSha256: candidateConfigurationSha256, candidateConfig }),
    (error) => /receipt authority|receipt is malformed|unsupported fields/u.test(error.message) &&
      !error.message.includes("secret-fixture-token"));
  });
});

console.log(`Managed-OAuth MCP transition focused tests: PASS (${checks} cases)`);
