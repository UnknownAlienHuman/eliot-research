/**
 * Controlled durable inputs, boundary injectors, and durable authority reads
 * for the S91.6 managed generation promotion transaction test.
 *
 * Every helper binds the production registry service and the production D1
 * registry store to the actual migrated SEARCH_DB. The probes only count
 * compare-and-swap calls, order one genuine competing durable write, or
 * remove an acknowledgement or a readback after a genuine commit already
 * resolved. They never replace a database binding, a store read or write, or a
 * service result, and they never fabricate a persisted artifact or receipt.
 *
 * Registry rows stay on a run-scoped namespace. The whole-91.6
 * purge-preserving rollback sits outside this fixture.
 */

import {
  AiSearchGenerationError,
  AiSearchGenerationRegistryError,
  AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
  createAiSearchGenerationRegistryService,
  createD1AiSearchGenerationRegistryStore,
  type AiSearchGenerationDeclaration,
  type AiSearchGenerationRegistryCasCommand,
  type AiSearchGenerationRegistryService,
  type AiSearchGenerationRegistrySnapshot,
  type AiSearchGenerationRegistryStorePort,
  type AiSearchPromotionRequest,
  type AiSearchShadowObservation,
} from "@eliotr/cloudflare-ai";

const DECLARED_AT = "2026-10-11T18:00:00.000Z";
const OBSERVED_AT = "2026-10-11T18:01:00.000Z";
const PROMOTED_AT = "2026-10-11T18:02:00.000Z";
const EXPECTED_ITEM_COUNT = 1;

/** Keeps each pass on its own durable registry namespace row. */
export const RUN_TAG = `s916-${Date.now().toString(36)}`;

export type GenerationSlot = "alpha" | "beta";

export interface GenerationIdentity {
  readonly caseName: string;
  readonly slot: GenerationSlot;
  readonly namespace: string;
  readonly generation: string;
  readonly profile: typeof AI_SEARCH_PRIMARY_PROJECTION_PROFILE;
}

export function namespaceFor(caseName: string): string {
  return `eliotr-${RUN_TAG}-${caseName}`;
}

export function generationIdentity(
  caseName: string,
  slot: GenerationSlot,
): GenerationIdentity {
  const generation = `${RUN_TAG}-${slot}`;
  return Object.freeze({
    caseName,
    slot,
    namespace: namespaceFor(caseName),
    generation,
    profile: Object.freeze({
      ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
      id: `${RUN_TAG}-${slot}`,
      generation,
    }),
  });
}

export function declarationFor(
  identity: GenerationIdentity,
): AiSearchGenerationDeclaration {
  return Object.freeze({
    namespace: identity.namespace,
    profile: identity.profile,
    expected_item_count: EXPECTED_ITEM_COUNT,
    declared_at: DECLARED_AT,
  });
}

export function observationFor(
  identity: GenerationIdentity,
  overrides: Partial<AiSearchShadowObservation> = {},
): AiSearchShadowObservation {
  return Object.freeze({
    generation: identity.generation,
    indexed_item_count: EXPECTED_ITEM_COUNT,
    readback_item_count: EXPECTED_ITEM_COUNT,
    failed_item_count: 0,
    mismatch_count: 0,
    golden_set_result_ref: `golden-${identity.slot}`,
    observed_at: OBSERVED_AT,
    ...overrides,
  });
}

export function promotionFor(
  identity: GenerationIdentity,
  expectedActiveHeadGeneration: string | null,
  promotedAt: string = PROMOTED_AT,
): AiSearchPromotionRequest {
  return Object.freeze({
    expected_active_head_generation: expectedActiveHeadGeneration,
    target_generation: identity.generation,
    promoted_at: promotedAt,
  });
}

export type RegistryFaultMode = "NONE" | "LOST_ACKNOWLEDGEMENT" | "MISSING_READBACK";

export interface RegistryStoreProbeOptions {
  readonly fault?: RegistryFaultMode;
  readonly beforeCompareAndSwap?: () => Promise<void>;
}

export interface RegistryStoreProbe {
  readonly store: AiSearchGenerationRegistryStorePort;
  readonly compareAndSwapCalls: () => number;
}

export function registryService(
  database: D1Database,
): AiSearchGenerationRegistryService {
  return createAiSearchGenerationRegistryService(
    createD1AiSearchGenerationRegistryStore(database),
  );
}

export interface CountingRegistryProbe {
  readonly service: AiSearchGenerationRegistryService;
  readonly compareAndSwapCalls: () => number;
}

export function registryStoreProbe(
  database: D1Database,
  options: RegistryStoreProbeOptions = {},
): RegistryStoreProbe {
  const genuine = createD1AiSearchGenerationRegistryStore(database);
  let compareAndSwapCalls = 0;
  let entryHook = options.beforeCompareAndSwap;
  let lostAcknowledgementPending = options.fault === "LOST_ACKNOWLEDGEMENT";
  const missingReadbackPending = options.fault === "MISSING_READBACK";
  const store: AiSearchGenerationRegistryStorePort = Object.freeze({
    async read(namespace: string): Promise<unknown | null> {
      const row = await genuine.read(namespace);
      if (missingReadbackPending && compareAndSwapCalls > 0) {
        // Sustained: this probe never recovers the readback, so the service
        // cannot reconcile and the write stays uncertain.
        throw new Error(
          "controlled readback loss after a committed registry compare-and-swap",
        );
      }
      return row;
    },
    async compareAndSwap(
      command: AiSearchGenerationRegistryCasCommand,
    ): Promise<unknown> {
      compareAndSwapCalls += 1;
      const entering = entryHook;
      if (entering !== undefined) {
        entryHook = undefined;
        await entering();
      }
      const receipt = await genuine.compareAndSwap(command);
      if (lostAcknowledgementPending) {
        lostAcknowledgementPending = false;
        throw new Error(
          "controlled acknowledgement loss after a committed registry compare-and-swap",
        );
      }
      return receipt;
    },
  });
  return Object.freeze({ store, compareAndSwapCalls: () => compareAndSwapCalls });
}

export function countingRegistryService(
  database: D1Database,
  options: RegistryStoreProbeOptions = {},
): CountingRegistryProbe {
  const probe = registryStoreProbe(database, options);
  return Object.freeze({
    service: createAiSearchGenerationRegistryService(probe.store),
    compareAndSwapCalls: probe.compareAndSwapCalls,
  });
}

export async function durableRegistryRead(
  database: D1Database,
  namespace: string,
): Promise<AiSearchGenerationRegistrySnapshot | null> {
  return registryService(database).read(namespace);
}

export interface RegistryFailure {
  readonly code: string;
  readonly retryable: boolean;
  readonly ambiguousEffect: string;
}

/** Captures the exact production refusal of a refused registry operation. */
export async function capturedFailure(
  action: () => Promise<unknown>,
): Promise<RegistryFailure> {
  try {
    await action();
  } catch (error) {
    if (error instanceof AiSearchGenerationRegistryError) {
      return Object.freeze({
        code: error.code,
        retryable: error.retryable,
        ambiguousEffect: error.ambiguous_effect,
      });
    }
    if (error instanceof AiSearchGenerationError) {
      return Object.freeze({
        code: error.code,
        retryable: false,
        ambiguousEffect: "NONE",
      });
    }
    throw error;
  }
  throw new Error("expected the registry operation to be refused");
}
