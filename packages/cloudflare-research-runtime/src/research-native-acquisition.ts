import type { InquiryProtocolProfile } from "@eliotr/contracts";
import { decodeProtocolScopeCheckpoint, fail } from "@eliotr/cloudflare-research";
import {
  MAX_WORKFLOW_OUTPUT_BYTES,
  type WorkflowStartedAttemptRecovery,
  type WorkflowStageHandler,
} from "@eliotr/cloudflare-workflows";
import {
  createNativeWebSearchAdapter,
  createNativeWebSearchMarkdownCaptureAdapter,
  NATIVE_WEB_SEARCH_MAX_RESULTS,
  type NativeWebSearchBinding,
  type NativeWebSearchCaptureSelection,
  type NativeWebSearchOutcome,
  type NativeWebSearchRawCaptureOwnerPort,
  type NativeWebSearchRawCaptureOutcome,
} from "@eliotr/platform-cloudflare";

export const RESEARCH_NATIVE_ACQUISITION_STAGE_PROTOCOL = "eliotr.research-native-acquisition-stage.v1" as const;

type WebSourceMode = Exclude<InquiryProtocolProfile["source_mode"], "corpus_only">;

/**
 * Strict, server-owned selection required to build the existing acquisition stage route.
 * The caller must resolve this from the immutable run configuration; this helper never
 * chooses a provider, gateway, BYOK alias, result limit, or Browser Markdown policy.
 */
export interface ResearchNativeAcquisitionSelection extends NativeWebSearchCaptureSelection {
  readonly source_mode: WebSourceMode;
  readonly result_limit: number;
}

export type ResearchNativeAcquisitionBrowser =
  Parameters<typeof createNativeWebSearchMarkdownCaptureAdapter>[0]["browser"];

export interface ResearchNativeAcquisitionStageResult {
  readonly protocol: typeof RESEARCH_NATIVE_ACQUISITION_STAGE_PROTOCOL;
  readonly operation_id: string;
  readonly stage: "ACQUIRE_AND_CAPTURE";
  readonly attempt_ref: string;
  readonly input_sha256: string;
  readonly source_mode: WebSourceMode;
  /** Provider discovery remains locator metadata, never source text or an evidence verdict. */
  readonly discovery: NativeWebSearchOutcome;
  /** One entry per valid locator; failures stay attached to their URL index. */
  readonly captures: readonly {
    readonly locator_index: number;
    readonly outcome: NativeWebSearchRawCaptureOutcome;
  }[];
}

export interface ResearchNativeAcquisitionStageRoute {
  readonly source_mode: WebSourceMode;
  readonly handler: WorkflowStageHandler;
  /** Read-only recovery only. A missing exact stage result is left UNKNOWN, never redispatched. */
  readonly recoverStartedAttempt: WorkflowStartedAttemptRecovery;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function immutableSelection(value: ResearchNativeAcquisitionSelection): ResearchNativeAcquisitionSelection {
  if (!isRecord(value) || !hasExactKeys(value, ["source_mode", "result_limit", "search", "browser_markdown"]) ||
      (value.source_mode !== "corpus_plus_web" && value.source_mode !== "web_discovery") ||
      !Number.isSafeInteger(value.result_limit) || value.result_limit < 1 || value.result_limit > NATIVE_WEB_SEARCH_MAX_RESULTS ||
      !isRecord(value.search) || !isRecord(value.browser_markdown)) {
    return fail("WORKFLOW_CONFIGURATION_INVALID");
  }

  const selection = Object.freeze({
    source_mode: value.source_mode,
    result_limit: value.result_limit,
    search: Object.freeze({ ...value.search }),
    browser_markdown: Object.freeze({ ...value.browser_markdown }),
  }) as ResearchNativeAcquisitionSelection;
  return selection;
}

function encodeResult(result: ResearchNativeAcquisitionStageResult): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(result));
  if (bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) return fail("WORKFLOW_INPUT_INVALID");
  return bytes;
}

