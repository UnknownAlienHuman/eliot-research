import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";
import {
  AI_SEARCH_MAX_CHUNK_OVERLAP,
  AI_SEARCH_RERANKING_MODEL,
  AI_SEARCH_RETRIEVAL_GATEWAY_ID,
  AI_SEARCH_SCORE_THRESHOLD,
  aiSearchCustomMetadataDefinitions,
  assertCloudflareAiSearchInstanceProfile,
} from "./ai-search-profile.js";

export type AiSearchProvisioningErrorCode =
  | "AI_SEARCH_PROVISIONING_INPUT_INVALID"
  | "AI_SEARCH_PROVISIONING_PROVIDER_CALL_FAILED"
  | "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID"
  | "AI_SEARCH_PROVISIONING_DUPLICATE_INSTANCE"
  | "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH"
  | "AI_SEARCH_PROVISIONING_CREATE_UNCERTAIN";

export class AiSearchProvisioningError extends Error {
  public readonly code: AiSearchProvisioningErrorCode;

  public constructor(
    code: AiSearchProvisioningErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AiSearchProvisioningError";
    this.code = code;
  }
}

export interface AiSearchInstanceProvisioningSpec {
  readonly namespace: string;
  readonly profile: AiSearchInstanceProfile;
  readonly chunk_size: number;
  readonly chunk_overlap: number;
}

export interface AiSearchProvisioningInstance {
  info(): Promise<unknown>;
}

export interface AiSearchProvisioningNamespace {
  get(instanceId: string): AiSearchProvisioningInstance;
  list(input: {
    readonly page: number;
    readonly per_page: number;
    readonly search: string;
    readonly order_by: "created_at";
    readonly order_by_direction: "asc";
  }): Promise<unknown>;
  create(input: AiSearchCreateRequest): Promise<AiSearchProvisioningInstance>;
}

export interface AiSearchCreateRequest {
  readonly id: string;
  readonly ai_gateway_id: typeof AI_SEARCH_RETRIEVAL_GATEWAY_ID;
  readonly index_method: Readonly<{ vector: boolean; keyword: boolean }>;
  readonly fusion_method?: "rrf" | "max";
  readonly indexing_options?: Readonly<{ keyword_tokenizer: "porter" | "trigram" }>;
  readonly retrieval_options?: Readonly<{
    keyword_match_mode: "and" | "or";
    boost_by: readonly never[];
  }>;
  readonly embedding_model?: string;
  readonly reranking: boolean;
  readonly reranking_model?: typeof AI_SEARCH_RERANKING_MODEL;
  readonly rewrite_query: false;
  readonly cache: false;
  readonly chunk_size: number;
  readonly chunk_overlap: number;
  readonly score_threshold: typeof AI_SEARCH_SCORE_THRESHOLD;
  readonly max_num_results: number;
  readonly custom_metadata: ReturnType<typeof aiSearchCustomMetadataDefinitions>;
  readonly enable: true;
}

export type AiSearchProvisioningDisposition =
  | "EXISTING_MATCH"
  | "CREATED"
  | "CREATE_RECONCILED";

export interface AiSearchProvisioningReceipt {
  readonly receipt_ref: string;
  readonly disposition: AiSearchProvisioningDisposition;
  readonly namespace: string;
  readonly instance_id: string;
  readonly generation: string;
  readonly provider_status: "active" | "waiting" | "indexing";
  readonly provider_created_at: string;
  readonly provider_modified_at: string;
  readonly desired_configuration_sha256: string;
  readonly readback_configuration_sha256: string;
}

export const AI_SEARCH_LIST_PAGE_SIZE = 100;
export const AI_SEARCH_MAX_LIST_PAGES = 100;
export const AI_SEARCH_MAX_LIST_TOTAL = 10_000;
export const AI_SEARCH_MAX_NAMESPACE_BYTES = 256;

export function provisioningFailure(
  code: AiSearchProvisioningErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new AiSearchProvisioningError(code, message, cause);
}

export function validateAiSearchProvisioningSpec(
  spec: AiSearchInstanceProvisioningSpec,
): void {
  try {
    assertCloudflareAiSearchInstanceProfile(spec.profile);
  } catch (cause) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_INPUT_INVALID",
      "desired AI Search profile is invalid",
      cause,
    );
  }
  if (
    typeof spec.namespace !== "string" ||
    spec.namespace.length < 1 ||
    spec.namespace !== spec.namespace.trim() ||
    new TextEncoder().encode(spec.namespace).byteLength > AI_SEARCH_MAX_NAMESPACE_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(spec.namespace)
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_INPUT_INVALID",
      "AI Search namespace is invalid",
    );
  }
  if (
    !Number.isSafeInteger(spec.chunk_size) ||
    spec.chunk_size < 64 ||
    spec.chunk_size > 1_000_000
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_INPUT_INVALID",
      "chunk_size must be a safe integer in [64, 1000000]",
    );
  }
  if (
    !Number.isSafeInteger(spec.chunk_overlap) ||
    spec.chunk_overlap < 0 ||
    spec.chunk_overlap > AI_SEARCH_MAX_CHUNK_OVERLAP ||
    spec.chunk_overlap >= spec.chunk_size
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_INPUT_INVALID",
      `chunk_overlap must be an integer in [0, ${AI_SEARCH_MAX_CHUNK_OVERLAP}] and below chunk_size`,
    );
  }
}

export function compileAiSearchCreateRequest(
  spec: AiSearchInstanceProvisioningSpec,
): AiSearchCreateRequest {
  validateAiSearchProvisioningSpec(spec);
  const profile = spec.profile;
  return Object.freeze({
    id: profile.id,
    ai_gateway_id: AI_SEARCH_RETRIEVAL_GATEWAY_ID,
    index_method: Object.freeze({
      vector: profile.index_method.vector,
      keyword: profile.index_method.keyword,
    }),
    ...(profile.fusion_method === undefined
      ? {}
      : { fusion_method: profile.fusion_method }),
    ...(profile.keyword_tokenizer === undefined
      ? {}
      : {
          indexing_options: Object.freeze({
            keyword_tokenizer: profile.keyword_tokenizer,
          }),
        }),
    ...(profile.keyword_match_mode === undefined
      ? {}
      : {
          retrieval_options: Object.freeze({
            keyword_match_mode: profile.keyword_match_mode,
            boost_by: Object.freeze([]) as readonly never[],
          }),
        }),
    ...(profile.embedding_model === undefined
      ? {}
      : { embedding_model: profile.embedding_model }),
    reranking: profile.reranking,
    ...(profile.reranking ? { reranking_model: AI_SEARCH_RERANKING_MODEL } : {}),
    rewrite_query: false,
    cache: false,
    chunk_size: spec.chunk_size,
    chunk_overlap: spec.chunk_overlap,
    score_threshold: AI_SEARCH_SCORE_THRESHOLD,
    max_num_results: profile.max_num_results,
    custom_metadata: aiSearchCustomMetadataDefinitions(),
    enable: true,
  });
}

export function canonicalAiSearchProvisioningJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_INPUT_INVALID",
        "canonical provisioning JSON contains a non-finite number",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalAiSearchProvisioningJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalAiSearchProvisioningJson(record[key])}`,
      )
      .join(",")}}`;
  }
  provisioningFailure(
    "AI_SEARCH_PROVISIONING_INPUT_INVALID",
    "canonical provisioning JSON contains a non-JSON value",
  );
}

export async function aiSearchProvisioningSha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalAiSearchProvisioningJson(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
