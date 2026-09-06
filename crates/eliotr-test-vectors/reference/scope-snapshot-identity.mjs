import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TextDecoder, TextEncoder } from "node:util";

export const PROTOCOL_HEADER = "# protocol=eliotr.test-vectors.scope-snapshot-identity.v1";
export const GENERATION_HEADER = "# schema_generation=1";
export const COLUMNS_HEADER =
  "# columns=case_id|operation|input_hex|expected|output_hex|error_code";

const FRAME_BYTES = 1024 * 1024;
const FRAME_CASES = 4096;
const CASE_ID_BYTES = 128;
const VECTOR_PAYLOAD_BYTES = 256 * 1024;

const PROTOCOL = "eliotr.scope-snapshot.v1";
const ID_PREFIX = "scope-";
const ID_HEX_CHARS = 48;
const ID_BYTES = ID_PREFIX.length + ID_HEX_CHARS;
const INPUT_MAX_BYTES = 2 * 1024 * 1024;
const OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
const STRING_MAX_BYTES = 4096;
const PARSER_DEPTH_MAX = 64;
const OBJECT_MEMBERS_MAX = 51_000;
const ARRAY_ITEMS_MAX = 50_000;
const NODES_MAX = 250_000;
const SAFE_INTEGER_MAX = 9_007_199_254_740_991;
const SCOPE_DEPTH_MAX = 32;
const SCOPE_ATOMS_MAX = 256;
const SELECTED_SOURCES_MAX = 1_000;
const MEMBERS_MAX = 50_000;
const PARTICIPANTS_MAX = 257;
const IDENTIFIER_MAX_UTF16 = 256;

const CODES = Object.freeze({
  inputTooLarge: "ELIOTR_SNAPSHOT_INPUT_TOO_LARGE",
  utf8: "ELIOTR_SNAPSHOT_UTF8",
  syntax: "ELIOTR_SNAPSHOT_SYNTAX",
  duplicateKey: "ELIOTR_SNAPSHOT_DUPLICATE_KEY",
  unicode: "ELIOTR_SNAPSHOT_UNICODE",
  number: "ELIOTR_SNAPSHOT_NUMBER",
  depthLimit: "ELIOTR_SNAPSHOT_DEPTH_LIMIT",
  memberLimit: "ELIOTR_SNAPSHOT_MEMBER_LIMIT",
  nodeLimit: "ELIOTR_SNAPSHOT_NODE_LIMIT",
  stringTooLarge: "ELIOTR_SNAPSHOT_STRING_TOO_LARGE",
  outputTooLarge: "ELIOTR_SNAPSHOT_OUTPUT_TOO_LARGE",
  shape: "ELIOTR_SNAPSHOT_SHAPE",
  missingField: "ELIOTR_SNAPSHOT_MISSING_FIELD",
  unknownField: "ELIOTR_SNAPSHOT_UNKNOWN_FIELD",
  identifier: "ELIOTR_SNAPSHOT_IDENTIFIER",
  digest: "ELIOTR_SNAPSHOT_DIGEST",
  revision: "ELIOTR_SNAPSHOT_REVISION",
  timestamp: "ELIOTR_SNAPSHOT_TIMESTAMP",
  expression: "ELIOTR_SNAPSHOT_EXPRESSION",
  idMismatch: "ELIOTR_SNAPSHOT_ID_MISMATCH",
  digestMismatch: "ELIOTR_SNAPSHOT_DIGEST_MISMATCH",
});
const DERIVE_CODES = new Set([
  CODES.inputTooLarge,
  CODES.utf8,
  CODES.syntax,
  CODES.duplicateKey,
  CODES.unicode,
  CODES.number,
  CODES.depthLimit,
  CODES.memberLimit,
  CODES.nodeLimit,
  CODES.stringTooLarge,
  CODES.outputTooLarge,
  CODES.shape,
  CODES.missingField,
  CODES.unknownField,
  CODES.identifier,
  CODES.digest,
  CODES.revision,
  CODES.timestamp,
  CODES.expression,
]);
const VERIFY_CODES = new Set([...DERIVE_CODES, CODES.idMismatch, CODES.digestMismatch]);
const ALL_CODES = new Set([...VERIFY_CODES]);
const OPERATIONS = new Set(["derive_snapshot_identity", "verify_snapshot_identity"]);
const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

