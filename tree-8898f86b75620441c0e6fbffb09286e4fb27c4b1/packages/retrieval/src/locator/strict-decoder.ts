import {
  LocatorCandidateSchema,
  type LocatorCandidate,
} from "@eliotr/contracts";

export interface LocatorDecodeLimits {
  readonly max_results: number;
  readonly max_preview_bytes: number;
}

export type UnresolvedLocatorCandidate = LocatorCandidate & {
  readonly proof_state: "UNRESOLVED_LOCATOR";
};

export class LocatorDecodeError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LocatorDecodeError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LocatorDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const forbiddenAuthorityFields = new Set([
  "evidence_handle",
  "evidence_handle_ref",
  "scope_snapshot_ref",
  "citation_id",
  "verified",
  "is_evidence",
  "proof_state",
]);

/**
 * Decodes the ERC-controlled locator envelope after a vendor adapter extracts result rows. The
 * canonical strict schema rejects all unknown fields; explicit authority-shaped fields receive a
 * clearer error because a search provider is never allowed to mint evidence.
 */
export function decodeUnresolvedLocatorCandidates(
  input: unknown,
  limits: LocatorDecodeLimits,
): readonly UnresolvedLocatorCandidate[] {
  if (!Number.isInteger(limits.max_results) || limits.max_results < 1 || limits.max_results > 50) {
    throw new LocatorDecodeError("max_results must be an integer in [1, 50]");
  }
  if (!Number.isInteger(limits.max_preview_bytes) || limits.max_preview_bytes < 0) {
    throw new LocatorDecodeError("max_preview_bytes must be a non-negative integer");
  }
  if (!Array.isArray(input)) throw new LocatorDecodeError("results must be an array");
  if (input.length > limits.max_results) throw new LocatorDecodeError("result count exceeds bound");

  return input.map((raw, index) => {
    const row = record(raw, `results[${index}]`);
    for (const field of forbiddenAuthorityFields) {
      if (Object.prototype.hasOwnProperty.call(row, field)) {
        throw new LocatorDecodeError(
          `results[${index}].${field} attempts to mint evidence authority`,
        );
      }
    }

    const parsed = LocatorCandidateSchema.safeParse(row);
    if (!parsed.success) {
      throw new LocatorDecodeError(`results[${index}] is not a strict LocatorCandidate`, parsed.error);
    }
    if (!Number.isFinite(parsed.data.raw_score)) {
      throw new LocatorDecodeError(`results[${index}].raw_score must be finite`);
    }
    if (utf8Length(parsed.data.preview) > limits.max_preview_bytes) {
      throw new LocatorDecodeError(`results[${index}].preview exceeds byte bound`);
    }
    return { ...parsed.data, proof_state: "UNRESOLVED_LOCATOR" as const };
  });
}
