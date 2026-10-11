import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDeploymentJsonc } from "./lib/deployment-jsonc.mjs";
import { assertFoundationQueueConsumers } from "./lib/cloudflare-foundation-queue-profile.mjs";
const config = parseDeploymentJsonc(readFileSync(new URL("../apps/eliotr-core/wrangler.jsonc", import.meta.url), "utf8"));
const resources = JSON.parse(readFileSync(new URL("../infra/cloudflare/resources.json", import.meta.url), "utf8"));
assertFoundationQueueConsumers(config, resources.queues);
for (const change of [
  value => value.queues.consumers.pop(),
  value => value.queues.consumers.push({ queue: "foreign" }),
  value => { value.queues.consumers[1].queue = "foreign"; },
  value => { value.queues.consumers[1].dead_letter_queue = "eliotr-jobs"; },
  value => { value.queues.consumers[0].dead_letter_queue = "foreign"; },
]) {
  const copy = structuredClone(config); change(copy);
  assert.throws(() => assertFoundationQueueConsumers(copy, resources.queues));
}
console.log("Published primary/DLQ consumer profile: PASS");