class SnapshotError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(message) {
  throw new Error(message);
}

function raise(code) {
  throw new SnapshotError(code);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("scope canonical JSON requires safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort(compareText);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("scope canonical JSON contains a non-JSON value");
}

function sha256HexText(text) {
  return createHash("sha256").update(encoder.encode(text)).digest("hex");
}

class FrameParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
    this.nodes = 0;
  }

  parse() {
    this.skipWs();
    const value = this.parseValue(0);
    this.skipWs();
    if (this.index !== this.source.length) raise(CODES.syntax);
    return value;
  }

  parseValue(depth) {
    this.nodes += 1;
    if (this.nodes > NODES_MAX) raise(CODES.nodeLimit);
    const ch = this.peek();
    if (ch === "n") return this.literal("null", null);
    if (ch === "t") return this.literal("true", true);
    if (ch === "f") return this.literal("false", false);
    if (ch === '"') return this.parseString();
    if (ch === "[") return this.parseArray(depth);
    if (ch === "{") return this.parseObject(depth);
    if (ch === "-" || (ch >= "0" && ch <= "9")) return this.parseInteger();
    raise(CODES.syntax);
  }

  literal(token, value) {
    if (this.source.startsWith(token, this.index)) {
      this.index += token.length;
      return value;
    }
    raise(CODES.syntax);
  }

  parseArray(depth) {
    this.enter(depth);
    this.index += 1;
    this.skipWs();
    const values = [];
    if (this.eat("]")) return values;
    for (;;) {
      if (values.length >= ARRAY_ITEMS_MAX) raise(CODES.memberLimit);
      values.push(this.parseValue(depth + 1));
      this.skipWs();
      if (this.eat("]")) return values;
      if (!this.eat(",")) raise(CODES.syntax);
      this.skipWs();
    }
  }

  parseObject(depth) {
    this.enter(depth);
    this.index += 1;
    this.skipWs();
    const members = new Map();
    if (this.eat("}")) return members;
    for (;;) {
      if (members.size >= OBJECT_MEMBERS_MAX) raise(CODES.memberLimit);
      if (this.peek() !== '"') raise(CODES.syntax);
      const key = this.parseString();
      if (members.has(key)) raise(CODES.duplicateKey);
      this.skipWs();
      if (!this.eat(":")) raise(CODES.syntax);
      this.skipWs();
      members.set(key, this.parseValue(depth + 1));
      this.skipWs();
      if (this.eat("}")) return members;
      if (!this.eat(",")) raise(CODES.syntax);
      this.skipWs();
    }
  }

  enter(depth) {
    if (depth >= PARSER_DEPTH_MAX) raise(CODES.depthLimit);
  }

  parseInteger() {
    const start = this.index;
    let negative = false;
    if (this.eat("-")) negative = true;
    const digitsStart = this.index;
    if (this.peek() === "0") {
      this.index += 1;
      const next = this.peek();
      if (next >= "0" && next <= "9") raise(CODES.number);
    } else if (this.peek() >= "1" && this.peek() <= "9") {
      this.index += 1;
      while (this.peek() >= "0" && this.peek() <= "9") this.index += 1;
    } else {
      raise(CODES.number);
    }
    if ([".", "e", "E"].includes(this.peek())) raise(CODES.number);
    const token = this.source.slice(digitsStart, this.index);
    let magnitude = 0;
    for (const ch of token) {
      magnitude = magnitude * 10 + (ch.charCodeAt(0) - 0x30);
      if (magnitude > SAFE_INTEGER_MAX) raise(CODES.number);
    }
    if (negative && magnitude === 0) raise(CODES.number);
    void start;
    return negative ? -magnitude : magnitude;
  }

  parseString() {
    if (!this.eat('"')) raise(CODES.syntax);
    let out = "";
    for (;;) {
      if (this.index >= this.source.length) raise(CODES.syntax);
      const code = this.source.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        if (encoder.encode(out).byteLength > STRING_MAX_BYTES) raise(CODES.stringTooLarge);
        return out;
      }
      if (code === 0x5c) {
        this.index += 1;
        out += this.parseEscape();
        continue;
      }
      if (code < 0x20) raise(CODES.syntax);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = this.source.charCodeAt(this.index + 1);
        if (!(low >= 0xdc00 && low <= 0xdfff)) raise(CODES.unicode);
        out += this.source.slice(this.index, this.index + 2);
        this.index += 2;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) raise(CODES.unicode);
      out += this.source[this.index];
      this.index += 1;
    }
  }

  parseEscape() {
    if (this.index >= this.source.length) raise(CODES.syntax);
    const esc = this.source[this.index];
    this.index += 1;
    const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    if (Object.hasOwn(simple, esc)) return simple[esc];
    if (esc !== "u") raise(CODES.syntax);
    const first = this.hexQuad();
    if (first >= 0xd800 && first <= 0xdbff) {
      if (this.source.slice(this.index, this.index + 2) !== "\\u") raise(CODES.unicode);
      this.index += 2;
      const second = this.hexQuad();
      if (second < 0xdc00 || second > 0xdfff) raise(CODES.unicode);
      return String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00));
    }
    if (first >= 0xdc00 && first <= 0xdfff) raise(CODES.unicode);
    return String.fromCodePoint(first);
  }

  hexQuad() {
    const token = this.source.slice(this.index, this.index + 4);
    if (!/^[0-9A-Fa-f]{4}$/u.test(token)) raise(CODES.unicode);
    this.index += 4;
    return Number.parseInt(token, 16);
  }

  skipWs() {
    while ([" ", "\n", "\r", "\t"].includes(this.peek())) this.index += 1;
  }

  eat(ch) {
    if (this.source[this.index] !== ch) return false;
    this.index += 1;
    return true;
  }

  peek() {
    if (this.index >= this.source.length) return "";
    return this.source[this.index];
  }
}

