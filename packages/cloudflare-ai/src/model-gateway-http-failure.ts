import {
  ModelGatewayExecutionError,
  modelGatewayExecutionFailure,
} from "./model-gateway-execution-contract.js";
import {
  decodeDlpAction,
  plainObject,
  readBoundedBody,
  validateBoundedJson,
} from "./model-gateway-response.js";

const POLICY_ERROR_CODES = new Set([2016, 2017, 2029, 2030]);
const RATE_LIMIT_ERROR_CODES = new Set([2003]);
const MAX_ERROR_BODY_BYTES = 64 * 1024;

function possibleErrorCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,9})$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function collectErrorCodes(raw: unknown): ReadonlySet<number> {
  const codes = new Set<number>();
  const root = plainObject(raw);
  if (root === null) return codes;
  const direct = possibleErrorCode(root.code);
  if (direct !== undefined) codes.add(direct);
  const error = plainObject(root.error);
  const errorCode = possibleErrorCode(error?.code);
  if (errorCode !== undefined) codes.add(errorCode);
  if (Array.isArray(root.errors) && root.errors.length <= 32) {
    for (const entry of root.errors) {
      const record = plainObject(entry);
      const code = possibleErrorCode(record?.code);
      if (code !== undefined) codes.add(code);
    }
  }
  return codes;
}

export async function rejectModelGatewayHttpFailure(
  response: Response,
): Promise<never> {
  const dlpAction = decodeDlpAction(response.headers);
  const bytes = await readBoundedBody(response, MAX_ERROR_BODY_BYTES, false);
  let raw: unknown;
  if (bytes.byteLength > 0) {
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      validateBoundedJson(raw, 0, {
        members: 0,
        ancestors: new WeakSet(),
      });
    } catch (cause) {
      if (cause instanceof ModelGatewayExecutionError) throw cause;
      raw = undefined;
    }
  }
  const codes = collectErrorCodes(raw);
  if (
    dlpAction !== undefined ||
    [...codes].some((code) => POLICY_ERROR_CODES.has(code))
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_POLICY_REJECTED",
      "AI Gateway blocked the request or response under DLP or guardrail policy",
      { http_status: response.status },
    );
  }
  if (response.status === 401 || response.status === 403) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_AUTH_REJECTED",
      "AI Gateway rejected the authenticated request",
      { http_status: response.status },
    );
  }
  if (
    response.status === 429 ||
    [...codes].some((code) => RATE_LIMIT_ERROR_CODES.has(code))
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_LIMIT_REJECTED",
      "AI Gateway rejected the request because a rate or spend limit was reached",
      { http_status: response.status },
    );
  }
  modelGatewayExecutionFailure(
    "MODEL_GATEWAY_UPSTREAM_REJECTED",
    "AI Gateway returned a non-success status",
    { http_status: response.status },
  );
}
