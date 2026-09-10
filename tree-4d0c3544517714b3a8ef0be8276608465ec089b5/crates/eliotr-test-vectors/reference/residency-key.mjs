import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { TextDecoder, TextEncoder } from "node:util";

const PROTOCOL_HEADER = "# protocol=eliotr.test-vectors.residency-key.v1";
const GENERATION_HEADER = "# schema_generation=1";
const COLUMNS_HEADER =
  "# columns=case_id|scope_hex|access_hex|confidentiality_hex|encryption_hex|retention_hex|erasure_hex|digest_hex|expected|output_hex|error_code";

const FRAME_BYTES = 1024 * 1024;
const FRAME_CASES = 4096;
const CASE_ID_BYTES = 128;
const FIELD_BYTES = 1024;
const OUTPUT_BYTES = 16 * 1024;
const IDENTIFIER_UTF8_BYTES = 256 * 3;
const IDENTIFIER_UTF16_UNITS = 256;
const VERSION = "object-residency-key.v1";
const ALGORITHM = "sha256";

const CODES = Object.freeze({
  identifierInputTooLarge: "ELIOTR_RESIDENCY_KEY_IDENTIFIER_INPUT_TOO_LARGE",
  utf8: "ELIOTR_RESIDENCY_KEY_UTF8",
  emptyIdentifier: "ELIOTR_RESIDENCY_KEY_EMPTY_IDENTIFIER",
  identifierTooLong: "ELIOTR_RESIDENCY_KEY_IDENTIFIER_TOO_LONG",
  digestLength: "ELIOTR_RESIDENCY_KEY_DIGEST_LENGTH",
  digestAlphabet: "ELIOTR_RESIDENCY_KEY_DIGEST_ALPHABET",
});
const ERROR_CODES = new Set(Object.values(CODES));
const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

class ResidencyKeyError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(message) {
  throw new Error(message);
}

function raise(code) {
  throw new ResidencyKeyError(code);
}

function decodeUtf8(input) {
  try {
    return fatalDecoder.decode(input);
  } catch {
    raise(CODES.utf8);
  }
}

function validateIdentifier(input) {
  if (input.byteLength > IDENTIFIER_UTF8_BYTES) {
    raise(CODES.identifierInputTooLarge);
  }
  const text = decodeUtf8(input);
  if (text.length === 0) raise(CODES.emptyIdentifier);
  if (text.length > IDENTIFIER_UTF16_UNITS) raise(CODES.identifierTooLong);
  return text;
}

function validateDigest(input) {
  if (input.byteLength !== 64) raise(CODES.digestLength);
  const text = decodeUtf8(input);
  if (!/^[0-9a-f]{64}$/u.test(text)) raise(CODES.digestAlphabet);
  return text;
}

function serializeResidencyKey(testCase) {
  const identifiers = [
    testCase.scope,
    testCase.access,
    testCase.confidentiality,
    testCase.encryption,
    testCase.retention,
    testCase.erasure,
  ].map(validateIdentifier);
  const digest = validateDigest(testCase.digest);
  return encoder.encode(
    [VERSION, ...identifiers, ALGORITHM, digest]
      .map((segment) => encodeURIComponent(segment))
      .join("/"),
  );
}

function decodeHex(value, field, lineNumber, maxBytes) {
  if (value === "-") return new Uint8Array();
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
    fail(`line ${lineNumber}: ${field} is not canonical lowercase hexadecimal`);
  }
  const decodedBytes = value.length / 2;
  if (decodedBytes > maxBytes) {
    fail(`line ${lineNumber}: ${field} exceeds ${maxBytes} decoded bytes`);
  }
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function isUnescapedByte(byte) {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    [0x2d, 0x5f, 0x2e, 0x21, 0x7e, 0x2a, 0x27, 0x28, 0x29].includes(byte)
  );
}

function isCanonicalComponent(segment) {
  const source = encoder.encode(segment);
  const decoded = [];
  for (let offset = 0; offset < source.byteLength; ) {
    const byte = source[offset];
    if (isUnescapedByte(byte)) {
      decoded.push(byte);
      offset += 1;
      continue;
    }
    if (
      byte !== 0x25 ||
      offset + 2 >= source.byteLength ||
      !/^[0-9A-F]{2}$/u.test(String.fromCharCode(source[offset + 1], source[offset + 2]))
    ) {
      return false;
    }
    const decodedByte = Number.parseInt(
      String.fromCharCode(source[offset + 1], source[offset + 2]),
      16,
    );
    if (isUnescapedByte(decodedByte)) return false;
    decoded.push(decodedByte);
    offset += 3;
  }
  try {
    fatalDecoder.decode(Uint8Array.from(decoded));
    return decoded.length > 0;
  } catch {
    return false;
  }
}

