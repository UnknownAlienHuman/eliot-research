// Direct differential oracle: accepted TypeScript authority vs committed corpus.
//
// This oracle runs the ACTUAL admitted TypeScript functions — not a duplicate
// reimplementation — over every committed `scope-snapshot-identity.v1` derive case:
//   - `scopeSnapshotIdentityPayload` / `scopeSnapshotDigestPayload` from the accepted
//     `@eliotr/domain` build (fresh `dist`, rebuilt by the gate before this runs);
//   - `IsoDateTimeSchema` / `ScopeSnapshotSchema` from the accepted
//     `@eliotr/contracts` build (fresh `dist`);
//   - the `expectedSnapshotIdentity` service formula (canonical identity bytes,
//     `scope-` + 48 hex chars of SHA-256, digest over `snapshot_id` + identity
//     payload) is replayed with node:crypto and compared byte-for-byte against
//     the committed output that native Rust, Rust/Wasm and the reference verify.
//
// Symbol evidence: `expectedSnapshotIdentity` is module-private in
// `packages/cloudflare-navigation/src/scope-service.ts:356`
// (`async function expectedSnapshotIdentity(`, no `export` keyword; only
// internal call sites at `:398` and `:527`). It cannot be imported, so the
// oracle invokes the actual exported production path where possible —
// `packages/domain/src/scope/snapshot-identity.ts:7`
// `export function scopeSnapshotIdentityPayload` and `:24`
// `export function scopeSnapshotDigestPayload` — plus the exact production
// formula from `scope-service.ts:359-365` (`canonicalJson(identityPayload)` →
// `scope-` + 48 hex of SHA-256 → `canonicalJson(digestPayload)` → SHA-256
// digest). This is a compared replay against exported builders, never a silent
// local-replay-as-service-call: any divergence in builders, key order, hash,
// or prefix fails the byte comparison below.
//
// Derive inputs carrying caller-supplied `snapshot_id`/`digest` are the intentional
// fail-closed divergence: TypeScript strips extra keys while the M2 derive path
// rejects them with `ELIOTR_SNAPSHOT_UNKNOWN_FIELD`. The oracle asserts both sides
// so the divergence stays explicit instead of drifting into a parity miss.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TextDecoder, TextEncoder } from "node:util";

import { IsoDateTimeSchema } from "../../../packages/contracts/dist/common.js";
import { ScopeSnapshotSchema as SnapshotSchema } from "../../../packages/contracts/dist/scope.js";
import {
  scopeSnapshotDigestPayload,
  scopeSnapshotIdentityPayload,
} from "../../../packages/domain/dist/scope/snapshot-identity.js";
import { parseScopeSnapshotIdentityCases } from "./scope-snapshot-identity.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("oracle canonical JSON requires safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort(compareText);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("oracle canonical JSON contains a non-JSON value");
}

function sha256Hex(text) {
  return createHash("sha256").update(encoder.encode(text)).digest("hex");
}

// Replays the accepted `expectedSnapshotIdentity` service path using the actual
// TypeScript payload builders. Returns canonical full-snapshot bytes.
function expectedSnapshotBytes(material) {
  const identityPayload = scopeSnapshotIdentityPayload(material);
  if (Object.hasOwn(identityPayload, "snapshot_id") || Object.hasOwn(identityPayload, "digest")) {
    throw new Error("oracle: TypeScript identity payload leaked a derived key");
  }
  const identityJson = canonicalJson(identityPayload);
  const snapshotId = `scope-${sha256Hex(identityJson).slice(0, 48)}`;
  const digestJson = canonicalJson(scopeSnapshotDigestPayload({ snapshot_id: snapshotId, ...material }));
  const digest = sha256Hex(digestJson);
  return encoder.encode(canonicalJson({ ...material, snapshot_id: snapshotId, digest }));
}

function fail(message) {
  throw new Error(message);
}

