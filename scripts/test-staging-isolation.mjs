import assert from "node:assert/strict";
import test from "node:test";
import { validateStagingTarget } from "./lib/staging-isolation.mjs";
import { deployCloudflare } from "./deploy-cloudflare.mjs";

const target = {
  protocol: "eliotr.staging-target.v1",
  isolation: "dedicated-account",
  account_id: "staging-test-account",
  protected_account_ids: ["production-test-account"],
  access_hostname: "staging.example.com",
};
function environment(value = target) {
  return {
    ELIOTR_ENVIRONMENT: "staging",
    CLOUDFLARE_ACCOUNT_ID: target.account_id,
    ELIOTR_ACCESS_HOSTNAME: target.access_hostname,
    ELIOTR_STAGING_TARGET_JSON: JSON.stringify(value),
  };
}

test("staging target pins a dedicated account and ingress without disclosing identities", () => {
  const result = validateStagingTarget(environment());
  assert.equal(result.isolation, "dedicated-account");
  assert.match(result.target_declaration_sha256, /^[0-9a-f]{64}$/u);
  assert.match(result.account_id_sha256, /^[0-9a-f]{64}$/u);
  assert.ok(!JSON.stringify(result).includes(target.account_id));
  assert.ok(!JSON.stringify(result).includes(target.access_hostname));
  assert.ok(Object.isFrozen(result));
  const reverse = { ...target, protected_account_ids: ["production-test-account", "other-test-account"] };
  assert.deepEqual(validateStagingTarget(environment(reverse)),
    validateStagingTarget(environment({ ...reverse, protected_account_ids: [...reverse.protected_account_ids].reverse() })));
});

test("staging label, same-account proposal and approval flags cannot admit a target", () => {
  for (const value of [null, [], {}, { ...target, isolation: "same-account" },
    { ...target, approved: true }, { ...target, account_id: "production-test-account" },
    { ...target, access_hostname: "production.example.com" },
    { ...target, protected_account_ids: [] },
    { ...target, protected_account_ids: [target.account_id] },
    { ...target, protected_account_ids: ["production-test-account", "production-test-account"] },
    { ...target, protected_account_ids: [null] },
    { ...target, protected_account_ids: Array.from({ length: 33 }, (_, i) => `protected-${i}`) },
    { ...target, access_hostname: "https://staging.example.com" },
    { ...target, account_id: "staging-test-account " }]) {
    assert.throws(() => validateStagingTarget(environment(value)), /Staging target declaration/u);
  }
  for (const raw of [undefined, "", "{", " ".repeat(8193)]) {
    assert.throws(() => validateStagingTarget({ ...environment(), ELIOTR_STAGING_TARGET_JSON: raw }));
  }
});

test("production and dry-run do not require or derive staging permission", async () => {
  assert.equal(validateStagingTarget({ ELIOTR_ENVIRONMENT: "production" }), null);
  const commands = [];
  const result = await deployCloudflare({
    confirmLive: false,
    // Source sealing has separate fixtures; isolate the staging authorization flow.
    captureBuildInputs: async () => Object.freeze({ files: [] }),
    checkBuildInputs: async () => true,
    environment: { ELIOTR_ENVIRONMENT: "staging" },
    execute: (command, args) => commands.push([command, args]),
    fetchImpl: () => assert.fail("dry-run must not contact a remote target"),
    archive: () => assert.fail("dry-run must not archive a receipt"),
    save: () => assert.fail("dry-run must not save a live receipt"),
    log: () => {},
  });
  assert.equal(result, null);
  assert.equal(commands.length, 4);
});

test("invalid staging target stops orchestrator before credential reads, commands or effects", async () => {
  for (const declared of [undefined, JSON.stringify({ ...target, protected_account_ids: [target.account_id] })]) {
    const calls = [];
    await assert.rejects(deployCloudflare({
      confirmLive: true,
      captureBuildInputs: async () => Object.freeze({ files: [] }),
      environment: {
        ...environment(), ELIOTR_STAGING_TARGET_JSON: declared,
        ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth",
      },
      verifyCode: async () => {},
      execute: () => calls.push("execute"),
      readWranglerFile: () => calls.push("credential-read"),
      fetchImpl: () => calls.push("fetch"),
      archive: () => calls.push("archive"),
      save: () => calls.push("save"),
    }), /Staging target declaration/u);
    assert.deepEqual(calls, []);
  }
});
