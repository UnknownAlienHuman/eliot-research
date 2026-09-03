import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";
import { assertImmutableAiSearchProfile } from "./ai-search-generation.js";
import {
  AI_SEARCH_CUSTOM_METADATA_FIELDS,
  AI_SEARCH_RERANKING_MODEL,
  assertCloudflareAiSearchInstanceProfile,
} from "./ai-search-profile.js";
import {
  AI_SEARCH_LIST_PAGE_SIZE,
  AI_SEARCH_MAX_LIST_PAGES,
  aiSearchProvisioningSha256,
  compileAiSearchCreateRequest,
  provisioningFailure,
  type AiSearchCreateRequest,
  type AiSearchInstanceProvisioningSpec,
  type AiSearchProvisioningDisposition,
  type AiSearchProvisioningInstance,
  type AiSearchProvisioningNamespace,
  type AiSearchProvisioningReceipt,
} from "./ai-search-provisioning-contract.js";
import {
  decodeAiSearchInstanceInfo,
  decodeAiSearchInstanceListPage,
  type AiSearchInstanceReadback,
  type AiSearchInstanceSummary,
} from "./ai-search-provisioning-decode.js";

function readbackProfile(
  readback: AiSearchInstanceReadback,
  generation: string,
): AiSearchInstanceProfile {
  return {
    id: readback.id,
    generation,
    index_method: readback.index_method,
    ...(readback.fusion_method === undefined
      ? {}
      : { fusion_method: readback.fusion_method }),
    ...(readback.keyword_tokenizer === undefined
      ? {}
      : { keyword_tokenizer: readback.keyword_tokenizer }),
    ...(readback.keyword_match_mode === undefined
      ? {}
      : { keyword_match_mode: readback.keyword_match_mode }),
    ...(readback.embedding_model === undefined
      ? {}
      : { embedding_model: readback.embedding_model }),
    reranking: readback.reranking,
    max_num_results: readback.max_num_results,
    metadata_fields: Object.freeze(
      readback.custom_metadata.map((definition) => definition.field_name),
    ),
  };
}

function assertReadbackMatchesSpec(
  readback: AiSearchInstanceReadback,
  spec: AiSearchInstanceProvisioningSpec,
): void {
  if (readback.namespace !== spec.namespace) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
      "AI Search instance namespace differs from the desired namespace",
    );
  }
  if (readback.type !== null || readback.source !== null) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
      "AI Search instance is not backed by built-in storage",
    );
  }
  if (!readback.enable || readback.cache || readback.rewrite_query) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
      "AI Search instance enable, cache, or rewrite policy differs",
    );
  }
  if (
    readback.chunk_size !== spec.chunk_size ||
    readback.chunk_overlap !== spec.chunk_overlap ||
    readback.boost_by.length !== 0
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
      "AI Search chunking or retrieval boosts differ from the desired profile",
    );
  }
  if (
    readback.custom_metadata.some((definition) => definition.data_type !== "text") ||
    readback.custom_metadata.length !== AI_SEARCH_CUSTOM_METADATA_FIELDS.length
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
      "AI Search custom metadata types differ from the canonical text schema",
    );
  }
  if (
    (spec.profile.reranking &&
      readback.reranking_model !== AI_SEARCH_RERANKING_MODEL) ||
    (!spec.profile.reranking && readback.reranking_model !== undefined)
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
      "AI Search reranking model differs from the desired profile",
    );
  }
  try {
    const observedProfile = readbackProfile(readback, spec.profile.generation);
    assertCloudflareAiSearchInstanceProfile(observedProfile);
    assertImmutableAiSearchProfile(observedProfile, spec.profile);
  } catch (cause) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
      "AI Search immutable instance profile differs from the desired profile",
      cause,
    );
  }
}

