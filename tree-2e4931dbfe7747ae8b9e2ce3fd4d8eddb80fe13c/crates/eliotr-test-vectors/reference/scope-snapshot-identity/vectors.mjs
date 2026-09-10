import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

import {
  ALL_CODES,
  CASE_ID_BYTES,
  COLUMNS_HEADER,
  CODES,
  DERIVE_CODES,
  FRAME_BYTES,
  FRAME_CASES,
  GENERATION_HEADER,
  OPERATIONS,
  PROTOCOL_HEADER,
  VECTOR_PAYLOAD_BYTES,
  VERIFY_CODES,
  fatalDecoder,
} from "./constants.mjs";
import { SnapshotError, equalBytes, fail } from "./canonical.mjs";
import { checkDigest, checkSnapshotId, deriveSnapshotIdentity, verifySnapshotIdentity } from "./validate.mjs";

function decodeHex(value, fieldName, lineNumber) {
  if (value === "-") return new Uint8Array();
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
    fail(`line ${lineNumber}: ${fieldName} is not canonical lowercase hexadecimal`);
  }
  const bytes = Uint8Array.from(Buffer.from(value, "hex"));
  if (bytes.byteLength > VECTOR_PAYLOAD_BYTES) {
    fail(`line ${lineNumber}: ${fieldName} exceeds the vector payload budget`);
  }
  return bytes;
}

function splitTransportLines(source) {
  return source.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function parseFrame(source) {
  if (Buffer.byteLength(source, "utf8") > FRAME_BYTES) fail("scope-snapshot-identity frame too large");
  const lines = splitTransportLines(source);
  if (lines.at(-1) === "") lines.pop();
  [PROTOCOL_HEADER, GENERATION_HEADER, COLUMNS_HEADER].forEach((expected, index) => {
    if (lines[index] === undefined) fail(`line ${index + 1}: missing header ${expected}`);
    if (lines[index] !== expected) fail(`line ${index + 1}: expected header ${expected}`);
  });
  const cases = [];
  const caseIds = new Set();
  for (const [offset, line] of lines.slice(3).entries()) {
    const lineNumber = offset + 4;
    if (line.length === 0) fail(`line ${lineNumber}: unexpected blank line`);
    if (line.startsWith("#")) fail(`line ${lineNumber}: unexpected header`);
    if (cases.length === FRAME_CASES) fail(`line ${lineNumber}: too many cases`);
    const columns = line.split("|");
    if (columns.length !== 6) fail(`line ${lineNumber}: expected 6 columns`);
    const [caseId, operation, inputHex, expected, outputHex, errorCode] = columns;
    if (Buffer.byteLength(caseId, "ascii") > CASE_ID_BYTES) fail(`line ${lineNumber}: case_id too long`);
    if (!/^[a-z][a-z0-9_]*$/u.test(caseId)) fail(`line ${lineNumber}: invalid case_id`);
    if (caseIds.has(caseId)) fail(`line ${lineNumber}: duplicate case_id`);
    caseIds.add(caseId);
    if (!OPERATIONS.has(operation)) fail(`line ${lineNumber}: invalid operation`);
    const input = decodeHex(inputHex, "input_hex", lineNumber);
    if (expected === "ok") {
      if (errorCode !== "-") fail(`line ${lineNumber}: success contains error code`);
      const output = decodeHex(outputHex, "output_hex", lineNumber);
      try {
        const text = fatalDecoder.decode(output);
        const parsed = JSON.parse(text);
        if (typeof parsed.snapshot_id !== "string" || typeof parsed.digest !== "string") {
          fail(`line ${lineNumber}: invalid output shape`);
        }
        checkSnapshotId(parsed.snapshot_id);
        checkDigest(parsed.digest);
      } catch (error) {
        if (error instanceof SnapshotError) fail(`line ${lineNumber}: invalid output shape`);
        if (error instanceof SyntaxError) fail(`line ${lineNumber}: invalid output shape`);
        throw error;
      }
      if (operation === "verify_snapshot_identity") {
        const roundTrip = verifySnapshotIdentity(output);
        if (!equalBytes(roundTrip, output)) fail(`line ${lineNumber}: invalid output shape`);
      }
      cases.push({ caseId, operation, input, expected: { kind: "ok", output } });
      continue;
    }
    if (expected !== "error") fail(`line ${lineNumber}: invalid expected outcome`);
    if (outputHex !== "-") fail(`line ${lineNumber}: error contains output bytes`);
    if (!ALL_CODES.has(errorCode)) fail(`line ${lineNumber}: unknown error code`);
    if (operation === "derive_snapshot_identity" && !DERIVE_CODES.has(errorCode)) {
      fail(`line ${lineNumber}: incompatible derive error`);
    }
    if (operation === "verify_snapshot_identity" && !VERIFY_CODES.has(errorCode)) {
      fail(`line ${lineNumber}: incompatible validation error`);
    }
    cases.push({ caseId, operation, input, expected: { kind: "error", errorCode } });
  }
  if (cases.length === 0) fail("scope-snapshot-identity frame contains no cases");
  return cases;
}

function execute(testCase) {
  try {
    return {
      kind: "ok",
      output: testCase.operation === "derive_snapshot_identity"
        ? deriveSnapshotIdentity(testCase.input)
        : verifySnapshotIdentity(testCase.input),
    };
  } catch (error) {
    if (error instanceof SnapshotError) return { kind: "error", errorCode: error.code };
    throw error;
  }
}

function verifyCases(cases) {
  for (const testCase of cases) {
    const actual = execute(testCase);
    if (testCase.expected.kind === "ok") {
      if (actual.kind !== "ok") fail(`${testCase.caseId}: expected success; received ${actual.errorCode}`);
      if (!equalBytes(actual.output, testCase.expected.output)) fail(`${testCase.caseId}: output mismatch`);
      continue;
    }
    if (actual.kind !== "error") fail(`${testCase.caseId}: expected error; received success`);
    if (actual.errorCode !== testCase.expected.errorCode) {
      fail(`${testCase.caseId}: expected ${testCase.expected.errorCode}; received ${actual.errorCode}`);
    }
  }
}

function assertRejected(name, source, expectedMessage) {
  try {
    parseFrame(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expectedMessage)) fail(`${name}: wrong rejection: ${message}`);
    return;
  }
  fail(`${name}: malformed frame was accepted`);
}

