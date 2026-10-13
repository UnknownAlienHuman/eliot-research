/** ER-335 mutation-outcome classifier: the single owner-client presentation boundary. */

export {
  classifyMutationOutcome,
  classifyMutationSuccess,
  OPERATION_REJECTIONS,
  SETTLEMENT_UNCERTAIN_CODES,
  PRE_EFFECT_TRANSPORT_CODES,
  UNCONFIRMED_TRANSPORT_CODES,
  AUTHORIZATION_LOSS_CODES,
} from "./mutation-outcome";
export type {
  MutationOutcomeClass,
  MutationOutcomeAction,
  MutationOutcomeClassification,
  MutationOutcomeInput,
  MutationOutcomeSuccessInput,
} from "./mutation-outcome";

