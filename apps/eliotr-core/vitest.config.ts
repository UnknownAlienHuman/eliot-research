import process from "node:process";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { loadCompiledWorkspaceModule } from "../../scripts/lib/compiled-workspace-module.mjs";
import { admissionTestConfiguration } from "./test/research-current-dispatch-config.js";
import type { ResearchOwnerRuntimeConfiguration } from "./src/research-owner-runtime-config.js";

export default defineConfig(async () => {
  const compiler = await loadCompiledWorkspaceModule("apps/eliotr-core/dist/research-owner-runtime-config.js") as {
    createResearchOwnerRuntimeConfiguration: (input: ReturnType<typeof admissionTestConfiguration>) => Promise<ResearchOwnerRuntimeConfiguration>;
  };
  const compiled = await compiler.createResearchOwnerRuntimeConfiguration(
    admissionTestConfiguration("test-generation", "orientation-owner", "current-dispatch-probe"),
  );
  const migrations = {
    CORE_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("../../infra/d1/core/migrations", import.meta.url))),
    SEARCH_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("../../infra/d1/search/migrations", import.meta.url))),
  };
  const workerPlugin = (extra: Record<string, string> = {}) => cloudflareTest({
    // env.test declares only local D1/R2/Queue/Workflow bindings. Keep the
    // test profile from starting an unnecessary remote bindings proxy.
    remoteBindings: false,
    miniflare: { bindings: {
      ...extra,
      ...(process.env.ELIOTR_OWNER_ARTIFACT_FIXTURE === undefined ? {} : { OWNER_ARTIFACT_FIXTURE: process.env.ELIOTR_OWNER_ARTIFACT_FIXTURE }),
      ...migrations,
    } },
    wrangler: {
      configPath: "./wrangler.jsonc",
      environment: "test",
    },
  });
  return {
    test: {
      projects: [
        { plugins: [workerPlugin()], test: {
          name: "core-default", include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: ["test/research-current-dispatch.test.ts"],
        } },
        { plugins: [workerPlugin({ ...compiled.vars, ELIOTR_MODEL_GATEWAY_TOKEN: "local-admission-not-a-credential",
          AI_GATEWAY_REASONING_URL: `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning` })],
          test: { name: "research-current-dispatch-native", include: ["test/research-current-dispatch.test.ts"] } },
      ],
      // Bound concurrent runtime startup and D1 load locally and on CI. Four
      // runtime pools caused otherwise unchanged storage tests to miss deadlines.
      // Keep file parallelism and the existing per-test deadlines.
      maxWorkers: 2,
      // Windows may allocate a local Workers runtime on a WHATWG Fetch
      // forbidden port. Reserve those loopback endpoints before pool workers
      // start; the global setup owns teardown and never touches other listeners.
      globalSetup: [fileURLToPath(new URL("../../scripts/lib/miniflare-port-guard.mjs", import.meta.url))],
    },
  };
});
