import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(appRoot, "src/agent-inbox.ts");
const dispatchSourcePath = resolve(appRoot, "src/agent-inbox-dispatch.ts");
const cssPath = resolve(appRoot, "src/agent-inbox.css");
const outputDirectory = resolve(appRoot, "public/agent-inbox");
const outputScript = resolve(outputDirectory, "app.js");
const outputCss = resolve(outputDirectory, "app.css");

function fail(message) {
  throw new Error(`agent-inbox build: ${message}`);
}

const [mainSource, dispatchSource, css] = await Promise.all([
  readFile(sourcePath, "utf8"),
  readFile(dispatchSourcePath, "utf8"),
  readFile(cssPath, "utf8"),
]);
const source = `${mainSource}
${dispatchSource}`;

if (/(^|\n)\s*(?:import|export)\b/u.test(source) || /\bimport\s*\(/u.test(source)) {
  fail("standalone source cannot import another module");
}
if (source.includes("localStorage") || source.includes("sessionStorage") ||
    source.includes("indexedDB") || source.includes("document.cookie") ||
    /\bcaches\b/u.test(source) || /serviceWorker\s*\.\s*register\s*\(/u.test(source)) {
  fail("standalone source cannot persist browser state or register background workers");
}
if (new TextEncoder().encode(source).byteLength > 96 * 1024) {
  fail("TypeScript source exceeds 96 KiB");
}
if (new TextEncoder().encode(css).byteLength > 64 * 1024) {
  fail("CSS source exceeds 64 KiB");
}

const result = ts.transpileModule(source, {
  fileName: sourcePath,
  reportDiagnostics: true,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    isolatedModules: true,
    removeComments: false,
    sourceMap: false,
    inlineSourceMap: false,
    inlineSources: false,
    newLine: ts.NewLineKind.LineFeed,
  },
});
const errors = (result.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
);
if (errors.length > 0) {
  fail(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: (value) => value,
    getCurrentDirectory: () => appRoot,
    getNewLine: () => "\n",
  }));
}
if (
  result.outputText.includes("sourceMappingURL") ||
  /(^|\n)\s*(?:import|export)\b/u.test(result.outputText) ||
  /\bimport\s*\(/u.test(result.outputText)
) {
  fail("compiled output is not one standalone source-map-free module");
}
if (new TextEncoder().encode(result.outputText).byteLength > 96 * 1024) {
  fail("compiled JavaScript exceeds 96 KiB");
}

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(outputScript, result.outputText, { encoding: "utf8", mode: 0o644 }),
  writeFile(outputCss, css, { encoding: "utf8", mode: 0o644 }),
]);

process.stdout.write(JSON.stringify({
  protocol: "eliotr.agent-inbox-build.v1",
  script_bytes: new TextEncoder().encode(result.outputText).byteLength,
  css_bytes: new TextEncoder().encode(css).byteLength,
  output_prefix: "/agent-inbox/",
}) + "\n");
