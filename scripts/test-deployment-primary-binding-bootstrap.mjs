import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { assertMaintenancePrimaryBindingBootstrapProfile, loadMaintenancePrimaryBindingBootstrap,
  requireUnchangedMaintenancePrimaryBindingBootstrap, withoutPrimaryBindingAdditions } from
  "./lib/deployment-primary-binding-bootstrap.mjs";

const sourceHead = "a".repeat(40);
const candidateGeneration = `git-${sourceHead.slice(0, 12)}`;
const baselineGeneration = "git-baseline-old";
const deploymentId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const accountId = "fixture-account";
const bucketName = "eliotr-backup-parts-fixture";
const baselineConfigurationSha256 = "b".repeat(64);
const candidateConfigurationSha256 = "c".repeat(64);
const receiptProtocol = "eliotr.r2-bucket-creation-receipt.v1";
const bootstrapProtocol = "eliotr.maintenance-primary-binding-bootstrap.v1";
const receiptMetadata = {
  protocol: receiptProtocol, account_id: accountId, bucket_name: bucketName,
  jurisdiction: "default", storage_class: "Standard", preexisting: false,
  create_count: 1, create_readback: "PASS", existence_readback: "PASS",
};
const baselineIdentity = {
  worker_id: "eliotr-core", deployment_id: deploymentId, version_id: versionId,
  generation: baselineGeneration, traffic_percentage: 100, ai_search_bound: true,
};
const candidateConfig = {
  r2_buckets: [
    { binding: "EVIDENCE_BUCKET", bucket_name: "eliotr-evidence-fixture" },
    { binding: "BACKUP_PARTS_BUCKET", bucket_name: bucketName },
  ],
  version_metadata: { binding: "VERSION_METADATA" },
  ai_search_namespaces: [{ binding: "AI_SEARCH", namespace: "eliotr", remote: true }],
  vars: { DEPLOYMENT_GENERATION: candidateGeneration },
};
const baselineConfig = withoutPrimaryBindingAdditions(candidateConfig);
const baselineConfigurationBaseline = {
  deployment_id: deploymentId, version_id: versionId, deployment_generation: baselineGeneration,
  configuration_sha256: baselineConfigurationSha256,
  configuration: { version: { bindings: [
    { bindingName: "EVIDENCE_BUCKET", type: "r2_bucket", bucket_name: "eliotr-evidence-fixture" },
    { bindingName: "AI_SEARCH", type: "ai_search_namespace", namespace: "eliotr" },
  ] } },
};
const candidateCapabilities = {
  disabled_slices: ["RETRIEVAL", "ERASURE"], enabled_slices: ["HEALTH", "ACCESS"], partial_slices: [],
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
let cases = 0;

const check = async (name, action) => {
  await action();
  cases += 1;
  console.log(`Primary binding bootstrap: ${name}: PASS`);
};

async function removeFixture(directory, temporaryRoot, prefix) {
  const absolute = resolve(directory);
  if (dirname(absolute) !== temporaryRoot || !basename(absolute).startsWith(prefix)) {
    throw new Error("Refusing to remove an unexpected primary-binding fixture path");
  }
  await rm(absolute, { recursive: true, force: true });
}

async function withFixture(action, { receipt = receiptMetadata, intentPatch = {}, intentPathName = "primary-intent.json" } = {}) {
  const temporaryRoot = resolve(tmpdir());
  const prefix = "eliotr-primary-binding-bootstrap-";
  const root = await mkdtemp(join(temporaryRoot, prefix));
  try {
    await mkdir(resolve(root, ".eliotr-state"));
    const receiptPath = resolve(root, ".eliotr-state", "bucket-receipt.json");
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
    await writeFile(receiptPath, receiptBytes, { flag: "wx", mode: 0o600 });
    const intentPath = resolve(root, ".eliotr-state", intentPathName);
    const intent = {
      protocol: bootstrapProtocol, account_id: accountId, worker_id: "eliotr-core",
      binding: { name: "BACKUP_PARTS_BUCKET", type: "r2_bucket", bucket_name: bucketName,
        jurisdiction: "default", storage_class: "Standard" },
      version_metadata: { name: "VERSION_METADATA", type: "version_metadata" },
      bucket_receipt: { path: receiptPath, sha256: sha256(receiptBytes), ...receiptMetadata },
      baseline: { deployment_id: deploymentId, version_id: versionId, generation: baselineGeneration,
        configuration_sha256: baselineConfigurationSha256 },
      candidate: { source_head: sourceHead, generation: candidateGeneration,
        configuration_sha256: candidateConfigurationSha256 },
      ...intentPatch,
    };
    await writeFile(intentPath, `${JSON.stringify(intent)}\n`, { flag: "wx", mode: 0o600 });
    await action({ root, intentPath, receiptPath, intent, receiptBytes });
  } finally {
    await removeFixture(root, temporaryRoot, prefix);
  }
}

async function loadFixture({ root, intentPath, config = candidateConfig, baseline = baselineConfig } = {}) {
  return loadMaintenancePrimaryBindingBootstrap({ path: intentPath, root, accountId, sourceHead,
    candidateGeneration, candidateConfigurationSha256, candidateConfig: config, candidateCapabilities,
    activeWorkerIdentity: baselineIdentity, baselineConfigurationBaseline, baselineConfig: baseline });
}

const beforeReadback = {
  traffic_percentage: 100,
  binding_readback: [
    { name: "EVIDENCE_BUCKET", type: "r2_bucket", identity: { bucket_name: "eliotr-evidence-fixture" } },
    { name: "AI_SEARCH", type: "ai_search_namespace", identity: { namespace: "eliotr" } },
  ],
};
const afterReadback = {
  traffic_percentage: 100,
  binding_readback: [
    ...beforeReadback.binding_readback,
    { name: "BACKUP_PARTS_BUCKET", type: "r2_bucket", identity: { bucket_name: bucketName } },
    { name: "VERSION_METADATA", type: "version_metadata", identity: {} },
  ],
};

await check("fresh exact two-binding transition passes and revalidates bytes", async () => {
  await withFixture(async ({ root, intentPath }) => {
    const bootstrap = await loadFixture({ root, intentPath });
    assert.equal(assertMaintenancePrimaryBindingBootstrapProfile({ bootstrap, phase: "before",
      generatedConfig: candidateConfig, activeWorkerIdentity: baselineIdentity,
      workerReadback: beforeReadback }).readback, "PASS");
    const afterIdentity = { ...baselineIdentity, deployment_id: "33333333-3333-4333-8333-333333333333",
      version_id: "44444444-4444-4444-8444-444444444444", generation: candidateGeneration };
    assert.equal(assertMaintenancePrimaryBindingBootstrapProfile({ bootstrap, phase: "after",
      generatedConfig: candidateConfig, activeWorkerIdentity: afterIdentity,
      workerReadback: afterReadback }).binding, "BACKUP_PARTS_BUCKET");
    assert.equal((await requireUnchangedMaintenancePrimaryBindingBootstrap({ bootstrap })).state, "PASS");
  });
});

await check("wrong account, reused bucket, preexisting receipt, extra resource and tampered receipt fail closed", async () => {
  await withFixture(async ({ root, intentPath, intent }) => {
    await writeFile(intentPath, `${JSON.stringify({ ...intent, account_id: "other-account" })}\n`);
    await assert.rejects(loadFixture({ root, intentPath }), /identity/u);
  });
  await withFixture(async ({ root, intentPath, intent }) => {
    await writeFile(intentPath, `${JSON.stringify({ ...intent, bucket_receipt: {
      ...intent.bucket_receipt, preexisting: true } })}\n`);
    await assert.rejects(loadFixture({ root, intentPath }), /receipt pin/u);
  });
  await withFixture(async ({ root, intentPath, receiptPath }) => {
    await writeFile(receiptPath, `${JSON.stringify({ ...receiptMetadata, preexisting: true })}\n`);
    await assert.rejects(loadFixture({ root, intentPath }), /receipt bytes/u);
  });
  await withFixture(async ({ root, intentPath }) => {
    const extraConfig = { ...candidateConfig, r2_buckets: [...candidateConfig.r2_buckets,
      { binding: "OTHER_BUCKET", bucket_name: "other" }] };
    await assert.rejects(loadFixture({ root, intentPath, config: extraConfig }), /only by the two primary bindings/u);
  });
  await withFixture(async ({ root, intentPath }) => {
    const reusedConfig = { ...candidateConfig, r2_buckets: candidateConfig.r2_buckets.map((item) =>
      item.binding === "BACKUP_PARTS_BUCKET" ? { ...item, bucket_name: "reused-bucket" } : item) };
    await assert.rejects(loadFixture({ root, intentPath, config: reusedConfig }), /exact fresh R2/u);
  });
});

await check("an old primary binding in the baseline is refused", async () => {
  await withFixture(async ({ root, intentPath }) => {
    const oldBaseline = { ...baselineConfig, r2_buckets: [...baselineConfig.r2_buckets,
      { binding: "BACKUP_PARTS_BUCKET", bucket_name: bucketName }] };
    await assert.rejects(loadFixture({ root, intentPath, baseline: oldBaseline }), /baseline/u);
  });
});

console.log(`Primary binding bootstrap focused tests: PASS (${cases} cases)`);
