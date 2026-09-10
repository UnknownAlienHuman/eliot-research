import {
  assertErasureIdentifier,
  assertErasureInteger,
  assertErasureText,
  erasureFail,
} from "./canonical.js";
import type {
  ManagedSearchErasureInstance,
  ManagedSearchErasureNamespace,
  ManagedSearchErasurePage,
} from "./types.js";

const PAGE_SIZE = 50;
const MAX_TOTAL_ITEMS = 50_000;
const MAX_PAGES = 1_024;

interface AiSearchItemHandleBinding {
  info(): Promise<unknown>;
}

interface AiSearchItemsBinding {
  list(input?: { readonly page?: number; readonly per_page?: number }): Promise<unknown>;
  delete(itemId: string): Promise<unknown>;
  get(itemId: string): AiSearchItemHandleBinding | Promise<AiSearchItemHandleBinding>;
}

interface AiSearchInstanceBinding {
  readonly items: AiSearchItemsBinding;
}

export interface AiSearchErasureNamespaceBinding {
  get(instanceId: string): AiSearchInstanceBinding;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", `${label} is not an object`, true);
  }
  return value as Record<string, unknown>;
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  return assertErasureInteger(value, label, minimum, maximum);
}

function pageFromCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  if (!/^[1-9][0-9]{0,3}$/u.test(cursor)) {
    erasureFail("ERASURE_INPUT_INVALID", "AI Search erasure cursor is invalid");
  }
  return assertErasureInteger(Number(cursor), "AI Search page cursor", 1, MAX_PAGES);
}

function resultItems(payload: Record<string, unknown>): readonly unknown[] {
  if (Array.isArray(payload.result)) return payload.result;
  if (Array.isArray(payload.items)) return payload.items;
  erasureFail(
    "ERASURE_SETTLEMENT_UNCERTAIN",
    "AI Search item-list readback does not contain a bounded item array",
    true,
  );
}

function nextCursor(
  payload: Record<string, unknown>,
  page: number,
  count: number,
): string | undefined {
  const resultInfo = payload.result_info === undefined
    ? undefined
    : record(payload.result_info, "AI Search result_info");
  if (resultInfo !== undefined) {
    const observedPage = optionalInteger(resultInfo.page, "AI Search result page", 1, MAX_PAGES);
    if (observedPage !== undefined && observedPage !== page) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "AI Search result page readback drifted", true);
    }
    const totalPages = optionalInteger(
      resultInfo.total_pages,
      "AI Search total pages",
      0,
      MAX_PAGES,
    );
    const totalCount = optionalInteger(
      resultInfo.total_count,
      "AI Search total item count",
      0,
      MAX_TOTAL_ITEMS,
    );
    if (totalPages !== undefined) return page < totalPages ? String(page + 1) : undefined;
    if (totalCount !== undefined) return page * PAGE_SIZE < totalCount ? String(page + 1) : undefined;
  }
  return count === PAGE_SIZE && page < MAX_PAGES ? String(page + 1) : undefined;
}

function decodePage(value: unknown, requestedPage: number): ManagedSearchErasurePage {
  const payload = record(value, "AI Search item-list response");
  const rawItems = resultItems(payload);
  if (rawItems.length > PAGE_SIZE) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "AI Search page exceeds the requested bound", true);
  }
  const items = rawItems.map((raw, index) => {
    const item = record(raw, `AI Search item ${index}`);
    return {
      id: assertErasureIdentifier(item.id, `AI Search item ${index} ID`),
      key: assertErasureText(item.key, `AI Search item ${index} key`, 1024),
    };
  });
  const cursor = nextCursor(payload, requestedPage, items.length);
  return {
    items,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function itemsBinding(namespace: AiSearchErasureNamespaceBinding, instanceId: string): AiSearchItemsBinding {
  const instance = namespace.get(assertErasureIdentifier(instanceId, "AI Search instance ID"));
  if (typeof instance !== "object" || instance === null) {
    erasureFail("ERASURE_LOCATION_UNAVAILABLE", "AI Search instance binding is unavailable", true);
  }
  const items = instance.items;
  if (
    typeof items !== "object" ||
    items === null ||
    typeof items.list !== "function" ||
    typeof items.delete !== "function" ||
    typeof items.get !== "function"
  ) {
    erasureFail("ERASURE_LOCATION_UNAVAILABLE", "AI Search item binding is incomplete", true);
  }
  return items;
}

export function createAiSearchErasureNamespace(
  binding: AiSearchErasureNamespaceBinding,
): ManagedSearchErasureNamespace {
  return {
    get(instanceId): ManagedSearchErasureInstance {
      const boundedInstanceId = assertErasureIdentifier(instanceId, "AI Search instance ID");
      return {
        async list(cursor) {
          const page = pageFromCursor(cursor);
          const value = await itemsBinding(binding, boundedInstanceId).list({
            page,
            per_page: PAGE_SIZE,
          });
          return decodePage(value, page);
        },
        async delete(itemId) {
          const boundedItemId = assertErasureIdentifier(itemId, "AI Search item ID");
          await itemsBinding(binding, boundedInstanceId).delete(boundedItemId);
        },
        async info(itemId) {
          const boundedItemId = assertErasureIdentifier(itemId, "AI Search item ID");
          let handle: AiSearchItemHandleBinding;
          try {
            handle = await itemsBinding(binding, boundedInstanceId).get(boundedItemId);
          } catch (error) {
            erasureFail(
              "ERASURE_SETTLEMENT_UNCERTAIN",
              "AI Search item handle could not be opened",
              true,
              error,
            );
          }
          if (typeof handle !== "object" || handle === null || typeof handle.info !== "function") {
            erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "AI Search item handle is malformed", true);
          }
          try {
            return await handle.info();
          } catch {
            return null;
          }
        },
      };
    },
  };
}
