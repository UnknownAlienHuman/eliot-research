import { createResearchFailureDecoder, type LegacyErrorFactory } from "@eliotr/owner-api-client";
import { ApiRequestError } from "@eliotr/pwa-http-client";

export type {
  ResearchEngineStatus,
  ResearchRunFailureCode,
  ResearchRunFailureContext,
  ResearchRunFailureView,
} from "@eliotr/owner-api-client";

/** Preserve legacy names and errors while using the single strict, versioned owner parser. */
const errors: LegacyErrorFactory = details => new ApiRequestError(details);
const decoder = createResearchFailureDecoder(errors);
export const engineStatus = decoder.engineStatus;
export const researchRunFailure = decoder.researchRunFailure;
