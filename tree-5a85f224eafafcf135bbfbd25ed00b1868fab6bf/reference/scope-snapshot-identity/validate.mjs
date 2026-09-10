import {
  CODES,
  IDENTIFIER_MAX_UTF16,
  ID_BYTES,
  ID_HEX_CHARS,
  ID_PREFIX,
  INPUT_MAX_BYTES,
  MEMBERS_MAX,
  OUTPUT_MAX_BYTES,
  PARTICIPANTS_MAX,
  PROTOCOL,
  SCOPE_ATOMS_MAX,
  SCOPE_DEPTH_MAX,
  SELECTED_SOURCES_MAX,
  STRING_MAX_BYTES,
  encoder,
  fatalDecoder,
} from "./constants.mjs";
import { canonicalJson, entriesOf, fromValue, lookup, raise, sha256HexText } from "./canonical.mjs";
import { FrameParser } from "./frame.mjs";

export function checkIdentifier(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > IDENTIFIER_MAX_UTF16) {
    raise(CODES.identifier);
  }
}

export function checkDigest(text) {
  if (typeof text !== "string" || !/^[0-9a-f]{64}$/u.test(text)) raise(CODES.digest);
}

export function checkSnapshotId(text) {
  if (
    typeof text !== "string" ||
    text.length !== ID_BYTES ||
    !text.startsWith(ID_PREFIX) ||
    !/^[0-9a-f]{48}$/u.test(text.slice(ID_PREFIX.length))
  ) {
    raise(CODES.identifier);
  }
}

export function checkTimestamp(text) {
  if (typeof text !== "string" || !parseTimestamp(text)) raise(CODES.timestamp);
}

export function parseTimestamp(text) {
  const bytes = encoder.encode(text);
  // The decoded-string ceiling is the only length bound: the admitted Zod
  // `datetime({ offset: true })` schema places no cap on the fractional run.
  if (bytes.byteLength < 20 || bytes.byteLength > STRING_MAX_BYTES) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u.exec(text);
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

export function checkExpression(value) {
  const members = entriesOf(value);
  if (members === null) raise(CODES.expression);
  const metrics = { depth: 0, atoms: 0, selected: 0 };
  checkExpressionMembers(value, 1, metrics);
  if (metrics.depth > SCOPE_DEPTH_MAX || metrics.atoms > SCOPE_ATOMS_MAX || metrics.selected > SELECTED_SOURCES_MAX) {
    raise(CODES.memberLimit);
  }
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
  // The derive material excludes the derived keys: caller-supplied `snapshot_id`
  // or `digest` members fail closed instead of being silently stripped.
  if (lookup(members, "snapshot_id") !== undefined || lookup(members, "digest") !== undefined) {
    raise(CODES.unknownField);
  }
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
