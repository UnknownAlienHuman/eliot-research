/** Strict, read-only owner client for the canonical computer-agent dispatch ledger. */
import {
  ComputerAgentDispatchListSchema,
  type ComputerAgentDispatchList,
} from "@eliotr/contracts";
import type { LegacyErrorDetails, LegacyErrorFactory, LegacyHttpAdapter } from "../legacy/http";
import type { EpochPort } from "../transport/client";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const TRACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LIST_PATH = "/api/v1/research/projects";
const INPUT_ERROR = "COMPUTER_AGENT_DISPATCH_INPUT_INVALID";

type DispatchReadHttp = Pick<LegacyHttpAdapter, "requestApiWithStatuses">;

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type ComputerAgentDispatchReadPage = DeepReadonly<ComputerAgentDispatchList>;

/** No identity, mutation, global fetch, clock, DOM, or persistence authority is acquired. */
export function createComputerAgentDispatchReadApi(
  http: DispatchReadHttp,
  errors: LegacyErrorFactory,
  epoch: EpochPort,
) {
  const { requestApiWithStatuses } = http;
  const fail = (details: Omit<LegacyErrorDetails, "traceId" | "retryable"> &
    Partial<Pick<LegacyErrorDetails, "traceId" | "retryable">>): Error =>
    errors({ traceId: null, retryable: false, ...details });
  const closed = (): never => {
    throw fail({ status: 503, code: "API_SESSION_CLOSED", message: "Owner session is closed" });
  };
  const currentCapture = (): object => {
    const captured = epoch.capture();
    if (captured === undefined || !epoch.isCurrent(captured)) return closed();
    return captured;
  };
  const currentResult = <T>(captured: object, result: T): T => {
    if (!epoch.isCurrent(captured)) return closed();
    return result;
  };
  const guarded = async <T>(captured: object, result: Promise<T>): Promise<T> =>
    currentResult(captured, await result);

  function inputInvalid(message: string): never {
    throw fail({ status: 400, code: INPUT_ERROR, message });
  }
  function responseInvalid(): never {
    throw fail({ status: 502, code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: "Computer-agent dispatch response does not match its shared contract" });
  }
  function generationChanged(): never {
    throw fail({ status: 409, code: "API_GENERATION_MISMATCH",
      message: "Deployment changed; discard computer-agent dispatch state and reload", retryable: true });
  }
  function identifier(value: unknown, label: string): string {
    if (typeof value !== "string" || /[\u0000-\u0020\u007f]/u.test(value) ||
        !IDENTIFIER.test(value)) {
      inputInvalid(`${label} is invalid`);
    }
    return value;
  }
  function expectedGeneration(value: string): string {
    return identifier(value, "Deployment generation");
  }
  function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!record(value) || Object.keys(value).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(value, key)) ||
        Object.keys(value).some((key) => !keys.includes(key))) {
      responseInvalid();
    }
    return value;
  }
  function safeEnvelopeText(value: unknown, expression: RegExp, maximumLength: number): string {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
        value.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(value) ||
        !expression.test(value)) {
      responseInvalid();
    }
    return value;
  }
  function decodeEnvelope(value: unknown, generation: string): unknown {
    const envelope = exactRecord(value, ["data", "trace_id", "deployment_generation"]);
    safeEnvelopeText(envelope.trace_id, TRACE, 128);
    const receivedGeneration = safeEnvelopeText(envelope.deployment_generation, IDENTIFIER, 256);
    if (receivedGeneration !== generation) generationChanged();
    return envelope.data;
  }
  function freezePage(page: ComputerAgentDispatchList): ComputerAgentDispatchReadPage {
    const items = page.items.map((item) => {
      const accepted = item.accepted_workflow === null ? null : Object.freeze({
        ...item.accepted_workflow,
        investigation_ref: Object.freeze({ ...item.accepted_workflow.investigation_ref }),
      });
      return Object.freeze({ ...item, accepted_workflow: accepted });
    });
    return Object.freeze({ ...page, items: Object.freeze(items) }) as ComputerAgentDispatchReadPage;
  }

  async function readComputerAgentDispatches(
    projectIdValue: string,
    generationValue: string,
    afterDispatchIdValue?: string,
    signal?: AbortSignal,
  ): Promise<ComputerAgentDispatchReadPage> {
    const captured = currentCapture();
    const projectId = identifier(projectIdValue, "Project ID");
    const generation = expectedGeneration(generationValue);
    const afterDispatchId = afterDispatchIdValue === undefined
      ? undefined
      : identifier(afterDispatchIdValue, "Dispatch cursor");
    const path = `${LIST_PATH}/${encodeURIComponent(projectId)}/computer-agent-dispatches` +
      (afterDispatchId === undefined ? "" : `?after_dispatch_id=${encodeURIComponent(afterDispatchId)}`);
    currentResult(captured, undefined);
    const raw = await guarded(captured, requestApiWithStatuses(path, {
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
    }, [200]));
    const decoded = decodeEnvelope(raw, generation);
    const parsed = ComputerAgentDispatchListSchema.safeParse(decoded);
    if (!parsed.success) responseInvalid();

    let previousId = afterDispatchId ?? "";
    for (const item of parsed.data.items) {
      if (item.project_id !== projectId || item.dispatch_id <= previousId) responseInvalid();
      previousId = item.dispatch_id;
    }
    const next = parsed.data.next_after_dispatch_id;
    if (next !== null && afterDispatchId !== undefined && next <= afterDispatchId) responseInvalid();
    const page = freezePage(parsed.data);
    return currentResult(captured, page);
  }

  return Object.freeze({ readComputerAgentDispatches });
}
