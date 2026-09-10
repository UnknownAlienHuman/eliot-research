import { createHash } from "node:crypto";

import { encoder } from "./constants.mjs";

export class SnapshotError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function fail(message) {
  throw new Error(message);
}

export function raise(code) {
  throw new SnapshotError(code);
}

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value) {
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

export function sha256HexText(text) {
  return createHash("sha256").update(encoder.encode(text)).digest("hex");
}

export function entriesOf(value) {
  if (value instanceof Map) return [...value.entries()];
  return null;
}

export function toObject(members) {
  const out = {};
  for (const [key, value] of members) out[key] = fromValue(value);
  return out;
}

export function fromValue(value) {
  if (value instanceof Map) return toObject([...value.entries()]);
  if (Array.isArray(value)) return value.map(fromValue);
  return value;
}

export function lookup(members, key) {
  const entry = members.find(([name]) => name === key);
  return entry === undefined ? undefined : entry[1];
}

export function equalBytes(left, right) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
