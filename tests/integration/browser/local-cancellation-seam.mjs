import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const CANCELLATION_EVENT = "owner-e2e-cancellation-gate";
const ENTRYPOINT_FILE = "owner-e2e-cancellation-entrypoint.mjs";

export function filesystemImportSpecifier(directory, productionMain, {
  relativePath = relative, separator = sep,
} = {}) {
  const candidate = relativePath(directory, productionMain).replaceAll(separator, "/");
  if (candidate.startsWith(".") || candidate.startsWith("/") || /^[A-Za-z]:\//u.test(candidate)) return candidate;
  return `./${candidate}`;
}

function wrapperSource(productionImport, cancellationQuery) {
  return `import production, { ResearchSession, ResearchWorkflow as ProductionResearchWorkflow } from ${JSON.stringify(productionImport)};

const CANCELLATION_QUERY = ${JSON.stringify(cancellationQuery)};
const CANCELLATION_EVENT = ${JSON.stringify(CANCELLATION_EVENT)};

// This module is generated inside the harness-owned local state directory and
// selected only by its temporary local config. It never enters production
// source, Wrangler config, or a public request option.
export { ResearchSession };
export class ResearchWorkflow extends ProductionResearchWorkflow {
  async run(event, step) {
    const payload = event?.payload;
    if (payload?.workflow_kind === "EXHAUSTIVE_QUERY" &&
        payload.exhaustive_request?.query === CANCELLATION_QUERY) {
      await step.waitForEvent(CANCELLATION_EVENT, { type: CANCELLATION_EVENT });
    }
    return super.run(event, step);
  }
}

// Preserve the real Worker default export, including fetch/queue/scheduled.
export default production;
`;
}

export async function installLocalCancellationSeam(paths, { query } = {}) {
  assert.equal(typeof query, "string");
  assert.ok(/^[\x21-\x7e]{1,256}$/u.test(query), "cancellation seam query must be bounded and printable");
  const directory = resolve(paths.directory);
  assert.equal(resolve(paths.config), resolve(directory, "wrangler.json"),
    "cancellation seam config must be the generated file inside the harness state directory");
  const configText = await readFile(paths.config, "utf8");
  const config = JSON.parse(configText);
  assert.equal(config.name, "eliotr-core-local", "cancellation seam requires the generated local config");
  assert.equal(typeof config.main, "string");
  const productionMain = resolve(config.main);
  const expectedProductionMain = resolve(import.meta.dirname, "../../../apps/eliotr-core/src/index.ts");
  assert.equal(productionMain, expectedProductionMain,
    "cancellation seam must wrap the exact production Worker entrypoint");
  const entrypoint = resolve(directory, ENTRYPOINT_FILE);
  const productionImport = filesystemImportSpecifier(directory, productionMain);
  assert.ok(productionImport.startsWith(".") || productionImport.startsWith("/") || /^[A-Za-z]:\//u.test(productionImport),
    "cancellation seam production import must remain a filesystem path");
  await writeFile(entrypoint, wrapperSource(productionImport, query), { flag: "wx", mode: 0o600 });
  const nextConfig = { ...config, main: entrypoint };
  const temporary = `${paths.config}.cancellation.tmp`;
  await writeFile(temporary, `${JSON.stringify(nextConfig, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, paths.config);
  return Object.freeze({ entrypoint, productionMain, query });
}