function equalBytes(left, right) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export async function verifyScopeSnapshotIdentityDifferential(fixtureUrl, label = "Scope snapshot identity differential") {
  const raw = await readFile(fixtureUrl, "utf8");
  const cases = parseScopeSnapshotIdentityCases(raw);
  let checked = 0;
  let longFraction = 0;
  let optionalSeconds = 0;
  let timestampNegatives = 0;
  let offsetCases = 0;
  for (const testCase of cases) {
    if (testCase.operation !== "derive_snapshot_identity") continue;
    const named = testCase.caseId === "derive_with_snapshot_id" || testCase.caseId === "derive_with_digest";
    const timestampCase = testCase.expected.kind === "error" && testCase.expected.errorCode === "ELIOTR_SNAPSHOT_TIMESTAMP";
    let material;
    try {
      material = JSON.parse(decoder.decode(testCase.input));
    } catch {
      // Non-UTF-8 / non-JSON negatives are covered by the reference, native and
      // Wasm gates; the oracle only replays decodable materials through TS.
      if (testCase.expected.kind === "ok" || named || timestampCase) {
        fail(`${testCase.caseId}: oracle could not decode a material it must replay`);
      }
      continue;
    }
    if (testCase.expected.kind === "ok") {
      // BIDIRECTIONAL row 1/2: Rust/reference admit (ok corpus) → TS must admit.
      // The accepted authority must admit both timestamps, including optional
      // seconds (`2026-01-01T00:00Z`), offsets, and runs of more than nine
      // fractional digits that the previous ports wrongly rejected.
      for (const field of ["created_at", "expires_at"]) {
        if (!IsoDateTimeSchema.safeParse(material[field]).success) {
          fail(`${testCase.caseId}: accepted TS schema rejected ${field} (Rust admits, TS rejects)`);
        }
        if (/\.\d{10,}/u.test(material[field])) longFraction += 1;
        if (/T\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/u.test(material[field])) optionalSeconds += 1;
        if (/[+-]\d{2}:\d{2}$/u.test(material[field])) offsetCases += 1;
      }
      const expected = expectedSnapshotBytes(material);
      if (!equalBytes(expected, testCase.expected.output)) {
        fail(`${testCase.caseId}: TypeScript service path differs from the committed output`);
      }
      // The derived snapshot must validate under the accepted contract schema.
      if (!SnapshotSchema.safeParse(JSON.parse(decoder.decode(expected))).success) {
        fail(`${testCase.caseId}: accepted contract schema rejected the derived snapshot`);
      }
      checked += 1;
      continue;
    }
    if (testCase.caseId === "derive_with_snapshot_id" || testCase.caseId === "derive_with_digest") {
      if (testCase.expected.kind !== "error" || testCase.expected.errorCode !== "ELIOTR_SNAPSHOT_UNKNOWN_FIELD") {
        fail(`${testCase.caseId}: derived-key rejection must stay fail-closed unknown-field`);
      }
      // TypeScript strips extra keys; the M2 derive path rejects them instead.
      const identityPayload = scopeSnapshotIdentityPayload(material);
      if (Object.hasOwn(identityPayload, "snapshot_id") || Object.hasOwn(identityPayload, "digest")) {
        fail(`${testCase.caseId}: oracle expected TypeScript to strip derived keys`);
      }
      checked += 1;
      continue;
    }
    if (testCase.expected.errorCode === "ELIOTR_SNAPSHOT_TIMESTAMP") {
      // BIDIRECTIONAL row 2/2: Rust/reference reject (TIMESTAMP corpus) → TS
      // must reject at least one timestamp. Fails either direction: TS admits
      // what Rust rejects, or (above) TS rejects what Rust admits.
      const createdOk = IsoDateTimeSchema.safeParse(material.created_at).success;
      const expiresOk = IsoDateTimeSchema.safeParse(material.expires_at).success;
      if (createdOk && expiresOk) fail(`${testCase.caseId}: TS schema admitted a rejected timestamp (Rust rejects, TS admits)`);
      timestampNegatives += 1;
      checked += 1;
    }
  }
  if (checked === 0) fail(`${label}: oracle checked no cases`);
  if (longFraction === 0) fail(`${label}: corpus must contain a committed >9-digit timestamp case`);
  if (optionalSeconds === 0) fail(`${label}: corpus must contain a committed optional-seconds timestamp case`);
  if (timestampNegatives === 0) fail(`${label}: corpus must contain a committed TIMESTAMP negative (no success-only parity)`);
  if (offsetCases === 0) fail(`${label}: corpus must contain a committed offset timestamp case`);
  globalThis.console.log(
    `${label}: PASS (${checked} derive cases replayed through the accepted TS schema/functions, ${longFraction} >9-digit timestamp fields, ${optionalSeconds} optional-seconds fields, ${timestampNegatives} TIMESTAMP negatives, ${offsetCases} offset fields).`,
  );
}
