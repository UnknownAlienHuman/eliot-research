import assert from "node:assert/strict";
import {
  applyAccessRuntimeVars,
  validateAccessRuntimeConfiguration,
} from "./lib/access-runtime-config.mjs";

const valid = validateAccessRuntimeConfiguration({
  ELIOTR_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
  ELIOTR_ACCESS_AUDIENCE: "0123456789abcdef",
  ELIOTR_ACCESS_SERVICE_PRINCIPALS: "eliotr-agent,eliotr-federation",
});
assert.equal(valid.teamDomain, "https://example.cloudflareaccess.com");
assert.deepEqual(valid.servicePrincipals, ["eliotr-agent", "eliotr-federation"]);
assert.deepEqual(applyAccessRuntimeVars({ ENVIRONMENT: "test" }, valid), {
  ENVIRONMENT: "test",
  ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
  ACCESS_AUDIENCE: "0123456789abcdef",
  ACCESS_SERVICE_PRINCIPALS: "eliotr-agent,eliotr-federation",
});

for (const fixture of [
  { ELIOTR_ACCESS_TEAM_DOMAIN: "http://example.cloudflareaccess.com", ELIOTR_ACCESS_AUDIENCE: "aud" },
  { ELIOTR_ACCESS_TEAM_DOMAIN: "https://example.invalid", ELIOTR_ACCESS_AUDIENCE: "aud" },
  { ELIOTR_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com/path", ELIOTR_ACCESS_AUDIENCE: "aud" },
  { ELIOTR_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com", ELIOTR_ACCESS_AUDIENCE: "" },
  { ELIOTR_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com", ELIOTR_ACCESS_AUDIENCE: "bad audience" },
  { ELIOTR_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com", ELIOTR_ACCESS_AUDIENCE: "aud", ELIOTR_ACCESS_SERVICE_PRINCIPALS: "duplicate,duplicate" },
]) {
  assert.throws(() => validateAccessRuntimeConfiguration(fixture));
}

console.log("Access runtime configuration fixtures: PASS");
