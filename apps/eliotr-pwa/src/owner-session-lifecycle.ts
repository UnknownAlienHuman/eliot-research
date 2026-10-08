import { isOwnerSessionUnexpired, type OwnerSession } from "./owner-session-api.js";

export interface OwnerSessionLifecycleOptions {
  readonly deploymentGeneration: () => string | undefined;
  readonly healthReady: () => boolean;
  readonly onVerified: (session: OwnerSession, deploymentGeneration: string) => void;
  readonly onCleared: () => void;
  readonly refreshReadPanes: () => void;
}

/** Fences session callbacks and refreshes read panes only after the namespace check completes. */
export function createOwnerSessionLifecycle(options: OwnerSessionLifecycleOptions) {
  let verifiedSession: OwnerSession | undefined;
  let verifiedGeneration: string | undefined;
  return {
    onVerified(session: OwnerSession, deploymentGeneration: string): void {
      verifiedSession = session;
      verifiedGeneration = deploymentGeneration;
      options.onVerified(session, deploymentGeneration);
    },
    onCleared(): void {
      verifiedSession = undefined;
      verifiedGeneration = undefined;
      options.onCleared();
    },
    onExpired(): void {
      window.dispatchEvent(new Event("eliotr:authorization-cleared"));
    },
    onResumed(session: OwnerSession, deploymentGeneration: string): void {
      if (session !== verifiedSession || deploymentGeneration !== verifiedGeneration ||
          deploymentGeneration !== options.deploymentGeneration() || !options.healthReady() ||
          !isOwnerSessionUnexpired(session)) return;
      options.refreshReadPanes();
    },
  };
}
