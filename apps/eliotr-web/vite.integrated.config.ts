import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import agents from "agents/vite";
import { defineConfig, loadEnv, type ConfigEnv, type Plugin } from "vite";
import { libraryRouterOnlyOptimization } from "./vite.config";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integrationConfigPath({ command, mode }: ConfigEnv): string {
  const selectedPath = process.env.ELIOTR_OWNER_WEB_DEPLOY_CONFIG;
  if (process.env.CLOUDFLARE_ENV === "test") {
    if (selectedPath !== undefined) {
      throw new Error("Owner-web release config cannot be combined with CLOUDFLARE_ENV=test.");
    }
    return "../eliotr-core/wrangler.jsonc";
  }
  // The generated file's root is production; a named environment would select an override.
  if (process.env.CLOUDFLARE_ENV !== undefined || command !== "build" || mode !== "production") {
    throw new Error("Owner-web release requires a production build with CLOUDFLARE_ENV unset.");
  }
  const webRoot = realpathSync(fileURLToPath(new URL(".", import.meta.url)));
  const releaseRoot = realpathSync(resolve(webRoot, "../.."));
  const expectedPath = resolve(releaseRoot, "apps/eliotr-core/wrangler.deploy.jsonc");
  if (realpathSync(process.cwd()) !== webRoot) {
    throw new Error("Owner-web release must run from this release repository's apps/eliotr-web.");
  }
  // Match the plugin's dotenv lookup so a local file cannot silently select env.test.
  if (loadEnv(mode, webRoot, "CLOUDFLARE_").CLOUDFLARE_ENV !== undefined) {
    throw new Error("Owner-web release dotenv must not select a named Cloudflare environment.");
  }
  if (selectedPath === undefined || !isAbsolute(selectedPath) || resolve(selectedPath) !== expectedPath) {
    throw new Error("ELIOTR_OWNER_WEB_DEPLOY_CONFIG must name this release repository's absolute generated config.");
  }
  if (!lstatSync(selectedPath).isFile() || realpathSync(selectedPath) !== expectedPath) {
    throw new Error("Owner-web release config must be an existing canonical regular file.");
  }
  let config: unknown;
  try {
    // The existing provisioner emits strict JSON, despite the generated .jsonc filename.
    config = JSON.parse(readFileSync(selectedPath, "utf8"));
  } catch {
    // Keep read/parse error details private; generated config may contain sensitive values.
    throw new Error("Owner-web release requires a readable generated JSON config.");
  }
  if (!isRecord(config) || config.name !== "eliotr-core" || !isRecord(config.vars) ||
      config.vars.ENVIRONMENT !== "production" || !isRecord(config.assets) || config.assets.binding !== "ASSETS") {
    throw new Error("Owner-web release config requires eliotr-core, production ENVIRONMENT and the ASSETS binding.");
  }
  const generation = config.vars.DEPLOYMENT_GENERATION;
  if (typeof generation !== "string" || generation.length === 0 || generation.trim() !== generation ||
      /(?:^|[-_.])(?:test|testing|local|development|staging|unset|placeholder|example|unknown|null|undefined|none|pending)(?:$|[-_.])/i.test(generation) ||
      /^(?:git-)?0+$/.test(generation)) {
    throw new Error("Owner-web release config requires a non-placeholder production deployment generation.");
  }
  return expectedPath;
}

function ownerWorkerGraph(): Plugin {
  const fileName = "owner-worker-graph.json";
  return {
    name: "eliotr-owner-worker-graph",
    apply: "build",
    enforce: "post",
    applyToEnvironment: (environment) => environment.name === "eliotr_core",
    generateBundle: {
      order: "post",
      handler(outputOptions, bundle, isWrite) {
        if (bundle[fileName]) {
          this.error("Owner Worker graph output already exists in this bundle.");
        }
        const moduleIds = Array.from(this.getModuleIds()).sort();
        const modules = moduleIds.map((id) => {
          const info = this.getModuleInfo(id);
          if (info === null) {
            this.error("Owner Worker graph module information is unavailable.");
          }
          return {
            id: info.id,
            isEntry: info.isEntry,
            inputFormat: info.inputFormat,
            importedIds: [...info.importedIds],
            dynamicallyImportedIds: [...info.dynamicallyImportedIds],
            importers: [...info.importers],
            dynamicImporters: [...info.dynamicImporters],
            exports: [...info.exports],
          };
        });
        const outputs = Object.values(bundle).sort((left, right) =>
          left.fileName < right.fileName ? -1 : left.fileName > right.fileName ? 1 : 0);
        const chunks = outputs.flatMap((output) => output.type === "chunk" ? [{
          fileName: output.fileName,
          name: output.name,
          isEntry: output.isEntry,
          isDynamicEntry: output.isDynamicEntry,
          facadeModuleId: output.facadeModuleId,
          moduleIds: [...output.moduleIds],
          imports: [...output.imports],
          dynamicImports: [...output.dynamicImports],
          exports: [...output.exports],
          renderedModules: Object.entries(output.modules).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0).map(([id, rendered]) => ({
            id,
            renderedLength: rendered.renderedLength,
            renderedExports: [...rendered.renderedExports],
          })),
        }] : []);
        if (!chunks.some((chunk) => chunk.isEntry)) {
          this.error("Owner Worker graph requires an observed entry chunk.");
        }
        const observedIds = new Set(moduleIds);
        // Rolldown does not expose isExternal here; absence is not an external classification.
        const dependencyIdsAbsentFromModuleGraph = [...new Set(modules.flatMap((module) =>
          [...module.importedIds, ...module.dynamicallyImportedIds]
            .filter((id) => !observedIds.has(id))))].sort();
        this.emitFile({
          type: "asset",
          fileName,
          source: JSON.stringify({
            schemaVersion: 1,
            producer: {
              plugin: "eliotr-owner-worker-graph",
              hook: "generateBundle",
              viteVersion: this.meta.viteVersion,
              rolldownVersion: this.meta.rolldownVersion,
            },
            environment: this.environment.name,
            root: this.environment.config.root,
            output: {
              outDir: this.environment.config.build.outDir,
              dir: outputOptions.dir ?? null,
              file: outputOptions.file ?? null,
              format: outputOptions.format,
              isWrite,
            },
            modules,
            dependencyIdsAbsentFromModuleGraph,
            chunks,
            assetFileNames: outputs.flatMap((output) => output.type === "asset" ? [output.fileName] : []),
          }, null, 2) + "\n",
        });
      },
    },
  };
}

export default defineConfig((environment) => {
  const configPath = integrationConfigPath(environment);
  return {
    plugins: [
      libraryRouterOnlyOptimization(),
      agents(),
      react(),
      cloudflare({ configPath, remoteBindings: false }),
      tailwindcss(),
      ownerWorkerGraph(),
    ],
    server: { host: "127.0.0.1", port: 5174, strictPort: true },
    build: { sourcemap: false },
  };
});
