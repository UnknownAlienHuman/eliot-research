import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TextDecoder, TextEncoder } from "node:util";

const PROTOCOL_HEADER = "# protocol=eliotr.test-vectors.owner-token.v1";
const GENERATION_HEADER = "# schema_generation=1";
const COLUMNS_HEADER =
  "# columns=case_id|operation|input_hex|expected|output_hex|error_code";

const FRAME_BYTES = 1024 * 1024;
const FRAME_CASES = 4096;
const CASE_ID_BYTES = 128;
const VECTOR_PAYLOAD_BYTES = 256 * 1024;

const PREIMAGE_BYTES = 2048;
const SCHEMA = "eliotr.source-owner.initial.v1";
const OWNER_SYSTEM_ID = "eliotr";
const REVISION = 1;
const STATUS = "ACTIVE";
const TOKEN_PREFIX = "owner-";
const TOKEN_BYTES = 70;
const ID_MIN_BYTES = 1;
const ID_MAX_BYTES = 256;

const CODES = Object.freeze({
  inputTooLarge: "ELIOTR_OWNER_TOKEN_INPUT_TOO_LARGE",
  utf8: "ELIOTR_OWNER_TOKEN_UTF8",
  syntax: "ELIOTR_OWNER_TOKEN_SYNTAX",
  unicode: "ELIOTR_OWNER_TOKEN_UNICODE",
  shape: "ELIOTR_OWNER_TOKEN_SHAPE",
  schema: "ELIOTR_OWNER_TOKEN_SCHEMA",
  namespace: "ELIOTR_OWNER_TOKEN_NAMESPACE",
  incarnation: "ELIOTR_OWNER_TOKEN_INCARNATION",
  owner: "ELIOTR_OWNER_TOKEN_OWNER",
  revision: "ELIOTR_OWNER_TOKEN_REVISION",
  state: "ELIOTR_OWNER_TOKEN_STATE",
  length: "ELIOTR_OWNER_TOKEN_LENGTH",
  prefix: "ELIOTR_OWNER_TOKEN_PREFIX",
  alphabet: "ELIOTR_OWNER_TOKEN_ALPHABET",
});
const DERIVE_CODES = new Set([
  CODES.inputTooLarge,
  CODES.utf8,
  CODES.syntax,
  CODES.unicode,
  CODES.shape,
  CODES.schema,
  CODES.namespace,
  CODES.incarnation,
  CODES.owner,
  CODES.revision,
  CODES.state,
]);
const VALIDATE_CODES = new Set([
  CODES.utf8,
  CODES.length,
  CODES.prefix,
  CODES.alphabet,
]);
const ALL_CODES = new Set([...DERIVE_CODES, ...VALIDATE_CODES]);
const OPERATIONS = new Set(["derive_owner_token", "validate_owner_token"]);
const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

class OwnerTokenError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(message) {
  throw new Error(message);
}

function raise(code) {
  throw new OwnerTokenError(code);
}

function decodeUtf8(input) {
  try {
    return fatalDecoder.decode(input);
  } catch {
    raise(CODES.utf8);
  }
}

