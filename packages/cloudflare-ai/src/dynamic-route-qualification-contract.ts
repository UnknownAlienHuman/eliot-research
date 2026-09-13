const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CLAIM_KEYS = new Set([
  "claim_ref",
  "execution_probe_ref",
  "probe_idempotency_key",
  "probe_input_sha256",
  "status",
]);

export interface DynamicRouteQualificationObservationClaimInput {
  readonly probe_idempotency_key: string;
  readonly probe_input_sha256: string;
  readonly claim_ref: string;
}

export type DynamicRouteQualificationObservationClaim =
  | {
      readonly status: "CLAIMED";
      readonly claim_ref: string;
      readonly probe_idempotency_key: string;
      readonly probe_input_sha256: string;
    }
  | {
      readonly status: "IN_PROGRESS";
      readonly claim_ref: string;
      readonly probe_idempotency_key: string;
      readonly probe_input_sha256: string;
    }
  | {
      readonly status: "COMPLETED";
      readonly claim_ref: string;
      readonly probe_idempotency_key: string;
      readonly probe_input_sha256: string;
    };

function record(value: unknown, invalid: (message: string) => never): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("qualification observation claim must be a plain object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid("qualification observation claim must be a plain object");
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (descriptor === undefined || !("value" in descriptor) || !CLAIM_KEYS.has(key)) invalid("qualification observation claim contains an unsupported field");
  }
  return result;
}

function stringField(value: unknown, pattern: RegExp, label: string, invalid: (message: string) => never): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

export function decodeDynamicRouteQualificationObservationClaim(
  raw: unknown,
  invalid: (message: string) => never,
): DynamicRouteQualificationObservationClaim {
  const value = record(raw, invalid);
  if (value.status !== "CLAIMED" && value.status !== "IN_PROGRESS" && value.status !== "COMPLETED") invalid("qualification observation claim status is invalid");
  const base = {
    claim_ref: stringField(value.claim_ref, IDENTIFIER, "qualification claim reference", invalid),
    probe_idempotency_key: stringField(value.probe_idempotency_key, IDENTIFIER, "qualification claim key", invalid),
    probe_input_sha256: stringField(value.probe_input_sha256, SHA256, "qualification claim input digest", invalid),
  };
  return Object.freeze({ status: value.status, ...base });
}
