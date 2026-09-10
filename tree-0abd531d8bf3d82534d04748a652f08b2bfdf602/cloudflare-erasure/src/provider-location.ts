import type {
  ErasureRequest,
  AbsenceVerificationReceipt,
  PurgeAttemptReceipt,
  PurgeTarget,
} from "@eliotr/contracts";
import {
  assertErasureIdentifier,
  assertErasureText,
  erasureFail,
  stableErasureId,
} from "./canonical.js";
import type {
  ErasureLocationPort,
  ManagedSearchErasureItem,
  ManagedSearchErasureNamespace,
} from "./types.js";

interface ProviderTarget {
  readonly instance_id: string;
  readonly key: string;
}

function parseTarget(target: PurgeTarget): ProviderTarget | null {
  if (target.target_kind === "LOCATION_EMPTY_PROOF") return null;
  const prefix = "ai-search:";
  if (!target.canonical_ref.startsWith(prefix)) {
    erasureFail("ERASURE_INPUT_INVALID", `unsupported provider erasure target ${target.canonical_ref}`);
  }
  const body = target.canonical_ref.slice(prefix.length);
  const separator = body.indexOf(":");
  if (separator < 1) erasureFail("ERASURE_INPUT_INVALID", "provider erasure target is incomplete");
  return {
    instance_id: assertErasureIdentifier(body.slice(0, separator), "AI Search instance ID"),
    key: assertErasureText(body.slice(separator + 1), "AI Search item key", 1024),
  };
}

async function matches(
  namespace: ManagedSearchErasureNamespace,
  parsed: ProviderTarget,
): Promise<readonly ManagedSearchErasureItem[]> {
  const instance = namespace.get(parsed.instance_id);
  const found: ManagedSearchErasureItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1024; page += 1) {
    const result = await instance.list(cursor);
    for (const item of result.items) {
      assertErasureIdentifier(item.id, "AI Search item ID");
      assertErasureText(item.key, "AI Search item key", 1024);
      if (item.key === parsed.key) found.push(item);
    }
    if (result.cursor === undefined) break;
    if (result.cursor.length === 0 || result.cursor === cursor) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "AI Search cursor did not advance", true);
    }
    cursor = result.cursor;
  }
  if (found.length > 1) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "multiple AI Search items share one exact provider key");
  }
  return found;
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

export function createManagedSearchErasureLocationPort(
  namespace: ManagedSearchErasureNamespace,
): ErasureLocationPort {
  return {
    async purge(request, _fence, target): Promise<PurgeAttemptReceipt> {
      const parsed = parseTarget(target);
      if (parsed === null) {
        return {
          target_id: target.target_id,
          disposition: "ALREADY_ABSENT",
          receipt_ref: await receipt("delete-provider", request, target, "empty"),
        };
      }
      const found = await matches(namespace, parsed);
      if (found.length === 0) {
        return {
          target_id: target.target_id,
          disposition: "ALREADY_ABSENT",
          receipt_ref: await receipt("delete-provider", request, target, "already-absent"),
        };
      }
      const matchedItem = found[0];
    if (matchedItem === undefined) {
      throw new Error("provider match disappeared before deletion");
    }
    await namespace.get(parsed.instance_id).delete(matchedItem.id);
      return {
        target_id: target.target_id,
        disposition: "DELETE_ACCEPTED",
        receipt_ref: await receipt("delete-provider", request, target, "accepted"),
      };
    },

    async verifyAbsent(request, _fence, target): Promise<AbsenceVerificationReceipt> {
      const parsed = parseTarget(target);
      const absent = parsed === null || (await matches(namespace, parsed)).length === 0;
      return {
        target_id: target.target_id,
        absent,
        receipt_ref: await receipt("absence-provider", request, target, absent ? "absent" : "present"),
        ...(absent ? {} : { reason_code: "PROVIDER_COPY_REMAINS" }),
      };
    },
  };
}
