import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCompiledWorkspaceModule } from "./lib/compiled-workspace-module.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: node scripts/plan-research-model-route.mjs INPUT.json [--output PATH]\n" +
  "Builds the exact route name, prompt/schema generations and hashes from production assets.\n" +
  "Optional output_format is json_schema (default) or prompt_json for providers without response_format support.\n" +
  "Writes a local plan only. Does not provision, approve spending, qualify or call a model.";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  if (![1, 3].includes(args.length) || args[0].startsWith("--") ||
      (args.length === 3 && args[1] !== "--output")) throw new Error(usage);
  const inputPath = resolve(root, args[0]);
  const outputPath = resolve(root, args[2] ?? ".eliotr-state/research-model-route-plan.json");
  if (inputPath.toLowerCase() === outputPath.toLowerCase()) throw new Error("Input and output must be separate files");
  if ((await stat(inputPath)).size > 262144) throw new Error("Route planning input exceeds 256 KiB");
  const bytes = await readFile(inputPath);
  if (bytes.byteLength > 262144) throw new Error("Route planning input exceeds 256 KiB");
  const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const requiredKeys = ["max_tokens", "pricing_snapshot_ref", "route_definition", "route_ref", "route_version", "stage"];
  const allowedKeys = new Set([...requiredKeys, "output_format"]);
  if (input === null || typeof input !== "object" || Array.isArray(input) ||
      requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(input, key)) ||
      Object.keys(input).some((key) => !allowedKeys.has(key))) throw new Error("Route plan has missing or unknown fields");
  const { createResearchOwnerRoutePlan } = await loadCompiledWorkspaceModule(
    "apps/eliotr-core/dist/research-owner-route-plan.js",
  );
  const plan = await createResearchOwnerRoutePlan(input);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ protocol: "eliotr.research-model-route-plan.v1", ...plan }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
    await rename(temporary, outputPath);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
  console.log(JSON.stringify({ plan_file: outputPath, stage: plan.stage,
    output_format: plan.output_format,
    provider_route_name: plan.compiled.provider_route_name,
    route_definition_sha256: plan.provisioning.route_definition_sha256,
    remote_effects: false }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof SyntaxError ? "Route input is not valid JSON" : error.message);
  process.exitCode = 1;
});
