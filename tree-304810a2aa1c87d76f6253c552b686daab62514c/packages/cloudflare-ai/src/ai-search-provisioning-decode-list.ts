import {
  AI_SEARCH_LIST_PAGE_SIZE,
  AI_SEARCH_MAX_LIST_PAGES,
  AI_SEARCH_MAX_LIST_TOTAL,
  provisioningFailure,
} from "./ai-search-provisioning-contract.js";
import {
  AI_SEARCH_INFO_KEYS,
  AI_SEARCH_LIST_INFO_KEYS,
  AI_SEARCH_LIST_KEYS,
  decodeAiSearchSummaryFields,
  exactAiSearchObject,
  safeAiSearchInteger,
  type AiSearchListPage,
} from "./ai-search-provisioning-decode-common.js";

function decodeSummary(raw: unknown, label: string) {
  return decodeAiSearchSummaryFields(
    exactAiSearchObject(raw, AI_SEARCH_INFO_KEYS, label),
    label,
  );
}

export function decodeAiSearchInstanceListPage(
  raw: unknown,
  expectedPage: number,
): AiSearchListPage {
  safeAiSearchInteger(expectedPage, "expected page", 1, AI_SEARCH_MAX_LIST_PAGES);
  const value = exactAiSearchObject(
    raw,
    AI_SEARCH_LIST_KEYS,
    "AI Search instance list",
  );
  if (!Array.isArray(value.result) || value.result.length > AI_SEARCH_LIST_PAGE_SIZE) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search instance list result exceeds the page bound",
    );
  }
  const decodedResult = Object.freeze(
    value.result.map((entry, index) =>
      decodeSummary(entry, `AI Search instance list result[${index}]`),
    ),
  );
  if (value.result_info === undefined) {
    if (value.result.length === AI_SEARCH_LIST_PAGE_SIZE) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search instance list omits pagination at the page-size boundary",
      );
    }
    return Object.freeze({
      result: decodedResult,
      total_count: value.result.length,
    });
  }
  const resultInfo = exactAiSearchObject(
    value.result_info,
    AI_SEARCH_LIST_INFO_KEYS,
    "AI Search instance list result_info",
  );
  const totalCount = safeAiSearchInteger(
    resultInfo.total_count,
    "AI Search instance list total_count",
    0,
    AI_SEARCH_MAX_LIST_TOTAL,
  );
  if (
    resultInfo.count !== undefined &&
    safeAiSearchInteger(
      resultInfo.count,
      "AI Search instance list count",
      0,
      AI_SEARCH_LIST_PAGE_SIZE,
    ) !== value.result.length
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search instance list count differs from result length",
    );
  }
  if (
    resultInfo.page !== undefined &&
    safeAiSearchInteger(
      resultInfo.page,
      "AI Search instance list page",
      1,
      AI_SEARCH_MAX_LIST_PAGES,
    ) !== expectedPage
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search instance list returned the wrong page",
    );
  }
  if (
    resultInfo.per_page !== undefined &&
    safeAiSearchInteger(
      resultInfo.per_page,
      "AI Search instance list per_page",
      1,
      AI_SEARCH_LIST_PAGE_SIZE,
    ) !== AI_SEARCH_LIST_PAGE_SIZE
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search instance list returned the wrong per_page value",
    );
  }
  return Object.freeze({
    result: decodedResult,
    total_count: totalCount,
  });
}
