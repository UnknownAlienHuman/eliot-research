import type { ModelAttemptStore } from "./model-attempt-types.js";
import { createModelAttemptReservationStore } from "./model-attempt-reservation-store.js";
import { createModelAttemptSettlementStore } from "./model-attempt-settlement-store.js";

export function createModelAttemptStore(
  database: D1Database,
  now: () => string = () => new Date().toISOString(),
): ModelAttemptStore {
  const settlement = createModelAttemptSettlementStore(database, now);
  const reservation = createModelAttemptReservationStore(database, now, settlement);
  return Object.freeze({ ...reservation, ...settlement });
}

export { validatedRequest } from "./model-attempt-store-common.js";
export type {
  ModelAttemptAuthority,
  ModelAttemptReadback,
  ModelAttemptReservation,
  ModelAttemptReservationInput,
  ModelAttemptSettlementInput,
  ModelAttemptStart,
  ModelCostQuote,
  ModelOutputBinding,
} from "./model-attempt-types.js";
export { ModelAttemptError } from "./model-attempt-types.js";