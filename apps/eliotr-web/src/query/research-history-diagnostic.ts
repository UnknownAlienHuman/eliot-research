import type { PrivacyController, SessionContext } from "../app/privacy";
import { ProtectedReadClosedError, runProtectedRead } from "./client";

export type ResearchHistoryReadOutcome =
  | "resolved"
  | "api_rejected"
  | "protected_read_rejected_before_api"
  | "protected_read_rejected_after_api";

export type ResearchHistoryDiagnosticCode =
  | "NONE"
  | "PROTECTED_READ_CLOSED"
  | "API_SESSION_CLOSED"
  | "API_GENERATION_MISMATCH"
  | "API"
  | "RUNTIME"
  | "RESEARCH"
  | "OTHER_TYPED"
  | "UNTYPED";

export type ResearchHistoryDiagnosticStatus =
  | "NONE"
  | "HTTP_4XX"
  | "HTTP_5XX"
  | "HTTP_OTHER"
  | "INVALID";

export interface ResearchHistoryReadDiagnostic {
  readonly protocol: "eliotr.research-history-read-diagnostic.v1";
  readonly outcome: ResearchHistoryReadOutcome;
  readonly typedCode: ResearchHistoryDiagnosticCode;
  readonly status: ResearchHistoryDiagnosticStatus;
  readonly privacyPhase: "verifying" | "available" | "unavailable" | "unknown";
  readonly privacyRevision: number | null;
  readonly privacyCurrent: boolean;
  readonly apiReadStarted: boolean;
  readonly apiReadResolved: boolean;
  readonly signalAborted: boolean;
}

/** Observers receive fixed, non-identifying metadata only. */
export type ResearchHistoryReadDiagnosticObserver = (event: ResearchHistoryReadDiagnostic) => unknown;

interface ReadInput<T> {
  readonly privacy: PrivacyController;
  readonly context: SessionContext;
  readonly signal: AbortSignal;
  readonly read: (signal: AbortSignal) => Promise<T>;
  readonly observer?: ResearchHistoryReadDiagnosticObserver;
}

function ownDataProperty(value: unknown, key: "code" | "status"): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function diagnosticCode(error: unknown): ResearchHistoryDiagnosticCode {
  if (error instanceof ProtectedReadClosedError) return "PROTECTED_READ_CLOSED";
  const code = ownDataProperty(error, "code");
  if (typeof code !== "string" || code.length === 0) return "UNTYPED";
  if (code === "API_SESSION_CLOSED") return "API_SESSION_CLOSED";
  if (code === "API_GENERATION_MISMATCH") return "API_GENERATION_MISMATCH";
  if (code.startsWith("API_")) return "API";
  if (code.startsWith("RUNTIME_")) return "RUNTIME";
  if (code.startsWith("RESEARCH_")) return "RESEARCH";
  return "OTHER_TYPED";
}

function diagnosticStatus(error: unknown): ResearchHistoryDiagnosticStatus {
  const status = ownDataProperty(error, "status");
  if (typeof status !== "number") return "NONE";
  if (!Number.isInteger(status) || status < 100 || status > 599) return "INVALID";
  if (status >= 400 && status <= 499) return "HTTP_4XX";
  if (status >= 500) return "HTTP_5XX";
  return "HTTP_OTHER";
}

function safePrivacyState(privacy: PrivacyController, context: SessionContext) {
  let privacyPhase: ResearchHistoryReadDiagnostic["privacyPhase"] = "unknown";
  let privacyRevision: number | null = null;
  let privacyCurrent = false;
  try {
    const snapshot = privacy.getSnapshot();
    privacyPhase = snapshot.phase === "verifying" || snapshot.phase === "available" || snapshot.phase === "unavailable"
      ? snapshot.phase
      : "unknown";
    privacyRevision = Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0 ? snapshot.revision : null;
  } catch {
    // Diagnostics must not participate in the protected read's outcome.
  }
  try {
    privacyCurrent = privacy.isCurrent(context) === true;
  } catch {
    // Diagnostics must not participate in the protected read's outcome.
  }
  return { privacyPhase, privacyRevision, privacyCurrent };
}

function notifySafely(observer: ResearchHistoryReadDiagnosticObserver, event: ResearchHistoryReadDiagnostic) {
  try {
    const result = observer(Object.freeze(event));
    if (result !== null && (typeof result === "object" || typeof result === "function")) {
      try {
        if (typeof (result as { then?: unknown }).then === "function") {
          void Promise.resolve(result).catch(() => undefined);
        }
      } catch {
        // Ignore diagnostic thenables with throwing accessors.
      }
    }
  } catch {
    // An optional observer cannot change a successful read or replace its rejection.
  }
}

/** Wraps the actual protected history read while preserving its value and exact rejection. */
export async function readResearchRunHistoryWithDiagnostic<T>(input: ReadInput<T>): Promise<T> {
  if (!input.observer) {
    return runProtectedRead(input.privacy, input.context, input.signal, input.read);
  }

  let apiReadStarted = false;
  let apiReadResolved = false;
  const emit = (outcome: ResearchHistoryReadOutcome, error?: unknown) => {
    const privacy = safePrivacyState(input.privacy, input.context);
    let signalAborted = false;
    try { signalAborted = input.signal.aborted === true; } catch { /* Keep diagnostics fail-soft. */ }
    notifySafely(input.observer!, {
      protocol: "eliotr.research-history-read-diagnostic.v1",
      outcome,
      typedCode: outcome === "resolved" ? "NONE" : diagnosticCode(error),
      status: outcome === "resolved" ? "NONE" : diagnosticStatus(error),
      ...privacy,
      apiReadStarted,
      apiReadResolved,
      signalAborted,
    });
  };

  try {
    const result = await runProtectedRead(input.privacy, input.context, input.signal, async readSignal => {
      apiReadStarted = true;
      const value = await input.read(readSignal);
      apiReadResolved = true;
      return value;
    });
    emit("resolved");
    return result;
  } catch (error) {
    const outcome: ResearchHistoryReadOutcome = !apiReadStarted
      ? "protected_read_rejected_before_api"
      : apiReadResolved
        ? "protected_read_rejected_after_api"
        : "api_rejected";
    emit(outcome, error);
    throw error;
  }
}
