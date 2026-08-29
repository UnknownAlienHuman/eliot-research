import type { FederationApiV1 } from "@eliotr/interfaces";

export class FederationImplementationPendingError extends Error {
  public constructor() {
    super("ER-22 generic federation boundary is not implemented");
    this.name = "FederationImplementationPendingError";
  }
}

export function createFederationService(): FederationApiV1 {
  throw new FederationImplementationPendingError();
}
