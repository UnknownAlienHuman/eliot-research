// Self-contained clean-checkout gate: this script rebuilds the exact production
// contracts+domain `dist` from source BEFORE importing the differential oracle,
// so CI ordering (no prior build, no pre-existing dist) cannot fail with
// ERR_MODULE_NOT_FOUND and stale dist can never mask a divergence. The oracle
// still exercises the actual production Zod schemas/functions byte-for-byte.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const fixtureUrl = new URL(
  "../crates/eliotr-test-vectors/fixtures/canonical-utf8.v1.txt",
  import.meta.url,
);

const EXPECTED_HEADERS = Object.freeze([
  "# protocol=eliotr.test-vectors.canonical-utf8.v1",
  "# schema_generation=1",
  "# columns=case_id|max_bytes|input_hex|expected|output_hex|error_code",
]);
const MAX_VECTOR_FRAME_BYTES = 1024 * 1024;
const MAX_VECTOR_CASES = 4096;
const MAX_VECTOR_CASE_ID_BYTES = 128;
const MAX_VECTOR_PAYLOAD_BYTES = 256 * 1024;
const MAX_VECTOR_MAX_BYTES = 0xffff_ffff;
const UTF8_TOO_LARGE_CODE = "ELIOTR_UTF8_TOO_LARGE";
const UTF8_INVALID_CODE = "ELIOTR_UTF8_INVALID";
const ERROR_CODES = new Set([UTF8_TOO_LARGE_CODE, UTF8_INVALID_CODE]);
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

function fail(message) {
  throw new Error(message);
}

function decodeHex(value, field, lineNumber) {
  if (value === "-") return new Uint8Array();
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
    fail(`line ${lineNumber}: ${field} is not canonical lowercase hexadecimal`);
  }

  const decodedBytes = value.length / 2;
  if (decodedBytes > MAX_VECTOR_PAYLOAD_BYTES) {
    fail(
      `line ${lineNumber}: ${field} has ${decodedBytes} decoded bytes; maximum is ${MAX_VECTOR_PAYLOAD_BYTES}`,
    );
  }
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function parseMaxBytes(value, lineNumber) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    fail(`line ${lineNumber}: max_bytes is not a canonical unsigned 32-bit decimal integer`);
  }

  const parsed = BigInt(value);
  if (parsed > BigInt(MAX_VECTOR_MAX_BYTES)) {
    fail(`line ${lineNumber}: max_bytes exceeds the unsigned 32-bit range`);
  }
  return Number(parsed);
}

function parseCaseId(value, lineNumber) {
  if (Buffer.byteLength(value, "utf8") > MAX_VECTOR_CASE_ID_BYTES) {
    fail(`line ${lineNumber}: case_id exceeds ${MAX_VECTOR_CASE_ID_BYTES} bytes`);
  }
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    fail(`line ${lineNumber}: invalid case_id`);
  }
  return value;
}