function splitTransportLines(source) {
  return source
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function isAsciiAlphanumeric(code) {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

function checkIdentifier(text, code) {
  const bytes = encoder.encode(text).byteLength;
  if (bytes < ID_MIN_BYTES || bytes > ID_MAX_BYTES) raise(code);
  const first = text.charCodeAt(0);
  if (!isAsciiAlphanumeric(first)) raise(code);
  for (let index = 1; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (
      !isAsciiAlphanumeric(unit) &&
      unit !== 0x2e &&
      unit !== 0x5f &&
      unit !== 0x3a &&
      unit !== 0x40 &&
      unit !== 0x2f &&
      unit !== 0x2d
    ) {
      raise(code);
    }
  }
}

class TupleParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  parse() {
    this.skipWhitespace();
    if (!this.consume("[")) raise(CODES.syntax);
    this.skipWhitespace();
    if (this.peek() === "]") raise(CODES.shape);
    const schema = this.parseString();
    this.skipWhitespace();
    this.consumeCommaOrEnd();
    this.skipWhitespace();
    const namespace = this.parseStringOrShape();
    this.skipWhitespace();
    this.consumeCommaOrEnd();
    this.skipWhitespace();
    const owner = this.parseStringOrShape();
    this.skipWhitespace();
    this.consumeCommaOrEnd();
    this.skipWhitespace();
    const incarnation = this.parseStringOrShape();
    this.skipWhitespace();
    this.consumeCommaOrEnd();
    this.skipWhitespace();
    const revision = this.parseRevision();
    this.skipWhitespace();
    this.consumeCommaOrEnd();
    this.skipWhitespace();
    const status = this.parseStringOrShape();
    this.skipWhitespace();
    if (this.consume(",")) raise(CODES.shape);
    if (!this.consume("]")) raise(CODES.syntax);
    this.skipWhitespace();
    if (this.index !== this.source.length) raise(CODES.syntax);
    return { schema, namespace, owner, incarnation, revision, status };
  }

  parseStringOrShape() {
    if (this.peek() !== '"') raise(CODES.shape);
    return this.parseString();
  }

  parseRevision() {
    const start = this.index;
    const first = this.peek();
    if (first !== "-" && !(first >= "0" && first <= "9")) raise(CODES.shape);
    const negative = this.consume("-");
    if (this.peek() === "0") {
      this.index += 1;
      const next = this.peek();
      if (next >= "0" && next <= "9") raise(CODES.syntax);
    } else if (this.peek() >= "1" && this.peek() <= "9") {
      this.index += 1;
      while (this.peek() >= "0" && this.peek() <= "9") this.index += 1;
    } else {
      raise(CODES.syntax);
    }
    if ([".", "e", "E"].includes(this.peek())) raise(CODES.syntax);
    const token = this.source.slice(start, this.index);
    const value = Number(token);
    if (!Number.isSafeInteger(value)) raise(CODES.syntax);
    if (negative && value === 0) raise(CODES.syntax);
    return value;
  }

  parseString() {
    if (!this.consume('"')) raise(CODES.syntax);
    let output = "";
    for (;;) {
      if (this.index >= this.source.length) raise(CODES.syntax);
      const code = this.source.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        return output;
      }
      if (code === 0x5c) {
        this.index += 1;
        output += this.parseEscape();
        continue;
      }
      if (code < 0x20) raise(CODES.syntax);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = this.source.charCodeAt(this.index + 1);
        if (!(low >= 0xdc00 && low <= 0xdfff)) raise(CODES.unicode);
        output += this.source.slice(this.index, this.index + 2);
        this.index += 2;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) raise(CODES.unicode);
      output += this.source[this.index];
      this.index += 1;
    }
  }

  parseEscape() {
    if (this.index >= this.source.length) raise(CODES.syntax);
    const escape = this.source[this.index];
    this.index += 1;
    const simple = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    if (Object.hasOwn(simple, escape)) return simple[escape];
    if (escape !== "u") raise(CODES.syntax);
    const first = this.parseHexQuad();
    if (first >= 0xd800 && first <= 0xdbff) {
      if (this.source.slice(this.index, this.index + 2) !== "\\u") {
        raise(CODES.unicode);
      }
      this.index += 2;
      const second = this.parseHexQuad();
      if (second < 0xdc00 || second > 0xdfff) raise(CODES.unicode);
      return String.fromCodePoint(
        0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00),
      );
    }
    if (first >= 0xdc00 && first <= 0xdfff) raise(CODES.unicode);
    return String.fromCodePoint(first);
  }

  parseHexQuad() {
    const token = this.source.slice(this.index, this.index + 4);
    if (!/^[0-9A-Fa-f]{4}$/u.test(token)) raise(CODES.unicode);
    this.index += 4;
    return Number.parseInt(token, 16);
  }

  consumeComma() {
    if (!this.consume(",")) raise(CODES.syntax);
  }

  consumeCommaOrEnd() {
    if (this.consume(",")) return;
    if (this.peek() === "]") raise(CODES.shape);
    raise(CODES.syntax);
  }

  skipWhitespace() {
    while ([" ", "\n", "\r", "\t"].includes(this.peek())) this.index += 1;
  }

  consume(character) {
    if (this.source[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  peek() {
    if (this.index >= this.source.length) return "";
    return this.source[this.index];
  }
}

function deriveOwnerToken(input) {
  if (input.byteLength > PREIMAGE_BYTES) raise(CODES.inputTooLarge);
  const source = decodeUtf8(input);
  const tuple = new TupleParser(source).parse();
  if (tuple.schema !== SCHEMA) raise(CODES.schema);
  checkIdentifier(tuple.namespace, CODES.namespace);
  if (tuple.owner !== OWNER_SYSTEM_ID) raise(CODES.owner);
  checkIdentifier(tuple.incarnation, CODES.incarnation);
  if (tuple.revision !== REVISION) raise(CODES.revision);
  if (tuple.status !== STATUS) raise(CODES.state);
  const canonical = encoder.encode(
    JSON.stringify([
      SCHEMA,
      tuple.namespace,
      OWNER_SYSTEM_ID,
      tuple.incarnation,
      REVISION,
      STATUS,
    ]),
  );
  const digest = createHash("sha256").update(canonical).digest("hex");
  return encoder.encode(`${TOKEN_PREFIX}${digest}`);
}

function validateOwnerToken(input) {
  if (input.byteLength !== TOKEN_BYTES) raise(CODES.length);
  const text = decodeUtf8(input);
  if (!text.startsWith(TOKEN_PREFIX)) raise(CODES.prefix);
  if (!/^[0-9a-f]{64}$/u.test(text.slice(TOKEN_PREFIX.length))) {
    raise(CODES.alphabet);
  }
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
  if (Buffer.byteLength(source, "utf8") > FRAME_BYTES) fail("owner-token frame too large");
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
        validateOwnerToken(output);
      } catch (error) {
        if (error instanceof OwnerTokenError) fail(`line ${lineNumber}: invalid output shape`);
        throw error;
      }
      if (operation === "validate_owner_token" && !equalBytes(output, input)) {
        fail(`line ${lineNumber}: invalid output shape`);
      }
      cases.push({ caseId, operation, input, expected: { kind: "ok", output } });
      continue;
    }

    if (expected !== "error") fail(`line ${lineNumber}: invalid expected outcome`);
    if (outputHex !== "-") fail(`line ${lineNumber}: error contains output bytes`);
    if (!ALL_CODES.has(errorCode)) fail(`line ${lineNumber}: unknown error code`);
    if (operation === "derive_owner_token" && !DERIVE_CODES.has(errorCode)) {
      fail(`line ${lineNumber}: incompatible derive error`);
    }
    if (operation === "validate_owner_token" && !VALIDATE_CODES.has(errorCode)) {
      fail(`line ${lineNumber}: incompatible validation error`);
    }
    cases.push({ caseId, operation, input, expected: { kind: "error", errorCode } });
  }

  if (cases.length === 0) fail("owner-token frame contains no cases");
  return cases;
}

