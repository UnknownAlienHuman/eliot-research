import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(resolve(tmpdir(), "eliotr-guide-boundaries-"));
const relativeTemporary = relative(resolve(tmpdir()), resolve(temporary));
assert(!isAbsolute(relativeTemporary) && !relativeTemporary.startsWith("..") &&
  relativeTemporary.startsWith("eliotr-guide-boundaries-"));
try {
  for (const path of ["scripts/lib", "node_modules", "packages/cloudflare-research-runtime/src",
    "packages/owner-api-client/src", "apps/eliotr-core/src", "apps/eliotr-web/src"]) {
    await mkdir(resolve(temporary, path), { recursive: true });
  }
  for (const path of ["scripts/check-boundaries.mjs", "scripts/lib/boundary-registration-discovery.mjs",
    "scripts/lib/boundary-module-imports.mjs"]) {
    await copyFile(resolve(root, path), resolve(temporary, path));
  }
  await symlink(await realpath(resolve(root, "node_modules/typescript")),
    resolve(temporary, "node_modules/typescript"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(resolve(temporary, "tsconfig.json"), JSON.stringify({ files: [], references: [] }));
  const fixtures = new Map([
    ["packages/cloudflare-research-runtime/src/guide.ts", 'export { ProjectGuideViewSchema } from "@eliotr/contracts/project-guide";'],
    ["packages/owner-api-client/src/guide.ts", 'export { ProjectGuideRequestSchema } from "@eliotr/contracts/project-guide";'],
    ["apps/eliotr-core/src/guide.ts", [
      'export { ProjectGuideViewSchema } from "@eliotr/contracts/project-guide";',
      'export { createProjectGuideService } from "@eliotr/cloudflare-research-runtime/project-guide-service.js";',
      'export { projectGuideFromReport } from "@eliotr/cloudflare-research-runtime/project-guide-projection.js";',
    ].join("\n")],
  ]);
  for (const [path, content] of fixtures) await writeFile(resolve(temporary, path), content);
  const check = () => spawnSync(process.execPath, [resolve(temporary, "scripts/check-boundaries.mjs")],
    { cwd: temporary, encoding: "utf8", timeout: 15_000 });
  const allowed = check();
  assert.ifError(allowed.error);
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  for (const [path, specifier] of [
    ["packages/owner-api-client/src/negative.ts", "@eliotr/contracts/project-guide-unknown"],
    ["apps/eliotr-core/src/negative.ts", "@eliotr/cloudflare-research-runtime/project-guide-store.js"],
    ["packages/owner-api-client/src/negative.ts", "@eliotr/cloudflare-research-runtime/project-guide-service.js"],
    ["apps/eliotr-web/src/negative.ts", "@eliotr/contracts/project-guide"],
  ]) {
    const target = resolve(temporary, path);
    await writeFile(target, `export { probe } from "${specifier}";`);
    const denied = check();
    assert.ifError(denied.error);
    assert.equal(denied.status, 1, denied.stdout + denied.stderr);
    assert(denied.stderr.includes(`${path} violates dependency direction with ${specifier}`), denied.stderr);
    await writeFile(target, "export const safe = true;");
  }
  console.log("Project guide boundaries: PASS (exact declared subpaths; unknown and reverse directions rejected).");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
