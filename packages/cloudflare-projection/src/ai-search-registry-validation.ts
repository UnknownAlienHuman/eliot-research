import { aiSearchGenerationRegistryFailure } from "./ai-search-generation-registry-contract.js";

export type AiSearchRegistryFailure = (message: string, cause?: unknown) => never;

export function aiSearchRegistryInputFailure(message: string, cause?: unknown): never {
  return aiSearchGenerationRegistryFailure("AI_SEARCH_REGISTRY_INPUT_INVALID", message, cause === undefined ? {} : { cause });
}

export function aiSearchRegistryReadbackFailure(message: string, cause?: unknown): never {
  return aiSearchGenerationRegistryFailure("AI_SEARCH_REGISTRY_READBACK_INVALID", message, cause === undefined ? {} : { cause });
}

export function aiSearchRegistryWriteFailure(message: string, cause?: unknown): never {
  return aiSearchGenerationRegistryFailure("AI_SEARCH_REGISTRY_WRITE_FAILED", message, cause === undefined ? {} : { cause });
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export function isAiSearchRegistryIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

export function exactAiSearchRegistryObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
  fail: AiSearchRegistryFailure,
  checkAccessors = true,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (checkAccessors) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !("value" in descriptor)) fail(`${label} cannot contain accessors`);
    }
    if (!allowedKeys.has(key)) fail(`${label} contains unsupported field ${key}`);
  }
  return record;
}

export function aiSearchRegistryIdentifier(value: unknown, label: string, fail: AiSearchRegistryFailure): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(`${label} is not a bounded identifier`);
  return value;
}

export function aiSearchRegistryDigest(value: unknown, label: string, fail: AiSearchRegistryFailure, message = `${label} is not canonical SHA-256`): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(message);
  return value;
}

export function aiSearchRegistryInteger(value: unknown, label: string, minimum: number, fail: AiSearchRegistryFailure, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(message);
  return value;
}
