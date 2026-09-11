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
  ManagedSearchErasureInstance,
  ManagedSearchErasureItem,
  ManagedSearchErasureNamespace,
  ManagedSearchErasurePage,
} from "./types.js";

interface ProviderTarget {
  readonly instance_id: string;
  readonly key: string;
}

const MAX_PROVIDER_PAGES = 1024;
const MAX_PROVIDER_ITEMS = 100_000;

function parseTarget(target: PurgeTarget): ProviderTarget {
  if (target.target_kind !== "OBJECT") {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "unverified provider empty proof is not executable");
  }
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
  let instance: ManagedSearchErasureInstance;
  try { instance = namespace.get(parsed.instance_id); }
  catch (cause) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "AI Search instance lookup failed", true, cause);
  }
  const found: ManagedSearchErasureItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let observed = 0;
  for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
    let result: ManagedSearchErasurePage;
    try { result = await instance.list(cursor); }
    catch (cause) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "AI Search inventory read failed", true, cause);
    }
    if (!Array.isArray(result.items)) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "AI Search inventory returned malformed items", true);
    }
    observed += result.items.length;
    if (observed > MAX_PROVIDER_ITEMS) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "AI Search inventory exceeds the bounded item ceiling");
    }
    for (const item of result.items) {
      assertErasureIdentifier(item.id, "AI Search item ID");
      assertErasureText(item.key, "AI Search item key", 1024);
      if (item.key === parsed.key) found.push(item);
    }
    if (result.cursor === undefined) {
      if (found.length > 1) {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "multiple AI Search items share one exact provider key");
      }
      return found;
    }
    const next = assertErasureText(result.cursor, "AI Search cursor", 2048);
    if (next === cursor || seenCursors.has(next)) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "AI Search cursor did not advance", true);
    }
    seenCursors.add(next);
    cursor = next;
  }
  erasureFail("ERASURE_CLOSURE_INCOMPLETE", "AI Search inventory exceeded the bounded page ceiling");
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
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "provider match disappeared before deletion", true);
      }
      try { await namespace.get(parsed.instance_id).delete(matchedItem.id); }
      catch (cause) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "AI Search delete settlement is unknown", true, cause);
      }
      return {
        target_id: target.target_id,
        disposition: "DELETE_ACCEPTED",
        receipt_ref: await receipt("delete-provider", request, target, "accepted"),
      };
    },

    async verifyAbsent(request, _fence, target): Promise<AbsenceVerificationReceipt> {
      const parsed = parseTarget(target);
      const absent = (await matches(namespace, parsed)).length === 0;
      return {
        target_id: target.target_id,
        absent,
        receipt_ref: await receipt("absence-provider", request, target, absent ? "absent" : "present"),
        ...(absent ? {} : { reason_code: "PROVIDER_COPY_REMAINS" }),
      };
    },
  };
}