async function findExistingInstance(
  namespace: AiSearchProvisioningNamespace,
  spec: AiSearchInstanceProvisioningSpec,
): Promise<AiSearchInstanceSummary | null> {
  const seenIds = new Set<string>();
  const pageFingerprints = new Set<string>();
  const matches: AiSearchInstanceSummary[] = [];
  let expectedTotal: number | undefined;
  let observedCount = 0;
  for (let pageNumber = 1; pageNumber <= AI_SEARCH_MAX_LIST_PAGES; pageNumber += 1) {
    let rawPage: unknown;
    try {
      rawPage = await namespace.list({
        page: pageNumber,
        per_page: AI_SEARCH_LIST_PAGE_SIZE,
        search: spec.profile.id,
        order_by: "created_at",
        order_by_direction: "asc",
      });
    } catch (cause) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_CALL_FAILED",
        "AI Search namespace list call failed",
        cause,
      );
    }
    const decoded = decodeAiSearchInstanceListPage(rawPage, pageNumber);
    if (expectedTotal === undefined) expectedTotal = decoded.total_count;
    const total = expectedTotal;
    if (decoded.total_count !== total) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search list total_count changed during pagination",
      );
    }
    const pageFingerprint = decoded.result.map((entry) => entry.id).join("\u0000");
    if (decoded.result.length > 0 && pageFingerprints.has(pageFingerprint)) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search list repeated a page during pagination",
      );
    }
    pageFingerprints.add(pageFingerprint);
    for (const summary of decoded.result) {
      if (seenIds.has(summary.id)) {
        provisioningFailure(
          summary.id === spec.profile.id
            ? "AI_SEARCH_PROVISIONING_DUPLICATE_INSTANCE"
            : "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
          `AI Search list returned duplicate instance ${summary.id}`,
        );
      }
      seenIds.add(summary.id);
      if (summary.id === spec.profile.id) matches.push(summary);
    }
    observedCount += decoded.result.length;
    if (observedCount > total) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search list returned more rows than total_count",
      );
    }
    if (observedCount === total) break;
    if (decoded.result.length === 0) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search list ended before total_count was observed",
      );
    }
    if (pageNumber === AI_SEARCH_MAX_LIST_PAGES) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search list exceeded the pagination ceiling",
      );
    }
  }
  if (matches.length > 1) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_DUPLICATE_INSTANCE",
      "AI Search namespace contains duplicate desired instance IDs",
    );
  }
  return matches[0] ?? null;
}

async function readExactInstance(
  handle: AiSearchProvisioningInstance,
  spec: AiSearchInstanceProvisioningSpec,
): Promise<AiSearchInstanceReadback> {
  let rawInfo: unknown;
  try {
    rawInfo = await handle.info();
  } catch (cause) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_CALL_FAILED",
      "AI Search instance info call failed",
      cause,
    );
  }
  const readback = decodeAiSearchInstanceInfo(rawInfo);
  assertReadbackMatchesSpec(readback, spec);
  return readback;
}

async function buildReceipt(
  disposition: AiSearchProvisioningDisposition,
  spec: AiSearchInstanceProvisioningSpec,
  request: AiSearchCreateRequest,
  readback: AiSearchInstanceReadback,
): Promise<AiSearchProvisioningReceipt> {
  const desiredDigest = await aiSearchProvisioningSha256(request);
  const readbackDigest = await aiSearchProvisioningSha256(readback);
  const receiptDigest = await aiSearchProvisioningSha256({
    disposition,
    namespace: spec.namespace,
    instance_id: spec.profile.id,
    generation: spec.profile.generation,
    desired_configuration_sha256: desiredDigest,
    readback_configuration_sha256: readbackDigest,
  });
  return Object.freeze({
    receipt_ref: `ai-search-provisioning-${receiptDigest.slice(0, 48)}`,
    disposition,
    namespace: spec.namespace,
    instance_id: spec.profile.id,
    generation: spec.profile.generation,
    provider_status: readback.status,
    provider_created_at: readback.created_at,
    provider_modified_at: readback.modified_at,
    desired_configuration_sha256: desiredDigest,
    readback_configuration_sha256: readbackDigest,
  });
}

async function reconcileCreate(
  namespace: AiSearchProvisioningNamespace,
  spec: AiSearchInstanceProvisioningSpec,
  request: AiSearchCreateRequest,
  originalCause: unknown,
): Promise<AiSearchProvisioningReceipt> {
  try {
    const readback = await readExactInstance(namespace.get(spec.profile.id), spec);
    return buildReceipt("CREATE_RECONCILED", spec, request, readback);
  } catch (reconciliationCause) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_CREATE_UNCERTAIN",
      "AI Search create outcome could not be reconciled to an exact instance",
      new AggregateError(
        [originalCause, reconciliationCause],
        "AI Search create and reconciliation both failed",
      ),
    );
  }
}

export async function ensureAiSearchInstance(
  namespace: AiSearchProvisioningNamespace,
  spec: AiSearchInstanceProvisioningSpec,
): Promise<AiSearchProvisioningReceipt> {
  const request = compileAiSearchCreateRequest(spec);
  const existing = await findExistingInstance(namespace, spec);
  if (existing !== null) {
    const readback = await readExactInstance(namespace.get(spec.profile.id), spec);
    return buildReceipt("EXISTING_MATCH", spec, request, readback);
  }
  let createdHandle: AiSearchProvisioningInstance;
  try {
    createdHandle = await namespace.create(request);
  } catch (cause) {
    return reconcileCreate(namespace, spec, request, cause);
  }
  try {
    const readback = await readExactInstance(createdHandle, spec);
    return buildReceipt("CREATED", spec, request, readback);
  } catch (cause) {
    return reconcileCreate(namespace, spec, request, cause);
  }
}
