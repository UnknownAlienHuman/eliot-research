import type { ModelSpec } from "../models";

export interface DistillInput { revisionId: string; model: ModelSpec }

export interface OwnerActor {
  type: "owner";
  id: string;
  email?: string;
  authentication: "access" | "local" | "service-token";
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
  readableState: Source["readableState"];
  createdAt: number;
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
  costUsd: number | null;
}

export interface TurnView {
  turnId: string;
  question: string;
  answer: string;
  state: "started" | "completed" | "partial" | "failed" | "cancelled";
  model: string;
  scopeMode: "project_default" | "explicit" | "empty";
  contextMode?: "whole" | "claims" | "none";
  revisionIds: string[];
  sourceIds: string[];
  citations: Citation[];
  invalidLabels: number;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  providerUsage?: ProviderUsage | null;
  estimatedCostMicrousd: number | null;
  firstTokenMs: number | null;
  totalMs: number | null;
  error: string | null;
}

export interface RunTurnInput {
  projectId: string;
  chatId: string;
  turnId: string;
  question: string;
  scopeMode: TurnView["scopeMode"];
  sourceIds?: string[];
  model?: string;
}
import type { Citation } from "../citations";

