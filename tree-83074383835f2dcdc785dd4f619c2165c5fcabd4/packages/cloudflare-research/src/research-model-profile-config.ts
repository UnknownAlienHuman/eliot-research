import {
  ModelProfileBindingError,
  type ModelProfileBindingSource,
} from "./research-model-profile-binding.js";

/** The Worker configuration binding consumed by the server-owned profile source. */
export const MODEL_PROFILE_DEFINITION_JSON_ENV = "ELIOTR_MODEL_PROFILE_DEFINITION_JSON" as const;

export interface ModelProfileDefinitionConfigSourceOptions {
  /** The raw value of MODEL_PROFILE_DEFINITION_JSON_ENV, if installed. */
  readonly raw: string | undefined;
  /** The server-owned provenance label expected by the strict profile producer. */
  readonly provenance_ref: string;
}

function invalid(message: string, cause?: unknown): never {
  throw new ModelProfileBindingError(
    "MODEL_PROFILE_BINDING_CONFIG_INVALID",
    message,
    false,
    cause,
  );
}

function source(provenanceRef: string, read: ModelProfileBindingSource["read"]): ModelProfileBindingSource {
  return Object.freeze({ provenance_ref: provenanceRef, read });
}

/**
 * Creates the single-definition source used by the production profile producer.
 * Structural and digest validation remains in createModelProfileBindingProducer;
 * this adapter only decodes the explicitly installed Worker configuration.
 */
export function createModelProfileBindingConfigSource(
  options: ModelProfileDefinitionConfigSourceOptions,
): ModelProfileBindingSource {
  if (typeof options !== "object" || options === null || typeof options.provenance_ref !== "string" ||
      options.provenance_ref.length === 0) {
    invalid("model profile configuration provenance is invalid");
  }
  if (options.raw === undefined) {
    return source(options.provenance_ref, async () => null);
  }
  if (typeof options.raw !== "string") {
    invalid("model profile configuration must be a JSON string");
  }
  if (options.raw.trim() === "") {
    return source(options.provenance_ref, async () => null);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(options.raw);
  } catch (cause) {
    invalid("model profile configuration is not valid JSON", cause);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalid("model profile configuration must contain one definition object");
  }
  const serialized = JSON.stringify(parsed);
  if (serialized === undefined) invalid("model profile configuration cannot be serialized");
  return source(options.provenance_ref, async (requestedRef) => {
    // A Worker has one installed definition. The strict producer compares its
    // profile reference and all other fields against the persisted stage.
    void requestedRef;
    return JSON.parse(serialized) as unknown;
  });
}