function entriesOf(value) {
  if (value instanceof Map) return [...value.entries()];
  return null;
}

function toObject(members) {
  const out = {};
  for (const [key, value] of members) out[key] = fromValue(value);
  return out;
}

function fromValue(value) {
  if (value instanceof Map) return toObject([...value.entries()]);
  if (Array.isArray(value)) return value.map(fromValue);
  return value;
}

function checkIdentifier(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > IDENTIFIER_MAX_UTF16) {
    raise(CODES.identifier);
  }
}

function checkDigest(text) {
  if (typeof text !== "string" || !/^[0-9a-f]{64}$/u.test(text)) raise(CODES.digest);
}

function checkSnapshotId(text) {
  if (
    typeof text !== "string" ||
    text.length !== ID_BYTES ||
    !text.startsWith(ID_PREFIX) ||
    !/^[0-9a-f]{48}$/u.test(text.slice(ID_PREFIX.length))
  ) {
    raise(CODES.identifier);
  }
}

function checkTimestamp(text) {
  if (typeof text !== "string" || !parseTimestamp(text)) raise(CODES.timestamp);
}

function parseTimestamp(text) {
  const bytes = encoder.encode(text);
  if (bytes.byteLength < 20 || bytes.byteLength > 64) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(text);
  if (!match) return false;
  const [, , month, day, hour, minute, second, , zone] = match;
  if (Number(month) < 1 || Number(month) > 12) return false;
  if (Number(day) < 1 || Number(day) > 31) return false;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) return false;
  }
  return true;
}

