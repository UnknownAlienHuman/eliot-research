import { ApiRequestError } from "./api.js";

export interface ResearchStatusRetryContext {
  readonly automatic: boolean;
  readonly requestedId: string;
  readonly workflowId: string | undefined;
  readonly expectedGeneration: string | undefined;
  readonly isCurrent: () => boolean;
  readonly currentGeneration: () => string | undefined;
  readonly healthReady: () => boolean;
  readonly online: () => boolean;
  readonly visible: () => boolean;
}

export function shouldRetryResearchAuthority(error: unknown, context: ResearchStatusRetryContext): boolean {
  if (!context.automatic || !context.isCurrent()) return false;
  if (!context.healthReady() || !context.online() || !context.visible()) return false;
  if (context.workflowId !== context.requestedId) return false;
  if (context.currentGeneration() !== context.expectedGeneration) return false;
  return error instanceof ApiRequestError && error.status === 409 && error.code === "RESEARCH_AUTHORITY_STALE";
}

export async function readResearchStatusWithAuthorityRetry<T>(
  read: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  onRetry: () => void,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!shouldRetry(error)) throw error;
    onRetry();
    return read();
  }
}

export function finishResearchStatusRead(
  isCurrent: boolean,
  clearController: () => void,
  disposed: boolean,
  clearActions: () => void,
  updateButtons: () => void,
  scheduleStatusRefresh: () => void,
): void {
  if (!isCurrent) return;
  clearController();
  if (!disposed) clearActions();
  updateButtons();
  scheduleStatusRefresh();
}