function execute(testCase) {
  try {
    return {
      kind: "ok",
      output:
        testCase.operation === "derive_owner_token"
          ? deriveOwnerToken(testCase.input)
          : validateOwnerToken(testCase.input),
    };
  } catch (error) {
    if (error instanceof OwnerTokenError) return { kind: "error", errorCode: error.code };
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

export async function verifyOwnerTokenReference(
  fixtureUrl,
  label = "Owner token",
) {
  const raw = await readFile(fixtureUrl, "utf8");
  const source = splitTransportLines(raw).join("\n");
  const cases = parseFrame(source);
  verifyCases(cases);

  const crlfCases = parseFrame(source.replace(/\n/g, "\r\n"));
  if (crlfCases.length !== cases.length) {
    fail(`${label}: CRLF transport changed the case count`);
  }
  verifyCases(crlfCases);

  const rows = source
    .split("\n")
    .slice(3)
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const firstRow = rows[0];
  if (firstRow === undefined) fail(`${label}: fixture contains no reusable case row`);

  assertRejected(
    "unknown protocol",
    source.replace("owner-token.v1", "unknown.v1"),
    "expected header",
  );
  assertRejected(
    "wrong schema generation",
    source.replace("# schema_generation=1", "# schema_generation=2"),
    "expected header",
  );
  assertRejected(
    "duplicate identity",
    `${source.endsWith("\n") ? source : `${source}\n`}${firstRow}\n`,
    "duplicate case_id",
  );
  assertRejected(
    "prototype case identity",
    source.replace(firstRow, firstRow.replace(/^[^|]+/u, "__proto__")),
    "invalid case_id",
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
  incompatibleErrorColumns[5] =
    incompatibleErrorColumns[1] === "derive_owner_token"
      ? CODES.length
      : CODES.namespace;
  assertRejected(
    "incompatible error",
    source.replace(errorRow, incompatibleErrorColumns.join("|")),
    incompatibleErrorColumns[1] === "derive_owner_token"
      ? "incompatible derive error"
      : "incompatible validation error",
  );

  globalThis.console.log(
    `${label} vectors: PASS (${cases.length} bounded cross-runtime cases, CRLF transport PASS).`,
  );
}