function checkIdentifierRecord(value, maxMembers) {
  const members = entriesOf(value);
  if (members === null) raise(CODES.shape);
  if (members.length > maxMembers) raise(CODES.memberLimit);
  for (const [key, member] of members) {
    checkIdentifier(key);
    if (typeof member !== "string") raise(CODES.shape);
    checkIdentifier(member);
  }
}

function checkExpressionMembers(value, depth, metrics) {
  const members = entriesOf(value);
  if (members === null) raise(CODES.expression);
  metrics.depth = Math.max(metrics.depth, depth);
  if (depth > SCOPE_DEPTH_MAX) raise(CODES.expression);
  const kindEntry = members.find(([name]) => name === "kind");
  const kind = kindEntry === undefined ? undefined : kindEntry[1];
  if (typeof kind !== "string") raise(CODES.expression);
  const fieldText = (name) => {
    const entry = members.find(([key]) => key === name);
    if (entry === undefined || typeof entry[1] !== "string") raise(CODES.expression);
    try {
      checkIdentifier(entry[1]);
    } catch {
      raise(CODES.expression);
    }
  };
  switch (kind) {
    case "GLOBAL_LIBRARY": {
      if (members.length !== 1) raise(CODES.expression);
      break;
    }
    case "PROJECT": {
      if (members.length !== 2) raise(CODES.expression);
      fieldText("project_id");
      break;
    }
    case "SELECTED_SOURCES": {
      if (members.length !== 2) raise(CODES.expression);
      const ids = lookup(members, "source_ids");
      if (!Array.isArray(ids) || ids.length === 0) raise(CODES.expression);
      for (const id of ids) {
        if (typeof id !== "string") raise(CODES.expression);
        try {
          checkIdentifier(id);
        } catch {
          raise(CODES.expression);
        }
      }
      metrics.selected += ids.length;
      break;
    }
    case "SOURCE_CLASS": {
      if (members.length !== 2) raise(CODES.expression);
      fieldText("source_class");
      break;
    }
    case "TAG": {
      if (members.length !== 2) raise(CODES.expression);
      fieldText("tag");
      break;
    }
    case "UNION":
    case "INTERSECT":
    case "EXCEPT": {
      if (members.length !== 3) raise(CODES.expression);
      const left = lookup(members, "left");
      const right = lookup(members, "right");
      if (left === undefined || right === undefined) raise(CODES.expression);
      checkExpressionMembers(left, depth + 1, metrics);
      checkExpressionMembers(right, depth + 1, metrics);
      return;
    }
    default:
      raise(CODES.expression);
  }
  metrics.atoms += 1;
}

function checkExpression(value) {
  const members = entriesOf(value);
  if (members === null) raise(CODES.expression);
  const metrics = { depth: 0, atoms: 0, selected: 0 };
  checkExpressionMembers(value, 1, metrics);
  if (metrics.depth > SCOPE_DEPTH_MAX || metrics.atoms > SCOPE_ATOMS_MAX || metrics.selected > SELECTED_SOURCES_MAX) {
    raise(CODES.memberLimit);
  }
}

function lookup(members, key) {
  const entry = members.find(([name]) => name === key);
  return entry === undefined ? undefined : entry[1];
}