export async function verifyScopeSnapshotIdentityReference(fixtureUrl, label = "Scope snapshot identity") {
  const raw = await readFile(fixtureUrl, "utf8");
  const source = splitTransportLines(raw).join("\n");
  const cases = parseFrame(source);
  verifyCases(cases);
  const crlfCases = parseFrame(source.replace(/\n/g, "\r\n"));
  if (crlfCases.length !== cases.length) fail(`${label}: CRLF transport changed the case count`);
  verifyCases(crlfCases);
  const rows = source.split("\n").slice(3).filter((line) => line.length > 0 && !line.startsWith("#"));
  const firstRow = rows[0];
  if (firstRow === undefined) fail(`${label}: fixture contains no reusable case row`);
  assertRejected("unknown protocol", source.replace("scope-snapshot-identity.v1", "unknown.v1"), "expected header");
  assertRejected("wrong schema generation", source.replace("# schema_generation=1", "# schema_generation=2"), "expected header");
  assertRejected("duplicate identity", `${source.endsWith("\n") ? source : `${source}\n`}${firstRow}\n`, "duplicate case_id");
  assertRejected("prototype case identity", source.replace(firstRow, firstRow.replace(/^[^|]+/u, "__proto__")), "invalid case_id");
  const unknownOperationColumns = firstRow.split("|");
  unknownOperationColumns[1] = "unknown_operation";
  assertRejected("unknown operation", source.replace(firstRow, unknownOperationColumns.join("|")), "invalid operation");
  const successRow = rows.find((row) => row.includes("|ok|"));
  if (successRow === undefined) fail(`${label}: fixture must contain one success case`);
  const invalidOutputColumns = successRow.split("|");
  invalidOutputColumns[4] = "61";
  assertRejected("invalid output shape", source.replace(successRow, invalidOutputColumns.join("|")), "invalid output shape");
  const errorRow = rows.find((row) => row.includes("|error|"));
  if (errorRow === undefined) fail(`${label}: fixture must contain one negative case`);
  const unknownErrorColumns = errorRow.split("|");
  unknownErrorColumns[5] = "ELIOTR_UNKNOWN";
  assertRejected("unknown error", source.replace(errorRow, unknownErrorColumns.join("|")), "unknown error code");
  const incompatibleErrorColumns = errorRow.split("|");
  incompatibleErrorColumns[5] = incompatibleErrorColumns[1] === "derive_snapshot_identity" ? CODES.idMismatch : CODES.inputTooLarge;
  if (incompatibleErrorColumns[1] === "verify_snapshot_identity") {
    incompatibleErrorColumns[5] = "__invalid__";
  }
  const probe = errorRow.split("|");
  probe[5] = probe[1] === "derive_snapshot_identity" ? CODES.idMismatch : CODES.nodeLimit;
  const probeIsIncompatible = probe[1] === "derive_snapshot_identity"
    ? !DERIVE_CODES.has(probe[5])
    : !VERIFY_CODES.has(probe[5]);
  if (probeIsIncompatible) {
    assertRejected(
      "incompatible error",
      source.replace(errorRow, probe.join("|")),
      probe[1] === "derive_snapshot_identity" ? "incompatible derive error" : "incompatible validation error",
    );
  }
  globalThis.console.log(`${label} vectors: PASS (${cases.length} bounded cross-runtime cases, CRLF transport PASS).`);
}

export function parseScopeSnapshotIdentityCases(source) {
  return parseFrame(splitTransportLines(source).join("\n"));
}
