import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TextDecoder, TextEncoder } from "node:util";

const PROTOCOL_HEADER = "# protocol=eliotr.test-vectors.canonical-body.v1";
const GENERATION_HEADER = "# schema_generation=1";
const COLUMNS_HEADER =
  "# columns=case_id|operation|input_hex|expected|output_hex|error_code";
const FRAME_BYTES = 1024 * 1024;
const FRAME_CASES = 4096;
const CASE_ID_BYTES = 128;
const VECTOR_PAYLOAD_BYTES = 256 * 1024;

const JSON_INPUT_BYTES = 128 * 1024;
const JSON_OUTPUT_BYTES = 96 * 1024;
const JSON_STRING_BYTES = 32 * 1024;
const JSON_DEPTH = 64;
const JSON_MEMBERS = 128;
const JSON_ITEMS = 256;
const JSON_NODES = 1024;
const JSON_INTEGER = 9_007_199_254_740_991;

const GENERATION_PREFIX = "g1_";
const GENERATION_BYTES = 67;

const CODES = Object.freeze({
  jsonInputTooLarge: "ELIOTR_JSON_INPUT_TOO_LARGE",
  jsonInvalidUtf8: "ELIOTR_JSON_INVALID_UTF8",
  jsonSyntax: "ELIOTR_JSON_SYNTAX",
  jsonDuplicateKey: "ELIOTR_JSON_DUPLICATE_KEY",
  jsonDepthLimit: "ELIOTR_JSON_DEPTH_LIMIT",
  jsonMemberLimit: "ELIOTR_JSON_MEMBER_LIMIT",
  jsonItemLimit: "ELIOTR_JSON_ITEM_LIMIT",
  jsonNodeLimit: "ELIOTR_JSON_NODE_LIMIT",
  jsonStringTooLarge: "ELIOTR_JSON_STRING_TOO_LARGE",
  jsonNumber: "ELIOTR_JSON_NUMBER",
  jsonUnicode: "ELIOTR_JSON_UNICODE",
  jsonOutputTooLarge: "ELIOTR_JSON_OUTPUT_TOO_LARGE",
  generationLength: "ELIOTR_GENERATION_LENGTH",
  generationPrefix: "ELIOTR_GENERATION_PREFIX",
  generationAlphabet: "ELIOTR_GENERATION_ALPHABET",
});

const JSON_CODES = new Set([
  CODES.jsonInputTooLarge,
  CODES.jsonInvalidUtf8,
  CODES.jsonSyntax,
  CODES.jsonDuplicateKey,
  CODES.jsonDepthLimit,
  CODES.jsonMemberLimit,
  CODES.jsonItemLimit,
  CODES.jsonNodeLimit,
  CODES.jsonStringTooLarge,
  CODES.jsonNumber,
  CODES.jsonUnicode,
  CODES.jsonOutputTooLarge,
]);
const GENERATION_CODES = new Set([
  CODES.generationLength,
  CODES.generationPrefix,
  CODES.generationAlphabet,
]);
const ALL_CODES = new Set([...JSON_CODES, ...GENERATION_CODES]);
const OPERATIONS = new Set(["canonicalize_json", "sha256", "validate_generation"]);
const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

class CanonicalBodyError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(message) {
  throw new Error(message);
}

function byteLength(value) {
  return encoder.encode(value).byteLength;
}

function compareUtf16CodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

class JsonParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
    this.nodes = 0;
  }

  parse() {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) this.raise(CODES.jsonSyntax);
    return value;
  }

  parseValue(depth) {
    if (this.nodes === JSON_NODES) this.raise(CODES.jsonNodeLimit);
    this.nodes += 1;
    const code = this.peekCode();
    if (code === 0x6e) return this.parseLiteral("null", { kind: "null" });
    if (code === 0x74) return this.parseLiteral("true", { kind: "boolean", value: true });
    if (code === 0x66) return this.parseLiteral("false", { kind: "boolean", value: false });
    if (code === 0x22) return { kind: "string", value: this.parseString() };
    if (code === 0x5b) return this.parseArray(depth);
    if (code === 0x7b) return this.parseObject(depth);
    if (code === 0x2d || (code >= 0x30 && code <= 0x39)) return this.parseInteger();
    this.raise(CODES.jsonSyntax);
  }

  parseLiteral(literal, value) {
    if (this.source.slice(this.index, this.index + literal.length) !== literal) {
      this.raise(CODES.jsonSyntax);
    }
    this.index += literal.length;
    return value;
  }

  parseArray(depth) {
    this.enterContainer(depth);
    this.index += 1;
    this.skipWhitespace();
    const values = [];
    if (this.consume("]")) return { kind: "array", values };
    for (;;) {
      if (values.length === JSON_ITEMS) this.raise(CODES.jsonItemLimit);
      values.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.consume("]")) break;
      if (!this.consume(",")) this.raise(CODES.jsonSyntax);
      this.skipWhitespace();
    }
    return { kind: "array", values };
  }

  parseObject(depth) {
    this.enterContainer(depth);
    this.index += 1;
    this.skipWhitespace();
    const members = [];
    const keys = new Set();
    if (this.consume("}")) return { kind: "object", members };
    for (;;) {
      if (members.length === JSON_MEMBERS) this.raise(CODES.jsonMemberLimit);
      if (this.peekCode() !== 0x22) this.raise(CODES.jsonSyntax);
      const key = this.parseString();
      if (keys.has(key)) this.raise(CODES.jsonDuplicateKey);
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(":")) this.raise(CODES.jsonSyntax);
      this.skipWhitespace();
      members.push([key, this.parseValue(depth + 1)]);
      this.skipWhitespace();
      if (this.consume("}")) break;
      if (!this.consume(",")) this.raise(CODES.jsonSyntax);
      this.skipWhitespace();
    }
    members.sort((left, right) => compareUtf16CodeUnits(left[0], right[0]));
    return { kind: "object", members };
  }

  enterContainer(depth) {
    if (depth >= JSON_DEPTH) this.raise(CODES.jsonDepthLimit);
  }

  parseInteger() {
    const start = this.index;
    const negative = this.consume("-");
    const first = this.peekCode();
    if (first === 0x30) {
      this.index += 1;
      const next = this.peekCode();
      if (next >= 0x30 && next <= 0x39) this.raise(CODES.jsonNumber);
    } else if (first >= 0x31 && first <= 0x39) {
      this.index += 1;
      while (this.peekCode() >= 0x30 && this.peekCode() <= 0x39) this.index += 1;
    } else {
      this.raise(CODES.jsonNumber);
    }
    if ([0x2e, 0x45, 0x65].includes(this.peekCode())) this.raise(CODES.jsonNumber);
    const token = this.source.slice(start, this.index);
    const value = Number(token);
    if (
      token === "-0" ||
      !Number.isSafeInteger(value) ||
      Math.abs(value) > JSON_INTEGER ||
      (negative && value === 0)
    ) {
      this.raise(CODES.jsonNumber);
    }
    return { kind: "integer", value };
  }

  parseString() {
    if (!this.consume("\"")) this.raise(CODES.jsonSyntax);
    const parts = [];
    let bytes = 0;
    const append = (fragment) => {
      bytes += byteLength(fragment);
      if (bytes > JSON_STRING_BYTES) this.raise(CODES.jsonStringTooLarge);
      parts.push(fragment);
    };

    for (;;) {
      if (this.index >= this.source.length) this.raise(CODES.jsonSyntax);
      const code = this.peekCode();
      if (code === 0x22) {
        this.index += 1;
        return parts.join("");
      }
      if (code === 0x5c) {
        this.index += 1;
        append(this.parseEscape());
        continue;
      }
      if (code < 0x20) this.raise(CODES.jsonSyntax);
      const point = this.source.codePointAt(this.index);
      if (point === undefined) this.raise(CODES.jsonUnicode);
      const fragment = String.fromCodePoint(point);
      this.index += fragment.length;
      append(fragment);
    }
  }

  parseEscape() {
    if (this.index >= this.source.length) this.raise(CODES.jsonSyntax);
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
    if (escape !== "u") this.raise(CODES.jsonSyntax);

    const first = this.parseHexQuad();
    let point = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      if (this.source.slice(this.index, this.index + 2) !== "\\u") {
        this.raise(CODES.jsonUnicode);
      }
      this.index += 2;
      const second = this.parseHexQuad();
      if (second < 0xdc00 || second > 0xdfff) this.raise(CODES.jsonUnicode);
      point = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      this.raise(CODES.jsonUnicode);
    }
    return String.fromCodePoint(point);
  }

  parseHexQuad() {
    const token = this.source.slice(this.index, this.index + 4);
    if (!/^[0-9A-Fa-f]{4}$/u.test(token)) this.raise(CODES.jsonUnicode);
    this.index += 4;
    return Number.parseInt(token, 16);
  }

  skipWhitespace() {
    while ([0x20, 0x0a, 0x0d, 0x09].includes(this.peekCode())) this.index += 1;
  }

  consume(character) {
    if (this.source[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  peekCode() {
    if (this.index >= this.source.length) return -1;
    return this.source.charCodeAt(this.index);
  }

  raise(code) {
    throw new CanonicalBodyError(code);
  }
}

class JsonWriter {
  constructor() {
    this.parts = [];
    this.bytes = 0;
  }

  finish() {
    return encoder.encode(this.parts.join(""));
  }

  push(text) {
    this.bytes += byteLength(text);
    if (this.bytes > JSON_OUTPUT_BYTES) throw new CanonicalBodyError(CODES.jsonOutputTooLarge);
    this.parts.push(text);
  }

  write(value) {
    switch (value.kind) {
      case "null":
        this.push("null");
        return;
      case "boolean":
        this.push(value.value ? "true" : "false");
        return;
      case "integer":
        this.push(String(value.value));
        return;
      case "string":
        this.writeString(value.value);
        return;
      case "array":
        this.push("[");
        value.values.forEach((item, index) => {
          if (index > 0) this.push(",");
          this.write(item);
        });
        this.push("]");
        return;
      case "object":
        this.push("{");
        value.members.forEach(([key, member], index) => {
          if (index > 0) this.push(",");
          this.writeString(key);
          this.push(":");
          this.write(member);
        });
        this.push("}");
        return;
      default:
        fail("unknown internal JSON value kind");
    }
  }

  writeString(value) {
    this.push('"');
    for (const character of value) {
      const point = character.codePointAt(0);
      if (character === '"') this.push('\\"');
      else if (character === "\\") this.push("\\\\");
      else if (point === 0x08) this.push("\\b");
      else if (point === 0x09) this.push("\\t");
      else if (point === 0x0a) this.push("\\n");
      else if (point === 0x0c) this.push("\\f");
      else if (point === 0x0d) this.push("\\r");
      else if (point !== undefined && point < 0x20) {
        this.push(`\\u00${point.toString(16).padStart(2, "0")}`);
      } else this.push(character);
    }
    this.push('"');
  }
}

function canonicalizeJson(input) {
  if (input.byteLength > JSON_INPUT_BYTES) {
    throw new CanonicalBodyError(CODES.jsonInputTooLarge);
  }
  let source;
  try {
    source = fatalDecoder.decode(input);
  } catch {
    throw new CanonicalBodyError(CODES.jsonInvalidUtf8);
  }
  const value = new JsonParser(source).parse();
  const writer = new JsonWriter();
  writer.write(value);
  return writer.finish();
}

function validateGeneration(input) {
  if (input.byteLength !== GENERATION_BYTES) {
    throw new CanonicalBodyError(CODES.generationLength);
  }
  const source = Buffer.from(input).toString("ascii");
  if (!source.startsWith(GENERATION_PREFIX)) {
    throw new CanonicalBodyError(CODES.generationPrefix);
  }
  if (!/^[0-9a-f]{64}$/u.test(source.slice(GENERATION_PREFIX.length))) {
    throw new CanonicalBodyError(CODES.generationAlphabet);
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
  if (Buffer.byteLength(source, "utf8") > FRAME_BYTES) fail("canonical-body frame too large");
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const expectedHeaders = [PROTOCOL_HEADER, GENERATION_HEADER, COLUMNS_HEADER];
  expectedHeaders.forEach((expected, index) => {
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
      if (operation === "sha256" && output.byteLength !== 32) fail(`line ${lineNumber}: bad digest shape`);
      if (operation === "validate_generation" && output.byteLength !== GENERATION_BYTES) {
        fail(`line ${lineNumber}: bad generation shape`);
      }
      cases.push({ caseId, operation, input, expected: { kind: "ok", output } });
      continue;
    }
    if (expected !== "error") fail(`line ${lineNumber}: invalid expected outcome`);
    if (outputHex !== "-") fail(`line ${lineNumber}: error contains output bytes`);
    if (!ALL_CODES.has(errorCode)) fail(`line ${lineNumber}: unknown error code`);
    if (operation === "canonicalize_json" && !JSON_CODES.has(errorCode)) {
      fail(`line ${lineNumber}: incompatible JSON error`);
    }
    if (operation === "validate_generation" && !GENERATION_CODES.has(errorCode)) {
      fail(`line ${lineNumber}: incompatible generation error`);
    }
    if (operation === "sha256") fail(`line ${lineNumber}: SHA-256 cannot expect an error`);
    cases.push({ caseId, operation, input, expected: { kind: "error", errorCode } });
  }
  if (cases.length === 0) fail("canonical-body frame contains no cases");
  return cases;
}

function execute(testCase) {
  try {
    if (testCase.operation === "canonicalize_json") {
      return { kind: "ok", output: canonicalizeJson(testCase.input) };
    }
    if (testCase.operation === "sha256") {
      return {
        kind: "ok",
        output: Uint8Array.from(createHash("sha256").update(testCase.input).digest()),
      };
    }
    return { kind: "ok", output: validateGeneration(testCase.input) };
  } catch (error) {
    if (error instanceof CanonicalBodyError) return { kind: "error", errorCode: error.code };
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

export async function verifyCanonicalBodyReference(
  fixtureUrl,
  label = "Canonical body",
) {
  const source = await readFile(fixtureUrl, "utf8");
  const cases = parseFrame(source);
  verifyCases(cases);

  const firstRow = source
    .split("\n")
    .slice(3)
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (firstRow === undefined) fail(`${label}: fixture contains no reusable case row`);

  assertRejected(
    "unknown protocol",
    source.replace("canonical-body.v1", "unknown.v1"),
    "expected header",
  );
  assertRejected(
    "duplicate identity",
    `${source.endsWith("\n") ? source : `${source}\n`}${firstRow}\n`,
    "duplicate case_id",
  );
  assertRejected(
    "unknown operation",
    source.replace(
      /\|(canonicalize_json|sha256|validate_generation)\|/u,
      "|unknown_operation|",
    ),
    "invalid operation",
  );

  const unknownError = source.replace(
    /(\|error\|-\|)ELIOTR_[A-Z0-9_]+/u,
    "$1ELIOTR_UNKNOWN",
  );
  if (unknownError === source) fail(`${label}: fixture must contain one negative case`);
  assertRejected("unknown error", unknownError, "unknown error code");

  globalThis.console.log(
    `${label} vectors: PASS (${cases.length} bounded cross-runtime cases).`,
  );
}
