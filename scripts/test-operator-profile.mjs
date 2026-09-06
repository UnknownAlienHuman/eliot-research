import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertOperatorProfileMatchesReadback,
  expectedFromEnv,
  loadOperatorProfile,
  validateOperatorProfile,
} from "./lib/cloudflare-operator-profile.mjs";

// Fictional RFC-reserved identities only. No real account IDs, emails,
// subdomains, hostnames, or team origins may appear in this file.
const FICTIONAL_EXPECTED = Object.freeze({
  accountName: "Example Account (template only)",
  accountId: "00000000000000000000000000000000",
  operatorEmail: "operator@example.com",
  wranglerProfile: "default",
  authMethod: "browser-oauth",
  workersDevSubdomain: "example-subdomain",
  workerName: "eliotr-core",
  hostname: "eliotr-core.example-subdomain.workers.dev",
  routeMode: "workers-dev-only",
  customDomainFlag: "0",
  teamOrigin: "https://example.cloudflareaccess.com",
  ownerEmails: Object.freeze(["operator@example.com"]),
});

const OTHER_FICTIONAL_ACCOUNT_ID = "11111111111111111111111111111111";

const templatePath = resolve(process.cwd(), "infra/cloudflare/operator-profile.json");
const raw = await readFile(templatePath, "utf8");
const tracked = JSON.parse(raw);

function clone() {
  return JSON.parse(JSON.stringify(tracked));
}

// Happy path: the tracked template validates structurally and matches the
// fictional supplied expectations.
const summary = validateOperatorProfile(tracked, FICTIONAL_EXPECTED);
assert.equal(summary.accountId, FICTIONAL_EXPECTED.accountId);
assert.equal(summary.accountName, FICTIONAL_EXPECTED.accountName);
assert.equal(summary.operatorEmail, FICTIONAL_EXPECTED.operatorEmail);
assert.equal(summary.wranglerProfile, FICTIONAL_EXPECTED.wranglerProfile);
assert.equal(summary.authMethod, "browser-oauth");
assert.equal(summary.workersDevSubdomain, FICTIONAL_EXPECTED.workersDevSubdomain);
assert.equal(summary.hostname, FICTIONAL_EXPECTED.hostname);
assert.equal(summary.routeMode, "workers-dev-only");
assert.equal(summary.teamOrigin, FICTIONAL_EXPECTED.teamOrigin);
assert.deepEqual([...summary.ownerEmails], [...FICTIONAL_EXPECTED.ownerEmails]);

// Structural validation also passes without supplied expectations.
const structuralOnly = validateOperatorProfile(clone());
assert.equal(structuralOnly.hostname, FICTIONAL_EXPECTED.hostname);

const loaded = await loadOperatorProfile("infra/cloudflare/operator-profile.json");
assert.equal(loaded.hostname, summary.hostname);

// Supplied-expectation drift fails closed.
{
  const mutatedExpectations = { ...FICTIONAL_EXPECTED, accountId: OTHER_FICTIONAL_ACCOUNT_ID };
  assert.throws(() => validateOperatorProfile(clone(), mutatedExpectations), /account\.id/u);
}

// Live readback comparison: matching readback passes, drift fails.
{
  assertOperatorProfileMatchesReadback(summary, {
    accountId: FICTIONAL_EXPECTED.accountId,
    hostname: FICTIONAL_EXPECTED.hostname,
    teamOrigin: FICTIONAL_EXPECTED.teamOrigin,
    ownerEmails: [...FICTIONAL_EXPECTED.ownerEmails],
  });
  assert.throws(
    () =>
      assertOperatorProfileMatchesReadback(summary, {
        accountId: OTHER_FICTIONAL_ACCOUNT_ID,
      }),
    /readback/u,
  );
}

// expectedFromEnv builds expectations from explicit env vars (no constants).
{
  const fromEnv = expectedFromEnv({
    CLOUDFLARE_ACCOUNT_ID: FICTIONAL_EXPECTED.accountId,
    ELIOTR_OWNER_EMAILS: "operator@example.com",
    ELIOTR_ACCESS_HOSTNAME: FICTIONAL_EXPECTED.hostname,
    ELIOTR_ACCESS_TEAM_DOMAIN: FICTIONAL_EXPECTED.teamOrigin,
  });
  assert.equal(fromEnv.accountId, FICTIONAL_EXPECTED.accountId);
  assert.deepEqual(fromEnv.ownerEmails, ["operator@example.com"]);
  validateOperatorProfile(clone(), fromEnv);
}

// Negative: wrong hostname against supplied expectations.
{
  const mutated = clone();
  mutated.workers_dev.hostname = "eliotr-core.other-example.workers.dev";
  assert.throws(() => validateOperatorProfile(mutated, FICTIONAL_EXPECTED), /workers_dev\.hostname/u);
}

// Negative: custom-domain mode.
{
  const mutated = clone();
  mutated.routing.mode = "custom-domain";
  mutated.routing.custom_domain_enabled = true;
  mutated.routing.eliotr_custom_domain = "1";
  assert.throws(() => validateOperatorProfile(mutated), /routing/u);
}

// Negative: secret-like field present.
{
  const mutated = clone();
  mutated.operator.api_token = "dummy-value-for-fixture";
  assert.throws(() => validateOperatorProfile(mutated), /secret-like|unexpected field/u);
}

// Negative: token material present (JWT shape inside a free-text note).
{
  const mutated = clone();
  mutated.operational_policy.overage_note =
    "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"; // privacy-allowlist: synthetic token fixture
  assert.throws(() => validateOperatorProfile(mutated), /token material/u);
}

console.log("Operator profile fixtures: PASS");
