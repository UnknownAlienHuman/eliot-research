import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  OPERATOR_PROFILE_EXPECTED,
  loadOperatorProfile,
  validateOperatorProfile,
} from "./lib/cloudflare-operator-profile.mjs";

const profilePath = resolve(process.cwd(), "infra/cloudflare/operator-profile.json");
const raw = await readFile(profilePath, "utf8");
const tracked = JSON.parse(raw);

function clone() {
  return JSON.parse(JSON.stringify(tracked));
}

// Happy path: the tracked file validates and exposes the exact operator identity.
const summary = validateOperatorProfile(tracked);
assert.equal(summary.accountId, "bc10e9f02aa57f4adc5a7a48ad1bacff");
assert.equal(summary.accountName, "Kleymor.metal@gmail.com's Account");
assert.equal(summary.operatorEmail, "kleymor.metal@gmail.com");
assert.equal(summary.wranglerProfile, "default");
assert.equal(summary.authMethod, "browser-oauth");
assert.equal(summary.workersDevSubdomain, "kleymor-metal");
assert.equal(summary.hostname, "eliotr-core.kleymor-metal.workers.dev");
assert.equal(summary.routeMode, "workers-dev-only");
assert.equal(summary.teamOrigin, "https://iuriilisenkov.cloudflareaccess.com");
assert.deepEqual(summary.ownerEmails, ["kleymor.metal@gmail.com"]);
assert.equal(OPERATOR_PROFILE_EXPECTED.customDomainFlag, "0");

const loaded = await loadOperatorProfile("infra/cloudflare/operator-profile.json");
assert.equal(loaded.hostname, summary.hostname);

// Negative: wrong account id.
{
  const mutated = clone();
  mutated.account.id = "00000000000000000000000000000000";
  assert.throws(() => validateOperatorProfile(mutated), /account\.id/u);
}

// Negative: wrong hostname.
{
  const mutated = clone();
  mutated.workers_dev.hostname = "eliotr-core.wrong-subdomain.workers.dev";
  assert.throws(() => validateOperatorProfile(mutated), /workers_dev\.hostname/u);
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
    "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  assert.throws(() => validateOperatorProfile(mutated), /token material/u);
}

console.log("Operator profile fixtures: PASS");