function splitStrictLines(source) {
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function parseFrame(source) {
  const frameBytes = Buffer.byteLength(source, "utf8");
  if (frameBytes > MAX_VECTOR_FRAME_BYTES) {
    fail(`vector frame has ${frameBytes} bytes; maximum is ${MAX_VECTOR_FRAME_BYTES}`);
  }

  const lines = splitStrictLines(source).map((line, index) => ({ line, number: index + 1 }));

  for (const [index, expected] of EXPECTED_HEADERS.entries()) {
    const actual = lines[index];
    if (actual === undefined) fail(`line ${index + 1}: missing header ${expected}`);
    if (actual.line !== expected) {
      fail(`line ${actual.number}: expected header ${expected}`);
    }
  }

  const cases = [];
  const caseIds = new Set();
  for (const { line, number } of lines.slice(EXPECTED_HEADERS.length)) {
    if (line.length === 0) fail(`line ${number}: unexpected blank line`);
    if (line.startsWith("#")) fail(`line ${number}: unexpected header after column declaration`);
    if (cases.length === MAX_VECTOR_CASES) {
      fail(`line ${number}: vector frame exceeds ${MAX_VECTOR_CASES} cases`);
    }

    const columns = line.split("|");
    if (columns.length !== 6) fail(`line ${number}: expected 6 columns; received ${columns.length}`);

    const [rawCaseId, rawMaxBytes, inputHex, expected, outputHex, errorCode] = columns;
    const caseId = parseCaseId(rawCaseId, number);
    if (caseIds.has(caseId)) fail(`line ${number}: duplicate case_id ${caseId}`);
    caseIds.add(caseId);

    const maxBytes = parseMaxBytes(rawMaxBytes, number);
    const input = decodeHex(inputHex, "input_hex", number);

    if (expected === "ok") {
      if (errorCode !== "-") fail(`line ${number}: success case contains an error code`);
      cases.push({
        caseId,
        maxBytes,
        input,
        expected: { kind: "ok", output: decodeHex(outputHex, "output_hex", number) },
      });
      continue;
    }

    if (expected === "error") {
      if (outputHex !== "-") fail(`line ${number}: error case contains output bytes`);
      if (!ERROR_CODES.has(errorCode)) fail(`line ${number}: unknown error code ${errorCode}`);
      cases.push({
        caseId,
        maxBytes,
        input,
        expected: { kind: "error", errorCode },
      });
      continue;
    }

    fail(`line ${number}: unknown expected outcome ${expected}`);
  }

  if (cases.length === 0) fail("vector frame contains no cases");
  return cases;
}

function validateUtf8Transport(input, maxBytes) {
  if (input.byteLength > maxBytes) {
    return { kind: "error", errorCode: UTF8_TOO_LARGE_CODE };
  }

  try {
    fatalUtf8.decode(input);
    return { kind: "ok", output: input };
  } catch {
    return { kind: "error", errorCode: UTF8_INVALID_CODE };
  }
}

function equalBytes(left, right) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function verifyCases(cases) {
  for (const testCase of cases) {
    const actual = validateUtf8Transport(testCase.input, testCase.maxBytes);
    if (testCase.expected.kind === "ok") {
      if (actual.kind !== "ok") {
        fail(`${testCase.caseId}: expected success; received ${actual.errorCode}`);
      }
      if (!equalBytes(actual.output, testCase.expected.output)) {
        fail(`${testCase.caseId}: output bytes differ`);
      }
      continue;
    }

    if (actual.kind !== "error") fail(`${testCase.caseId}: expected an error; received success`);
    if (actual.errorCode !== testCase.expected.errorCode) {
      fail(
        `${testCase.caseId}: expected ${testCase.expected.errorCode}; received ${actual.errorCode}`,
      );
    }
  }
}

function assertRejected(name, source, expectedMessage) {
  try {
    parseFrame(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expectedMessage)) {
      fail(`${name}: wrong rejection: ${message}`);
    }
    return;
  }
  fail(`${name}: malformed fixture was accepted`);
}

const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const CONTRACTS_DIST = join(REPO_ROOT, "packages", "contracts", "dist");
const DOMAIN_DIST = join(REPO_ROOT, "packages", "domain", "dist");
const REQUIRED_DIST_ENTRIES = Object.freeze([
  join(CONTRACTS_DIST, "common.js"),
  join(CONTRACTS_DIST, "scope.js"),
  join(DOMAIN_DIST, "scope", "snapshot-identity.js"),
]);
const BUILD_PACKAGES = Object.freeze(["packages/contracts", "packages/domain"]);
const PINNED_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;

