import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TextDecoder, TextEncoder } from "node:util";

const PROTOCOL_HEADER = "# protocol=eliotr.test-vectors.stable-id.v1";
const GENERATION_HEADER = "# schema_generation=1";
const COLUMNS_HEADER =
  "# columns=case_id|operation|input_hex|expected|output_hex|error_code";

const FRAME_BYTES = 1024 * 1024;
const FRAME_CASES = 4096;
const CASE_ID_BYTES = 128;
const VECTOR_PAYLOAD_BYTES = 256 * 1024;

const INPUT_BYTES = 64 * 1024;
const PREFIX_BYTES = 64;
const PARTS = 32;
const PART_BYTES = 4096;
const DIGEST_HEX_BYTES = 48;
const MIN_ID_BYTES = 50;
const MAX_ID_BYTES = 113;

const CODES = Object.freeze({
  inputTooLarge: "ELIOTR_STABLE_ID_INPUT_TOO_LARGE",
  prefixTooLarge: "ELIOTR_STABLE_ID_PREFIX_TOO_LARGE",
  prefix: "ELIOTR_STABLE_ID_PREFIX",
  tooManyParts: "ELIOTR_STABLE_ID_TOO_MANY_PARTS",
  partTooLarge: "ELIOTR_STABLE_ID_PART_TOO_LARGE",
  nul: "ELIOTR_STABLE_ID_NUL",
  utf8: "ELIOTR_STABLE_ID_UTF8",
  length: "ELIOTR_STABLE_ID_LENGTH",
  alphabet: "ELIOTR_STABLE_ID_ALPHABET",
});
const DERIVE_CODES = new Set([
  CODES.inputTooLarge,
  CODES.prefixTooLarge,
  CODES.prefix,
  CODES.tooManyParts,
  CODES.partTooLarge,
  CODES.nul,
  CODES.utf8,
]);
const VALIDATE_CODES = new Set([
  CODES.prefix,
  CODES.utf8,
  CODES.length,
  CODES.alphabet,
]);
const ALL_CODES = new Set([...DERIVE_CODES, ...VALIDATE_CODES]);
const OPERATIONS = new Set(["derive_stable_id", "validate_stable_id"]);
const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

class StableIdError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(message) {
  throw new Error(message);
}

function raise(code) {
  throw new StableIdError(code);
}

function decodeUtf8(input) {
  try {
    return fatalDecoder.decode(input);
  } catch {
    raise(CODES.utf8);
  }
}

function validPrefixByte(byte, first) {
  const alphanumeric =
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a);
  if (first) return alphanumeric;
  return alphanumeric || [0x2e, 0x2f, 0x3a, 0x40, 0x5f, 0x2d].includes(byte);
}

function validatePrefix(input) {
  if (input.byteLength > PREFIX_BYTES) raise(CODES.prefixTooLarge);
  const text = decodeUtf8(input);
  if (
    input.byteLength === 0 ||
    !validPrefixByte(input[0], true) ||
    !input.slice(1).every((byte) => validPrefixByte(byte, false))
  ) {
    raise(CODES.prefix);
  }
  return text;
}

