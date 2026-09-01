import { verifyCanonicalBodyReference } from "../crates/eliotr-test-vectors/reference/canonical-body.mjs";
import { verifyResidencyKeyReference } from "../crates/eliotr-test-vectors/reference/residency-key.mjs";
import { verifyStableIdReference } from "../crates/eliotr-test-vectors/reference/stable-id.mjs";
import { TextDecoder } from "node:util";
import { readFile } from "node:fs/promises";

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

const source = await readFile(fixtureUrl, "utf8");
const cases = parseFrame(source);
verifyCases(cases);

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
