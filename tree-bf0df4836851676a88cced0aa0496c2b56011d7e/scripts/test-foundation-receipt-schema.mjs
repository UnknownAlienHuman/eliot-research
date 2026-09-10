import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const schema = JSON.parse(await readFile(
  new URL("../infra/cloudflare/foundation-receipt.schema.json", import.meta.url),
  "utf8",
));
const receiptFields = [
  "protocol",
  "desired_generation",
  "deployment_generation",
  "environment",
  "generated_config",
  "account_ref",
  "d1_databases",
  "r2_buckets",
  "queues",
  "access_hostname",
  "access_team_domain",
  "access_audience_configured",
  "access_service_principal_count",
  "public_route_mode",
  "alternative_public_routes",
  "access_provisioning",
  "created_at",
];

assert.equal(schema.additionalProperties, false);
for (const field of receiptFields) {
  assert.ok(schema.required.includes(field), `${field} is missing from required`);
  assert.ok(Object.hasOwn(schema.properties, field), `${field} is missing from properties`);
}
assert.equal(schema.properties.access_audience_configured.const, true);
assert.equal(schema.properties.alternative_public_routes.const, "PROHIBITED");
assert.deepEqual(schema.properties.public_route_mode.enum, ["CUSTOM_DOMAIN_ONLY", "WORKERS_DEV_ONLY"]);
console.log("Foundation receipt producer/schema parity: PASS");