function splitPreimage(input) {
  const segments = [];
  let start = 0;
  for (let index = 0; index < input.byteLength; index += 1) {
    if (input[index] === 0) {
      segments.push(input.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(input.slice(start));
  return segments;
}

function deriveStableIdFrame(input) {
  if (input.byteLength > INPUT_BYTES) raise(CODES.inputTooLarge);
  const [prefix, ...parts] = splitPreimage(input);
  if (parts.length > PARTS) raise(CODES.tooManyParts);
  const prefixText = validatePrefix(prefix);
  for (const part of parts) {
    if (part.byteLength > PART_BYTES) raise(CODES.partTooLarge);
    decodeUtf8(part);
  }
  const digest = createHash("sha256").update(input).digest("hex").slice(0, DIGEST_HEX_BYTES);
  return encoder.encode(`${prefixText}-${digest}`);
}

function validateStableId(input) {
  if (input.byteLength < MIN_ID_BYTES || input.byteLength > MAX_ID_BYTES) {
    raise(CODES.length);
  }
  const text = decodeUtf8(input);
  const separator = text.lastIndexOf("-");
  if (separator < 0) raise(CODES.length);
  const prefixText = text.slice(0, separator);
  const digest = text.slice(separator + 1);
  if (encoder.encode(digest).byteLength !== DIGEST_HEX_BYTES) raise(CODES.length);
  validatePrefix(encoder.encode(prefixText));
  if (!/^[0-9a-f]{48}$/u.test(digest)) raise(CODES.alphabet);
  return Uint8Array.from(input);
}

function decodeHex(value, field, lineNumber) {
  if (value === "-") return new Uint8Array();
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
    fail(`line ${lineNumber}: ${field} is not canonical lowercase hexadecimal`);
  }
  const bytes = Uint8Array.from(Buffer.from(value, "hex"));
  if (bytes.byteLength > VECTOR_PAYLOAD_BYTES) {
    fail(`line ${lineNumber}: ${field} exceeds the vector payload budget`);
  }
  return bytes;
}

function parseFrame(source) {
  if (Buffer.byteLength(source, "utf8") > FRAME_BYTES) fail("stable-ID frame too large");
  const lines = source.split("\n");
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
    if (Buffer.byteLength(caseId, "ascii") > CASE_ID_BYTES) {
      fail(`line ${lineNumber}: case_id too long`);
    }
    if (!/^[a-z][a-z0-9_]*$/u.test(caseId)) fail(`line ${lineNumber}: invalid case_id`);
    if (caseIds.has(caseId)) fail(`line ${lineNumber}: duplicate case_id`);
    caseIds.add(caseId);
    if (!OPERATIONS.has(operation)) fail(`line ${lineNumber}: invalid operation`);

    const input = decodeHex(inputHex, "input_hex", lineNumber);
    if (expected === "ok") {
      if (errorCode !== "-") fail(`line ${lineNumber}: success contains error code`);
      const output = decodeHex(outputHex, "output_hex", lineNumber);
      try {
        validateStableId(output);
      } catch (error) {
        if (error instanceof StableIdError) fail(`line ${lineNumber}: invalid output shape`);
        throw error;
      }
      cases.push({ caseId, operation, input, expected: { kind: "ok", output } });
      continue;
    }

    if (expected !== "error") fail(`line ${lineNumber}: invalid expected outcome`);
    if (outputHex !== "-") fail(`line ${lineNumber}: error contains output bytes`);
    if (!ALL_CODES.has(errorCode)) fail(`line ${lineNumber}: unknown error code`);
    if (operation === "derive_stable_id" && !DERIVE_CODES.has(errorCode)) {
      fail(`line ${lineNumber}: incompatible derive error`);
    }
    if (operation === "validate_stable_id" && !VALIDATE_CODES.has(errorCode)) {
      fail(`line ${lineNumber}: incompatible validation error`);
    }
    cases.push({ caseId, operation, input, expected: { kind: "error", errorCode } });
  }

  if (cases.length === 0) fail("stable-ID frame contains no cases");
  return cases;
}

function execute(testCase) {
  try {
    return {
      kind: "ok",
      output:
        testCase.operation === "derive_stable_id"
          ? deriveStableIdFrame(testCase.input)
          : validateStableId(testCase.input),
    };
  } catch (error) {
    if (error instanceof StableIdError) return { kind: "error", errorCode: error.code };
    throw error;
  }
}

function equalBytes(left, right) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function verifyCases(cases) {
  for (const testCase of cases) {
    const actual = execute(testCase);
    if (testCase.expected.kind === "ok") {
      if (actual.kind !== "ok") {
        fail(`${testCase.caseId}: expected success; received ${actual.errorCode}`);
      }
      if (!equalBytes(actual.output, testCase.expected.output)) {
        fail(`${testCase.caseId}: output mismatch`);
      }
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

export async function verifyStableIdReference(
  fixtureUrl,
  label = "Stable ID",
) {
  const source = await readFile(fixtureUrl, "utf8");
  const cases = parseFrame(source);
  verifyCases(cases);

  const rows = source
    .split("\n")
    .slice(3)
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const firstRow = rows[0];
  if (firstRow === undefined) fail(`${label}: fixture contains no reusable case row`);

  assertRejected(
    "unknown protocol",
    source.replace("stable-id.v1", "unknown.v1"),
    "expected header",
  );
  assertRejected(
    "duplicate identity",
    `${source.endsWith("\n") ? source : `${source}\n`}${firstRow}\n`,
    "duplicate case_id",
  );

  const unknownOperationColumns = firstRow.split("|");
  unknownOperationColumns[1] = "unknown_operation";
  assertRejected(
    "unknown operation",
    source.replace(firstRow, unknownOperationColumns.join("|")),
    "invalid operation",
  );

  const successRow = rows.find((row) => row.includes("|ok|"));
  if (successRow === undefined) fail(`${label}: fixture must contain one success case`);
  const invalidOutputColumns = successRow.split("|");
  invalidOutputColumns[4] = "61";
  assertRejected(
    "invalid output shape",
    source.replace(successRow, invalidOutputColumns.join("|")),
    "invalid output shape",
  );

  const errorRow = rows.find((row) => row.includes("|error|"));
  if (errorRow === undefined) fail(`${label}: fixture must contain one negative case`);
  const unknownErrorColumns = errorRow.split("|");
  unknownErrorColumns[5] = "ELIOTR_UNKNOWN";
  assertRejected(
    "unknown error",
    source.replace(errorRow, unknownErrorColumns.join("|")),
    "unknown error code",
  );

  const incompatibleErrorColumns = errorRow.split("|");
  incompatibleErrorColumns[5] = incompatibleErrorColumns[1] === "derive_stable_id"
    ? CODES.length
    : CODES.tooManyParts;
  assertRejected(
    "incompatible error",
    source.replace(errorRow, incompatibleErrorColumns.join("|")),
    incompatibleErrorColumns[1] === "derive_stable_id"
      ? "incompatible derive error"
      : "incompatible validation error",
  );

  globalThis.console.log(
    `${label} vectors: PASS (${cases.length} bounded cross-runtime cases).`,
  );
}