function readPackageJson(packagePath) {
  try {
    return JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    fail(`rust-vectors gate: cannot read ${packagePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readPinnedVersion(packagePath, field) {
  const parsed = readPackageJson(packagePath);
  const version = parsed.dependencies?.[field] ?? parsed.devDependencies?.[field];
  if (typeof version !== "string" || !PINNED_VERSION.test(version)) {
    fail(`rust-vectors gate: pinned ${field} version is missing in ${packagePath}`);
  }
  return version;
}

function runGateCommand(binary, args, label, extraEnv, useShell = process.platform === "win32") {
  console.log(`rust-vectors gate: ${label}: ${[binary, ...args].join(" ")}`);
  // Windows resolves `.cmd` shims (pnpm/corepack) only via the shell; Linux
  // keeps exact argv dispatch without a shell. Real binaries (node) never need
  // the shell, which also avoids quoting spaced install paths.
  const result = spawnSync(binary, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: useShell,
    ...(extraEnv === undefined ? {} : { env: { ...process.env, ...extraEnv } }),
  });
  if (result.error) {
    fail(`rust-vectors gate: ${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`rust-vectors gate: ${label} exited with code ${result.status}`);
  }
}

function captureStdout(binary, args) {
  const result = spawnSync(binary, args, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "ignore"],
    shell: process.platform === "win32",
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return undefined;
  return typeof result.stdout === "string" ? result.stdout.trim() : undefined;
}

// The production build needs the workspace install: the `@eliotr/contracts`
// symlink for `tsc -b`, plus zod/vitest for compile and runtime. All three
// probes must hold; anything else fails closed into the bootstrap below.
function workspaceIsInstalled() {
  return (
    existsSync(join(REPO_ROOT, "node_modules", ".modules.yaml")) &&
    existsSync(join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc")) &&
    existsSync(
      join(
        REPO_ROOT,
        "packages",
        "domain",
        "node_modules",
        "@eliotr",
        "contracts",
        "package.json",
      ),
    )
  );
}

// Ensures the frozen workspace install exists. A bare `tsc -b` cannot work on a
// clean checkout (no workspace symlinks, no zod/vitest), so the gate performs
// the same `pnpm install --frozen-lockfile` the verify job runs — pinned via
// the root `packageManager` field and activated through corepack when needed.
// Install output lands in git-ignored node_modules only; no tracked file changes.
function ensureWorkspace() {
  if (workspaceIsInstalled()) {
    console.log("rust-vectors gate: frozen workspace dependencies present; reusing the repo toolchain.");
    return;
  }
  const rootPkg = readPackageJson(join(REPO_ROOT, "package.json"));
  const manager = typeof rootPkg.packageManager === "string" ? rootPkg.packageManager : "";
  const match = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(manager);
  if (match === null) {
    fail("rust-vectors gate: root packageManager must pin pnpm (for example pnpm@11.23.0)");
  }
  const pinnedPnpm = match[1];
  if (captureStdout("pnpm", ["--version"]) !== pinnedPnpm) {
    runGateCommand(
      "corepack",
      ["prepare", `pnpm@${pinnedPnpm}`, "--activate"],
      `activating repo-pinned pnpm@${pinnedPnpm} via corepack`,
      { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    );
  }
  runGateCommand("pnpm", ["install", "--frozen-lockfile"], "installing frozen workspace dependencies");
  if (!workspaceIsInstalled()) {
    fail("rust-vectors gate: workspace install completed but dependencies are still unresolvable");
  }
}

// Rebuilds the exact production dist fresh on every run: stale output is
// removed first so it can never mask a divergence, and the build fails closed.
function ensureFreshProductionDist() {
  ensureWorkspace();
  const typescriptPinned = readPinnedVersion(join(REPO_ROOT, "package.json"), "typescript");
  for (const distDir of [CONTRACTS_DIST, DOMAIN_DIST]) {
    rmSync(distDir, { recursive: true, force: true });
  }
  console.log("rust-vectors gate: removed stale contracts+domain dist; rebuilding fresh from source.");
  const localTsc = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(localTsc)) {
    fail("rust-vectors gate: workspace install did not provide the repo TypeScript compiler");
  }
  runGateCommand(
    process.execPath,
    [localTsc, "-b", ...BUILD_PACKAGES],
    `rebuilding exact production dist with repo typescript@${typescriptPinned}`,
    undefined,
    false,
  );
  for (const entry of REQUIRED_DIST_ENTRIES) {
    if (!existsSync(entry)) {
      fail(`rust-vectors gate: fresh build did not emit ${entry}`);
    }
  }
}

function assertProductionZodPath(modules) {
  const { IsoDateTimeSchema } = modules[0];
  const { ScopeSnapshotSchema } = modules[1];
  const { scopeSnapshotDigestPayload, scopeSnapshotIdentityPayload } = modules[2];
  if (typeof IsoDateTimeSchema?.safeParse !== "function") {
    fail("rust-vectors gate: fresh contracts dist does not export IsoDateTimeSchema");
  }
  if (typeof ScopeSnapshotSchema?.safeParse !== "function") {
    fail("rust-vectors gate: fresh contracts dist does not export ScopeSnapshotSchema");
  }
  if (
    typeof scopeSnapshotIdentityPayload !== "function" ||
    typeof scopeSnapshotDigestPayload !== "function"
  ) {
    fail("rust-vectors gate: fresh domain dist does not export the snapshot payload builders");
  }
  console.log(
    "rust-vectors gate: fresh dist built; exercising IsoDateTimeSchema/ScopeSnapshotSchema + scopeSnapshotIdentityPayload/scopeSnapshotDigestPayload from the exact production build.",
  );
}

ensureFreshProductionDist();
const productionModules = [];
for (const entry of REQUIRED_DIST_ENTRIES) {
  productionModules.push(await import(pathToFileURL(entry).href));
}
assertProductionZodPath(productionModules);

const { verifyCanonicalBodyReference } = await import(
  pathToFileURL(
    join(REPO_ROOT, "crates", "eliotr-test-vectors", "reference", "canonical-body.mjs"),
  ).href
);
const { verifyOwnerTokenReference } = await import(
  pathToFileURL(
    join(REPO_ROOT, "crates", "eliotr-test-vectors", "reference", "owner-token.mjs"),
  ).href
);
const { verifyScopeSnapshotIdentityReference } = await import(
  pathToFileURL(
    join(REPO_ROOT, "crates", "eliotr-test-vectors", "reference", "scope-snapshot-identity.mjs"),
  ).href
);
const { verifyScopeSnapshotIdentityDifferential } = await import(
  pathToFileURL(
    join(
      REPO_ROOT,
      "crates",
      "eliotr-test-vectors",
      "reference",
      "scope-snapshot-identity-differential.mjs",
    ),
  ).href
);
const { verifyResidencyKeyReference } = await import(
  pathToFileURL(
    join(REPO_ROOT, "crates", "eliotr-test-vectors", "reference", "residency-key.mjs"),
  ).href
);
const { verifyStableIdReference } = await import(
  pathToFileURL(
    join(REPO_ROOT, "crates", "eliotr-test-vectors", "reference", "stable-id.mjs"),
  ).href
);

const source = await readFile(fixtureUrl, "utf8");
const cases = parseFrame(source);
verifyCases(cases);

const crlfTransport = splitStrictLines(source)
  .join("\n")
  .replace(/\n/g, "\r\n");
const crlfCases = parseFrame(crlfTransport);
if (crlfCases.length !== cases.length) {
  fail("CRLF transport changed the M1 case count");
}
verifyCases(crlfCases);

assertRejected(
  "unknown protocol",
  source.replace("eliotr.test-vectors.canonical-utf8.v1", "eliotr.test-vectors.unknown.v1"),
  "expected header",
);
assertRejected(
  "unknown error code",
  source.replace("ELIOTR_UTF8_INVALID", "ELIOTR_UNKNOWN"),
  "unknown error code",
);
assertRejected(
  "duplicate identity",
  `${source}ascii_exact|5|68656c6c6f|ok|68656c6c6f|-\n`,
  "duplicate case_id",
);
assertRejected(
  "interior blank line",
  source.replace("ascii_exact", "\nascii_exact"),
  "unexpected blank line",
);
assertRejected(
  "oversized case identity",
  source.replace("ascii_exact", "a".repeat(MAX_VECTOR_CASE_ID_BYTES + 1)),
  "case_id exceeds",
);
assertRejected(
  "architecture-dependent max_bytes",
  source.replace("ascii_exact|5|", "ascii_exact|4294967296|"),
  "unsigned 32-bit range",
);
assertRejected(
  "oversized decoded input",
  source.replace("68656c6c6f|ok", `${"00".repeat(MAX_VECTOR_PAYLOAD_BYTES + 1)}|ok`),
  "input_hex has",
);

const tooManyCases = [
  ...EXPECTED_HEADERS,
  ...Array.from(
    Array.from({ length: MAX_VECTOR_CASES + 1 }).keys(),
    (index) => `case_${index}|1|61|ok|61|-`,
  ),
  "",
].join("\n");
assertRejected("oversized case count", tooManyCases, "vector frame exceeds");
assertRejected(
  "oversized frame",
  `${source}${"#".repeat(MAX_VECTOR_FRAME_BYTES)}`,
  "vector frame has",
);

console.log(
  `Rust migration vectors: PASS (${cases.length} cases; bounded strict-parser negatives PASS).`,
);
await verifyCanonicalBodyReference(
  new URL(
    "../crates/eliotr-test-vectors/fixtures/canonical-body.v1.txt",
    import.meta.url,
  ),
);
await verifyCanonicalBodyReference(
  new URL(
    "../crates/eliotr-test-vectors/fixtures/owner-cutover-canonical.v1.txt",
    import.meta.url,
  ),
  "Owner-cutover canonical",
);
await verifyResidencyKeyReference(
  new URL(
    "../crates/eliotr-test-vectors/fixtures/residency-key.v1.txt",
    import.meta.url,
  ),
);
await verifyStableIdReference(
  new URL(
    "../crates/eliotr-test-vectors/fixtures/stable-id.v1.txt",
    import.meta.url,
  ),
);
await verifyStableIdReference(
  new URL(
    "../crates/eliotr-test-vectors/fixtures/ingest-identities.v1.txt",
    import.meta.url,
  ),
  "Ingest identity",
);
await verifyStableIdReference(
  new URL(
    "../crates/eliotr-test-vectors/fixtures/projection-identities.v1.txt",
    import.meta.url,
  ),
  "Projection identity",
);
await verifyOwnerTokenReference(
  new URL(
    "../crates/eliotr-test-vectors/fixtures/owner-token.v1.txt",
    import.meta.url,
  ),
);
await verifyScopeSnapshotIdentityReference(
  new URL(
    "../crates/eliotr-test-vectors/fixtures/scope-snapshot-identity.v1.txt",
    import.meta.url,
  ),
);
await verifyScopeSnapshotIdentityDifferential(
  new URL(
    "../crates/eliotr-test-vectors/fixtures/scope-snapshot-identity.v1.txt",
    import.meta.url,
  ),
);
