import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { localConfiguration, localCommands } from "./local-runtime.mjs";
const canonical = JSON.parse(await readFile(new URL("../apps/eliotr-core/wrangler.jsonc", import.meta.url), "utf8"));
const source = JSON.stringify(canonical);
const config = localConfiguration({ ...canonical, routes: ["research.example/*"], account_id: "remote",
  services: [{ binding: "REMOTE", service: "remote" }], ai: { binding: "AI" } });
assert.equal(JSON.stringify(canonical), source);
for (const key of ["env", "routes", "account_id", "ai", "ai_search_namespaces", "services", "triggers"]) assert.equal(config[key], undefined);
assert.equal(config.vars.ACCESS_TEAM_DOMAIN, canonical.vars.ACCESS_TEAM_DOMAIN);
assert.equal(config.vars.ACCESS_AUDIENCE, canonical.vars.ACCESS_AUDIENCE);
assert.equal(config.vars.ENVIRONMENT, "development");
assert.equal(config.workers_dev, false); assert.equal(config.dev.ip, "127.0.0.1");
assert.equal(config.d1_databases.length, 2);
assert.deepEqual(localCommands().map((command) => command.args[1]), ["build", "d1", "d1"]);
const dev = localCommands({ dev: true });
assert.equal(dev.length, 4); assert.ok(dev.at(-1).args.includes("127.0.0.1"));
for (const command of dev) {
  assert.ok(!command.args.includes("--remote")); assert.ok(!command.args.includes("deploy"));
  if (command.args[1] !== "build") assert.ok(command.args.includes("--local"));
}
assert.throws(() => localConfiguration({}));
console.log("Local runtime: local-only config/commands, loopback bind and unchanged authentication: PASS");
