import type {
  ErasureRequest,
  AbsenceVerificationReceipt,
  PurgeAttemptReceipt,
  PurgeTarget,
} from "@eliotr/contracts";
import {
  assertErasureText,
  erasureFail,
  stableErasureId,
} from "./canonical.js";
import type { ErasureLocationPort } from "./types.js";

interface R2Target {
  readonly bucket: R2Bucket;
  readonly kind: "EXACT" | "PREFIX";
  readonly key: string;
}

function parseTarget(
  target: PurgeTarget,
  evidenceBucket: R2Bucket,
  workBucket: R2Bucket,
): R2Target | null {
  if (target.target_kind === "LOCATION_EMPTY_PROOF") return null;
  if (target.canonical_ref.startsWith("r2-evidence:")) {
    return {
      bucket: evidenceBucket,
      kind: "EXACT",
      key: assertErasureText(
        target.canonical_ref.slice("r2-evidence:".length),
        "R2 Evidence key",
        1024,
      ),
    };
  }
  if (target.canonical_ref.startsWith("r2-work-prefix:")) {
    return {
      bucket: workBucket,
      kind: "PREFIX",
      key: assertErasureText(
        target.canonical_ref.slice("r2-work-prefix:".length),
        "R2 Work prefix",
        1024,
      ),
    };
  }
  erasureFail("ERASURE_INPUT_INVALID", `unsupported R2 erasure target ${target.canonical_ref}`);
}

async function listPrefix(bucket: R2Bucket, prefix: string): Promise<readonly string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1024; page += 1) {
    const result = await bucket.list({
      prefix,
      limit: 1000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of result.objects) {
      if (!object.key.startsWith(prefix)) {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "R2 prefix inventory escaped its exact prefix");
      }
      keys.push(object.key);
      if (keys.length > 100_000) {
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "R2 prefix exceeds bounded erasure inventory");
      }
    }
    if (!result.truncated) return keys;
    if (typeof result.cursor !== "string" || result.cursor.length === 0 || result.cursor === cursor) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "R2 prefix cursor did not advance", true);
    }
    cursor = result.cursor;
  }
  erasureFail("ERASURE_CLOSURE_INCOMPLETE", "R2 prefix inventory exceeded page ceiling");
}

async function deleteKeys(bucket: R2Bucket, keys: readonly string[]): Promise<void> {
  for (let index = 0; index < keys.length; index += 1000) {
    const batch = keys.slice(index, index + 1000);
    if (batch.length === 1) await bucket.delete(batch[0] as string);
    else if (batch.length > 1) await bucket.delete([...batch]);
  }
}

async function receipt(
  prefix: string,
  request: ErasureRequest,
  target: PurgeTarget,
  state: string,
): Promise<string> {
  return stableErasureId(
    prefix,
    request.erasure_ref.id,
    String(request.erasure_ref.revision),
    target.target_id,
    state,
  );
}

export interface R2ErasureLocationDependencies {
  readonly evidence_bucket: R2Bucket;
  readonly work_bucket: R2Bucket;
}

export function createR2ErasureLocationPort(
  dependencies: R2ErasureLocationDependencies,
): ErasureLocationPort {
  return {
    async purge(request, _fence, target): Promise<PurgeAttemptReceipt> {
      const parsed = parseTarget(target, dependencies.evidence_bucket, dependencies.work_bucket);
      if (parsed === null) {
        return {
          target_id: target.target_id,
          disposition: "ALREADY_ABSENT",
          receipt_ref: await receipt("delete-r2", request, target, "empty"),
        };
      }
      if (parsed.kind === "EXACT") {
        if (await parsed.bucket.head(parsed.key) === null) {
          return {
            target_id: target.target_id,
            disposition: "ALREADY_ABSENT",
            receipt_ref: await receipt("delete-r2", request, target, "already-absent"),
          };
        }
        await parsed.bucket.delete(parsed.key);
      } else {
        const keys = await listPrefix(parsed.bucket, parsed.key);
        if (keys.length === 0) {
          return {
            target_id: target.target_id,
            disposition: "ALREADY_ABSENT",
            receipt_ref: await receipt("delete-r2", request, target, "already-absent"),
          };
        }
        await deleteKeys(parsed.bucket, keys);
      }
      return {
        target_id: target.target_id,
        disposition: "DELETE_ACCEPTED",
        receipt_ref: await receipt("delete-r2", request, target, "accepted"),
      };
    },

    async verifyAbsent(request, _fence, target): Promise<AbsenceVerificationReceipt> {
      const parsed = parseTarget(target, dependencies.evidence_bucket, dependencies.work_bucket);
      const absent = parsed === null || (parsed.kind === "EXACT"
        ? await parsed.bucket.head(parsed.key) === null
        : (await listPrefix(parsed.bucket, parsed.key)).length === 0);
      return {
        target_id: target.target_id,
        absent,
        receipt_ref: await receipt("absence-r2", request, target, absent ? "absent" : "present"),
        ...(absent ? {} : { reason_code: "R2_OBJECT_REMAINS" }),
      };
    },
  };
}