/**
 * Composes the low-level native transports into the existing ACQUIRE_AND_CAPTURE W2 stage.
 * `capture_owner` must be the exact capability issued by the source owner. It is deliberately
 * accepted as two narrow closures: this module never constructs AuthenticatedRequestContext,
 * infers an owner principal, or calls the owner service without its authorization boundary.
 */
export function createResearchNativeAcquisitionStageRoute(input: {
  readonly selection: ResearchNativeAcquisitionSelection;
  readonly websearch_binding: NativeWebSearchBinding | undefined;
  readonly browser: ResearchNativeAcquisitionBrowser;
  readonly capture_owner: NativeWebSearchRawCaptureOwnerPort | undefined;
}): ResearchNativeAcquisitionStageRoute {
  const selection = immutableSelection(input.selection);
  if (input.capture_owner === undefined || input.browser === undefined ||
      typeof input.browser.quickAction !== "function") {
    return fail("WORKFLOW_CONFIGURATION_MISSING");
  }

  let search: ReturnType<typeof createNativeWebSearchAdapter>;
  let capture: ReturnType<typeof createNativeWebSearchMarkdownCaptureAdapter>;
  try {
    search = createNativeWebSearchAdapter(input.websearch_binding, selection.search);
    capture = createNativeWebSearchMarkdownCaptureAdapter({
      browser: input.browser,
      owner: input.capture_owner,
      selection: {
        search: selection.search,
        browser_markdown: selection.browser_markdown,
      },
    });
  } catch {
    return fail("WORKFLOW_CONFIGURATION_INVALID");
  }

  const handler: WorkflowStageHandler = async (stageInput) => {
    if (stageInput.request.stage !== "ACQUIRE_AND_CAPTURE") return fail("WORKFLOW_INPUT_INVALID");

    let frozenProtocol;
    try {
      frozenProtocol = decodeProtocolScopeCheckpoint(stageInput.input_bytes);
    } catch {
      return fail("WORKFLOW_OUTPUT_CORRUPT");
    }
    if (frozenProtocol.operation_id !== stageInput.request.operation_id ||
        frozenProtocol.investigation_ref.id !== stageInput.request.investigation_ref.id ||
        frozenProtocol.principal_ref !== stageInput.principal.principal_ref ||
        frozenProtocol.protocol_profile.source_mode !== selection.source_mode) {
      return fail("WORKFLOW_AUTHORITY_STALE");
    }

    const attempt = Object.freeze({
      operation_id: stageInput.request.operation_id,
      stage: "ACQUIRE_AND_CAPTURE" as const,
      attempt_ref: stageInput.attempt_ref,
      input_sha256: stageInput.request.input_manifest.sha256,
    });
    const discovery = await search.discover({
      query: frozenProtocol.protocol_profile.question,
      limit: selection.result_limit,
      ...(stageInput.signal === undefined ? {} : { signal: stageInput.signal }),
    });

    const captures: { locator_index: number; outcome: NativeWebSearchRawCaptureOutcome }[] = [];
    if (discovery.disposition === "DISCOVERED") {
      for (let locatorIndex = 0; locatorIndex < discovery.locators.length; locatorIndex += 1) {
        const outcome = await capture.capture({
          attempt,
          discovery,
          locator_index: locatorIndex,
          ...(stageInput.signal === undefined ? {} : { signal: stageInput.signal }),
        });
        captures.push(Object.freeze({ locator_index: locatorIndex, outcome }));
      }
    }

    return encodeResult(Object.freeze({
      protocol: RESEARCH_NATIVE_ACQUISITION_STAGE_PROTOCOL,
      operation_id: attempt.operation_id,
      stage: attempt.stage,
      attempt_ref: attempt.attempt_ref,
      input_sha256: attempt.input_sha256,
      source_mode: selection.source_mode,
      discovery,
      captures: Object.freeze(captures),
    }));
  };

  // Native Web Search has no exact result lookup by Workflow attempt. The executor will
  // recover committed output by its existing exact object reference; absent bytes remain
  // UNKNOWN so neither Web Search nor Browser Run is silently invoked again.
  const recoverStartedAttempt: WorkflowStartedAttemptRecovery = async () => null;

  return Object.freeze({ source_mode: selection.source_mode, handler, recoverStartedAttempt });
}