function checkMaterial(members) {
  const KNOWN = new Set([
    "revision", "resolved_scope_expression", "participant_generations",
    "member_source_revision_refs", "source_owner_generations", "policy_authority_ref",
    "disclosure_closure_digest", "purge_ledger_revision", "client_fence_ref",
    "created_at", "expires_at", "snapshot_id", "digest",
  ]);
  for (const [name] of members) {
    if (!KNOWN.has(name)) raise(CODES.unknownField);
  }
  const require = (key) => {
    const value = lookup(members, key);
    if (value === undefined) raise(CODES.missingField);
    return value;
  };
  const revision = require("revision");
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    raise(CODES.revision);
  }
  checkExpression(require("resolved_scope_expression"));
  checkIdentifierRecord(require("participant_generations"), PARTICIPANTS_MAX);
  const memberRefs = require("member_source_revision_refs");
  if (!Array.isArray(memberRefs)) raise(CODES.shape);
  if (memberRefs.length > MEMBERS_MAX) raise(CODES.memberLimit);
  for (const item of memberRefs) {
    if (typeof item !== "string") raise(CODES.shape);
    checkIdentifier(item);
  }
  checkIdentifierRecord(require("source_owner_generations"), MEMBERS_MAX);
  const policy = require("policy_authority_ref");
  if (typeof policy !== "string") raise(CODES.shape);
  checkIdentifier(policy);
  const disclosure = require("disclosure_closure_digest");
  if (typeof disclosure !== "string") raise(CODES.shape);
  checkDigest(disclosure);
  const purge = require("purge_ledger_revision");
  if (typeof purge !== "number" || !Number.isSafeInteger(purge) || purge < 0) {
    raise(CODES.revision);
  }
  const fence = lookup(members, "client_fence_ref");
  if (fence !== undefined) {
    if (typeof fence !== "string") raise(CODES.shape);
    checkIdentifier(fence);
  }
  const created = require("created_at");
  if (typeof created !== "string") raise(CODES.shape);
  checkTimestamp(created);
  const expires = require("expires_at");
  if (typeof expires !== "string") raise(CODES.shape);
  checkTimestamp(expires);
}

function emitFullSnapshot(members) {
  const material = {};
  for (const [name, value] of members) {
    if (name === "snapshot_id" || name === "digest") continue;
    material[name] = fromValue(value);
  }
  const identityPayload = { protocol: PROTOCOL, ...material };
  const identityJson = canonicalJson(identityPayload);
  const snapshotId = `${ID_PREFIX}${sha256HexText(identityJson).slice(0, ID_HEX_CHARS)}`;
  const digestJson = canonicalJson({ snapshot_id: snapshotId, ...identityPayload });
  const digest = sha256HexText(digestJson);
  return encoder.encode(canonicalJson({ ...material, snapshot_id: snapshotId, digest }));
}

export function deriveSnapshotIdentity(input) {
  if (input.byteLength > INPUT_MAX_BYTES) raise(CODES.inputTooLarge);
  let source;
  try {
    source = fatalDecoder.decode(input);
  } catch {
    raise(CODES.utf8);
  }
  const root = new FrameParser(source).parse();
  const members = entriesOf(root);
  if (members === null) raise(CODES.shape);
  checkMaterial(members);
  const output = emitFullSnapshot(members);
  if (output.byteLength > OUTPUT_MAX_BYTES) raise(CODES.outputTooLarge);
  return output;
}

export function verifySnapshotIdentity(input) {
  if (input.byteLength > INPUT_MAX_BYTES) raise(CODES.inputTooLarge);
  let source;
  try {
    source = fatalDecoder.decode(input);
  } catch {
    raise(CODES.utf8);
  }
  const root = new FrameParser(source).parse();
  const members = entriesOf(root);
  if (members === null) raise(CODES.shape);
  const declaredId = lookup(members, "snapshot_id");
  const declaredDigest = lookup(members, "digest");
  if (typeof declaredId !== "string" || typeof declaredDigest !== "string") {
    raise(CODES.missingField);
  }
  checkSnapshotId(declaredId);
  checkDigest(declaredDigest);
  checkMaterial(members);
  const expected = emitFullSnapshot(members);
  if (expected.byteLength > OUTPUT_MAX_BYTES) raise(CODES.outputTooLarge);
  const text = fatalDecoder.decode(expected);
  const parsed = JSON.parse(text);
  if (parsed.snapshot_id !== declaredId) raise(CODES.idMismatch);
  if (parsed.digest !== declaredDigest) raise(CODES.digestMismatch);
  return expected;
}

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
