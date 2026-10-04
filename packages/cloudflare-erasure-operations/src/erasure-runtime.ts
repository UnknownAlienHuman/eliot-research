import {
  createConfiguredErasureBackend,
  type CloudflareErasureDependencies,
} from "@eliotr/cloudflare-erasure";
import type { ErasureReceipt, ErasureRequest } from "@eliotr/contracts";
import { createErasureCoordinator, type ErasureCoordinator } from "./erasure-coordinator.js";

export interface ErasureOperationsActor {
  readonly principal_ref: string;
  readonly credential_generation: string;
}

export interface ErasureDatabaseRuntime {
  readonly database: D1Database;
}

export interface ErasureOwnerServiceRuntime extends ErasureDatabaseRuntime {
  readonly coordinator: ErasureCoordinator;
}

export interface ErasureOwnerService {
  execute(actor: ErasureOperationsActor, request: ErasureRequest): Promise<ErasureReceipt>;
}

export type ErasureConfiguredCoordinatorDependencies = CloudflareErasureDependencies;

export function createConfiguredErasureCoordinator(
  dependencies: ErasureConfiguredCoordinatorDependencies,
): ErasureCoordinator {
  return createErasureCoordinator(createConfiguredErasureBackend(dependencies));
}
