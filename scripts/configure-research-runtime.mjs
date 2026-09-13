import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCompiledWorkspaceModule } from "./lib/compiled-workspace-module.mjs";
import { loadResearchRuntimeEnvironment } from "./lib/research-runtime-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: node scripts/configure-research-runtime.mjs INPUT.json [--output PATH]\n" +
  "Compiles explicit owner/model/report decisions into .eliotr-state/research-runtime.json.\n" +
  "Preserves existing workspace/namespace settings. Does not call a model or deploy the Worker.";

async function jsonFile(path) {
  if ((await stat(path)).size > 1024 * 1024) throw new Error("Configuration input exceeds 1 MiB");
  const bytes = await readFile(path);
  if (bytes.byteLength > 1024 * 1024) throw new Error("Configuration input exceeds 1 MiB");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  if (![1, 3].includes(args.length) || args[0].startsWith("--") ||
      (args.length === 3 && args[1] !== "--output")) throw new Error(usage);
  const inputPath = resolve(root, args[0]);
  const outputPath = resolve(root, args[2] ?? ".eliotr-state/research-runtime.json");
  if (inputPath.toLowerCase() === outputPath.toLowerCase()) throw new Error("Input and installed configuration must be separate files");
  let input = await jsonFile(inputPath);
  if (input?.protocol === "eliotr.research-owner-document-setup.v1") {
    if (Object.keys(input).sort().join(",") !== "document_preset,model_profile,protocol,report_admission_policy,spend_policy") {
      throw new Error("Document setup contains missing or unknown fields");
    }
    const { createResearchOwnerDocumentPreset } = await loadCompiledWorkspaceModule(
      "apps/eliotr-core/dist/research-owner-document-preset.js",
    );
    const preset = createResearchOwnerDocumentPreset(input.document_preset);
    input = { protocol: "eliotr.research-owner-setup.v1", semantic: preset.semantic,
      model_profile: input.model_profile, spend_policy: input.spend_policy,
      report: { admission_policy: input.report_admission_policy, artifact_policy: preset.artifact_policy } };
  }
  const { createResearchOwnerRuntimeConfiguration } = await loadCompiledWorkspaceModule(
    "apps/eliotr-core/dist/research-owner-runtime-config.js",
  );
  const compiled = await createResearchOwnerRuntimeConfiguration(input);
  let previous = { protocol: "eliotr.research-runtime.v1", vars: {} };
  try {
    previous = await jsonFile(outputPath);
    // Validate the whole existing file before preserving any of its settings.
    await loadResearchRuntimeEnvironment({ ELIOTR_RESEARCH_CONFIG_FILE: outputPath }, root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const installed = { protocol: compiled.protocol, vars: { ...previous.vars, ...compiled.vars } };
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(installed, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await loadResearchRuntimeEnvironment({ ELIOTR_RESEARCH_CONFIG_FILE: temporary }, root);
    await rename(temporary, outputPath);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
  console.log(JSON.stringify({
    configuration_file: outputPath,
    configured_model_fields: Object.keys(compiled.vars).length,
    preserved_workspace_fields: Object.keys(previous.vars).filter((key) => !Object.hasOwn(compiled.vars, key)),
    next_step: "Install the matching live route and pricing, then deploy with this runtime configuration.",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof SyntaxError ? "Configuration input is not valid JSON" : error.message);
  process.exitCode = 1;
});