function isCanonicalOutput(output) {
  let text;
  try {
    text = fatalDecoder.decode(output);
  } catch {
    return false;
  }
  const segments = text.split("/");
  return (
    segments.length === 9 &&
    segments[0] === VERSION &&
    segments.slice(1, 7).every(isCanonicalComponent) &&
    segments[7] === ALGORITHM &&
    /^[0-9a-f]{64}$/u.test(segments[8])
  );
}

function parseFrame(source) {
  if (Buffer.byteLength(source, "utf8") > FRAME_BYTES) fail("residency-key frame too large");
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
    if (columns.length !== 11) fail(`line ${lineNumber}: expected 11 columns`);
    const [
      caseId,
      scopeHex,
      accessHex,
      confidentialityHex,
      encryptionHex,
      retentionHex,
      erasureHex,
      digestHex,
      expected,
      outputHex,
      errorCode,
    ] = columns;

    if (Buffer.byteLength(caseId, "ascii") > CASE_ID_BYTES) {
      fail(`line ${lineNumber}: case_id too long`);
    }
    if (!/^[a-z][a-z0-9_]*$/u.test(caseId)) fail(`line ${lineNumber}: invalid case_id`);
    if (caseIds.has(caseId)) fail(`line ${lineNumber}: duplicate case_id`);
    caseIds.add(caseId);

    const testCase = {
      caseId,
      scope: decodeHex(scopeHex, "scope_hex", lineNumber, FIELD_BYTES),
      access: decodeHex(accessHex, "access_hex", lineNumber, FIELD_BYTES),
      confidentiality: decodeHex(
        confidentialityHex,
        "confidentiality_hex",
        lineNumber,
        FIELD_BYTES,
      ),
      encryption: decodeHex(encryptionHex, "encryption_hex", lineNumber, FIELD_BYTES),
      retention: decodeHex(retentionHex, "retention_hex", lineNumber, FIELD_BYTES),
      erasure: decodeHex(erasureHex, "erasure_hex", lineNumber, FIELD_BYTES),
      digest: decodeHex(digestHex, "digest_hex", lineNumber, FIELD_BYTES),
    };

    if (expected === "ok") {
      if (errorCode !== "-") fail(`line ${lineNumber}: success contains an error code`);
      const output = decodeHex(outputHex, "output_hex", lineNumber, OUTPUT_BYTES);
      if (!isCanonicalOutput(output)) fail(`line ${lineNumber}: invalid output shape`);
      cases.push({ ...testCase, expected: { kind: "ok", output } });
      continue;
    }

    if (expected !== "error") fail(`line ${lineNumber}: invalid expected outcome`);
    if (outputHex !== "-") fail(`line ${lineNumber}: error contains output bytes`);
    if (!ERROR_CODES.has(errorCode)) fail(`line ${lineNumber}: unknown error code`);
    cases.push({ ...testCase, expected: { kind: "error", errorCode } });
  }

  if (cases.length === 0) fail("residency-key frame contains no cases");
  return cases;
}

function execute(testCase) {
  try {
    return { kind: "ok", output: serializeResidencyKey(testCase) };
  } catch (error) {
    if (error instanceof ResidencyKeyError) return { kind: "error", errorCode: error.code };
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

export async function verifyResidencyKeyReference(fixtureUrl) {
  const source = await readFile(fixtureUrl, "utf8");
  const cases = parseFrame(source);
  verifyCases(cases);

  const firstRow = source
    .split("\n")
    .slice(3)
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (firstRow === undefined) fail("residency-key fixture contains no reusable case row");

  assertRejected(
    "unknown protocol",
    source.replace("residency-key.v1", "unknown.v1"),
    "expected header",
  );
  assertRejected(
    "duplicate identity",
    `${source.endsWith("\n") ? source : `${source}\n`}${firstRow}\n`,
    "duplicate case_id",
  );
  assertRejected(
    "invalid hexadecimal",
    source.replace(/\|[0-9a-f]+\|/u, "|0A|"),
    "canonical lowercase hexadecimal",
  );

  const unknownError = source.replace(
    /(\|error\|-\|)ELIOTR_RESIDENCY_KEY_[A-Z_]+/u,
    "$1ELIOTR_UNKNOWN",
  );
  if (unknownError === source) fail("residency-key fixture must contain one negative case");
  assertRejected("unknown error", unknownError, "unknown error code");

  const invalidOutput = source.replace(
    /(\|ok\|)[0-9a-f]+\|-/u,
    (_match, prefix) => `${prefix}61|-`,
  );
  if (invalidOutput === source) fail("residency-key fixture must contain one success case");
  assertRejected("invalid output shape", invalidOutput, "invalid output shape");

  globalThis.console.log(
    `Residency key vectors: PASS (${cases.length} bounded cross-runtime cases).`,
  );
}
