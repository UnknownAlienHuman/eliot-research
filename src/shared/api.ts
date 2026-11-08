import type { ModelSpec } from "../models";
import type { DistillState } from "../understanding";

export type DataCollectionPolicy = "deny" | "allow";

export function isOpenRouterApiBase(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value.trim());
    return url.origin === "https://openrouter.ai" && url.pathname.replace(/\/+$/, "") === "/api/v1"
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export interface DistillInput { revisionId: string; model: ModelSpec; attemptId?: string | null }

export type NativeReasoningEffort = "low" | "high";
export interface UnderstandingInput {
  revisionId?: string | undefined;
  saveAvailable?: boolean | undefined;
  model?: string | undefined;
  nativeReasoningEffort?: NativeReasoningEffort | undefined;
  retry?: { attemptId: string; previousAttemptId: string } | undefined;
}

export interface OwnerActor {
  type: "owner";
  id: string;
  email?: string;
  authentication: "access" | "local" | "service-token";
}
export interface AgentActor {
  type: "agent";
  id: string;
  authentication: "service-token";
}

export interface MeResponse {
  actor: OwnerActor;
}

export interface Project {
  id: string;
  title: string;
  description: string;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  instructions?: string;
  answerModel?: string | null;
}

export interface Source {
  enabled?: boolean;
  id: string;
  title: string;
  kind: "file" | "url" | "text";
  currentRevisionId: string | null;
  revisionId: string;
  readableState: "pending" | "readable" | "readable_with_warnings" | "needs_conversion" | "failed";
  distillState: DistillState;
  claimCount: number;
  originalFilename: string | null;
  originalSize: number;
  readableSize: number | null;
  blockCount: number | null;
  warningSummary: string | null;
  error: string | null;
  converter: string | null;
  conversionTokens: number | null;
  conversionCalls: number;
  conversionMs: number | null;
  createdAt: number;
}

export interface Revision extends Pick<Source, "converter" | "conversionTokens" | "conversionCalls" | "conversionMs" | "warningSummary" | "error"> {
  id: string;
  revisionNo: number;
  readableState: Source["readableState"];
  createdAt: number;
  originalMime?: string | null;
  originalSha256?: string | null;
  originalSize?: number | null;
}

export const OCR_LIMITS = { maxPages: 1000, pageBytes: 1024 * 1024, pagePixels: 4_000_000,
  renderLongEdge: 2000, pageTimeoutMs: 90_000, previewBytes: 25 * 1024 * 1024 } as const;
export function ocrOutputLimit(model: Pick<ModelSpec, "outputReserveTokens" | "maxOutputTokens"> | undefined): number | null {
  const output = model?.outputReserveTokens ?? model?.maxOutputTokens;
  if (output == null || !Number.isSafeInteger(output) || output <= 0) return null;
  const capacity = model?.maxOutputTokens;
  if (capacity != null && (!Number.isSafeInteger(capacity) || capacity <= 0)) return null;
  const reserve = capacity == null ? output : Math.max(output, 16_384);
  return Math.min(reserve, capacity ?? reserve);
}
export type OcrState = "preparing" | "queued" | "running" | "ready" | "failed" | "cancelled" | "applied";
export interface OcrJobView {
  id: string;
  projectId: string;
  sourceId: string;
  baseRevisionId: string;
  state: OcrState;
  modelRoute: string;
  modelLabel: string;
  pageCount: number;
  uploadedPages: number[];
  completedPages: number;
  calls: number;
  tokenLimit: number;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  deadlineAt: number | null;
  error: string | null;
  appliedRevisionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApiError {
  error: {
    code: "invalid" | "not_found" | "conflict" | "busy" | "unavailable" | "budget";
    message: string;
  };
}

export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
}

/** Advisory UTF-16 character ranges in the answer, never source byte ranges. */
export interface AnswerWarning {
  start: number;
  end: number;
  kind: "missing-citation" | "unsupported-number";
}

export interface TurnView {
  turnId: string;
  /** Read/stream metadata from the owning DO row; not part of model history. */
  createdAt?: number;
  historyVersion?: number;
  question: string;
  /** Original accepted request, retained when a queued question never started. */
  input?: RunTurnInput;
  answer: string;
  state: "started" | "completed" | "partial" | "failed" | "cancelled";
  model: string;
  scopeMode: "project_default" | "explicit" | "empty";
  contextMode?: "whole" | "claims" | "none";
  /** Storage-backed disclosure when older exchanges yielded room to sources and the latest exchange. */
  historyNotice?: string;
  revisionIds: string[];
  sourceIds: string[];
  citations: Citation[];
  invalidLabels: number;
  /** Diagnostic-only rejected marker samples (<=8, each <=160 chars). Stored in turn JSON only. */
  invalidLabelExamples?: string[];
  warnings?: AnswerWarning[];
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  providerUsage?: ProviderUsage | null;
  /** Local per-turn generation cap; independent of catalogue metadata and reported usage. */
  outputBudget?: { requestedTokens: number; appliedTokens: number };
  tokenLimit: number | null;
  tokenLimitKind?: "published" | "unknown" | "legacy";
  firstTokenMs: number | null;
  totalMs: number | null;
  error: string | null;
  /** Owning DO result still awaits confirmation of its D1 accounting projection. */
  settlementPending?: true;
  settlementError?: string;
}

export interface TurnPage { turns: TurnView[]; nextCursor: string | null }
export interface ChatSnapshotState { stateVersion: number; queued: { turnId: string; question: string } | null; settlementError: string | null }

export interface RunTurnInput {
  projectId: string;
  chatId: string;
  turnId: string;
  question: string;
  scopeMode: TurnView["scopeMode"];
  sourceIds?: string[];
  model?: string;
}
export interface SourceSelection {
  scopeMode: TurnView["scopeMode"];
  sourceIds: readonly string[];
}
import type { Citation } from "../citations";

export interface ProposalSummary {
  revisionId: string;
  pageId: string;
  title: string;
  kind: "note" | "answer" | "report" | "wiki";
  status: "proposed" | "accepted" | "rejected";
  actor: string;
  createdAt: number;
  headRevisionId: string | null;
  baseRevisionId: string | null;
}
export interface ProposalView extends ProposalSummary {
  body: string;
  citations: Citation[];
  revisionIds: string[];
}

