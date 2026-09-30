import { VersionedRefSchema, type ProjectClientGrant, type VersionedRef } from "@eliotr/contracts";
import {
  ExternalAgentTaskError,
  ExternalAgentTaskStore,
  readExternalAgentTaskPayload,
  type ExternalAgentProgressInput,
  type ExternalAgentResultInput,
  type ExternalAgentTaskActor,
  type ExternalAgentUsage,
} from "@eliotr/cloudflare-workflows";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";

export const EXTERNAL_AGENT_TASK_TOOL_NAMES = Object.freeze([
  "eliotr_task_pull",
  "eliotr_task_progress",
  "eliotr_task_result",
  "eliotr_task_status",
] as const);
export type ExternalAgentTaskToolName = typeof EXTERNAL_AGENT_TASK_TOOL_NAMES[number];

export function isExternalAgentTaskToolName(name: string): name is ExternalAgentTaskToolName {
  return (EXTERNAL_AGENT_TASK_TOOL_NAMES as readonly string[]).includes(name);
}
function invalid(message: string): never {
  throw new ExternalAgentTaskError("EXTERNAL_AGENT_TASK_INPUT_INVALID", 400, message);
}
function corrupt(message: string): never {
  throw new ExternalAgentTaskError("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, message);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}
function serverObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) corrupt(`${label} is corrupt`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) corrupt(`${label} is corrupt`);
  return value as Record<string, unknown>;
}
function serverString(value: unknown, label: string): string {
  if (typeof value !== "string") corrupt(`${label} is corrupt`);
  return value;
}
function shape(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const expected = new Set([...required, ...optional]);
  if (Object.keys(value).some((field) => !expected.has(field)) ||
      required.some((field) => !Object.hasOwn(value, field))) {
    invalid(`${label} contains unknown or missing fields`);
  }
}
function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  shape(value, fields, [], label);
}
function refs(value: unknown): readonly VersionedRef[] {
  if (!Array.isArray(value) || value.length > 64) invalid("evidence_refs must contain at most 64 references");
  return Object.freeze(value.map((entry) => {
    const parsed = VersionedRefSchema.safeParse(entry);
    if (!parsed.success) invalid("evidence_refs contains an invalid versioned reference");
    return parsed.data;
  }));
}
function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some((entry) => typeof entry !== "string")) {
    invalid(`${label} must contain at most 32 strings`);
  }
  return Object.freeze([...value] as string[]);
}
function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(`${label} must be a string`);
  return value;
}
function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number") invalid(`${label} must be a number`);
  return value;
}
function usage(value: unknown): ExternalAgentUsage {
  const parsed = object(value, "result.usage");
  const allowed = ["accounting", "input_tokens", "output_tokens", "billed_usd"] as const;
  if (Object.keys(parsed).some((key) => !(allowed as readonly string[]).includes(key)) ||
      !Object.hasOwn(parsed, "accounting")) invalid("result.usage contains unknown or missing fields");
  const accounting = stringValue(parsed.accounting, "result.usage.accounting");
  if (accounting !== "SUBSCRIPTION" && accounting !== "API_METERED" && accounting !== "UNKNOWN") {
    invalid("result.usage.accounting is invalid");
  }
  return {
    accounting,
    ...(parsed.input_tokens === undefined ? {} : { input_tokens: numberValue(parsed.input_tokens, "input_tokens") }),
    ...(parsed.output_tokens === undefined ? {} : { output_tokens: numberValue(parsed.output_tokens, "output_tokens") }),
    ...(parsed.billed_usd === undefined ? {} : { billed_usd: numberValue(parsed.billed_usd, "billed_usd") }),
  };
}
function actor(context: AuthenticatedRequestContext, grant: ProjectClientGrant): ExternalAgentTaskActor {
  return { grant, principal_ref: context.principal_ref, credential_generation: context.credential_generation };
}

async function withPayload(env: Env, raw: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
  const task = raw.task;
  if (task === null || task === undefined) return raw;
  const taskRecord = serverObject(task, "Task pull response task");
  const taskId = serverString(taskRecord.task_id, "Task pull response task_id");
  const payload = await readExternalAgentTaskPayload(env.CORE_DB, taskId);
  if (payload === null) return raw;
  return Object.freeze({
    ...raw,
    task: Object.freeze({
      ...taskRecord,
      task_kind: payload.envelope.task_kind,
      task_expires_at: payload.expires_at,
      payload_sha256: payload.payload_sha256,
      payload: payload.envelope,
    }),
  });
}

async function statusWithPayload(env: Env, raw: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
  const taskId = serverString(raw.task_id, "Task status task_id");
  const payload = await readExternalAgentTaskPayload(env.CORE_DB, taskId);
  return payload === null ? raw : Object.freeze({
    ...raw,
    task_kind: payload.envelope.task_kind,
    task_expires_at: payload.expires_at,
    payload_sha256: payload.payload_sha256,
  });
}

/** Parse one strict MCP callback envelope and delegate to the D1 delivery authority. */
export async function callExternalAgentTaskTool(
  env: Env,
  context: AuthenticatedRequestContext,
  grant: ProjectClientGrant,
  name: ExternalAgentTaskToolName,
  input: Record<string, unknown>,
): Promise<unknown> {
  const store = new ExternalAgentTaskStore(env.CORE_DB);
  const taskActor = actor(context, grant);
  switch (name) {
    case "eliotr_task_pull": {
      shape(input, ["client_grant_id"], ["worker_slot"], "Task pull request");
      const workerSlot = input.worker_slot === undefined ? "default" : stringValue(input.worker_slot, "worker_slot");
      return withPayload(env, await store.pull(taskActor, workerSlot));
    }
    case "eliotr_task_progress": {
      exact(input, ["client_grant_id", "task_id", "lease_id", "cursor", "progress"], "Task progress request");
      const progress = object(input.progress, "progress");
      const required = ["phase", "evidence_refs"] as const;
      const optional = ["message", "completed_units", "total_units"] as const;
      const progressFields = new Set<string>([...required, ...optional]);
      if (Object.keys(progress).some((key) => !progressFields.has(key)) ||
          required.some((key) => !Object.hasOwn(progress, key))) invalid("progress contains unknown or missing fields");
      const parsed: ExternalAgentProgressInput = {
        task_id: stringValue(input.task_id, "task_id"), lease_id: stringValue(input.lease_id, "lease_id"),
        cursor: numberValue(input.cursor, "cursor"), phase: stringValue(progress.phase, "progress.phase"),
        ...(progress.message === undefined ? {} :
          { message: stringValue(progress.message, "progress.message") }),
        ...(progress.completed_units === undefined ? {} :
          { completed_units: numberValue(progress.completed_units, "progress.completed_units") }),
        ...(progress.total_units === undefined ? {} :
          { total_units: numberValue(progress.total_units, "progress.total_units") }),
        evidence_refs: refs(progress.evidence_refs),
      };
      return store.recordProgress(taskActor, parsed);
    }
    case "eliotr_task_result": {
      exact(input, ["client_grant_id", "task_id", "lease_id", "idempotency_key", "result"], "Task result request");
      const result = object(input.result, "result");
      exact(result, ["disposition", "output", "evidence_refs", "diagnostics", "usage"], "result");
      const output = result.output === null ? null : object(result.output, "result.output");
      const disposition = stringValue(result.disposition, "result.disposition");
      if (disposition !== "SUCCEEDED" && disposition !== "PARTIAL" && disposition !== "FAILED") {
        invalid("result.disposition is invalid");
      }
      const parsed: ExternalAgentResultInput = {
        task_id: stringValue(input.task_id, "task_id"), lease_id: stringValue(input.lease_id, "lease_id"),
        idempotency_key: stringValue(input.idempotency_key, "idempotency_key"), disposition, output,
        evidence_refs: refs(result.evidence_refs), diagnostics: stringArray(result.diagnostics, "result.diagnostics"),
        usage: usage(result.usage),
      };
      return store.recordResult(taskActor, parsed);
    }
    case "eliotr_task_status": {
      exact(input, ["client_grant_id", "task_id"], "Task status request");
      return statusWithPayload(env, await store.status(taskActor, stringValue(input.task_id, "task_id")));
    }
  }
}
