const PROJECT_SELECTION_FAILURE_CODES = new Set([
  "RESEARCH_PROJECT_MODEL_CONFIGURATION_OWNER_REQUIRED",
  "RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID",
  "RESEARCH_PROJECT_MODEL_CONFIGURATION_NOT_FOUND",
  "RESEARCH_PROJECT_MODEL_CONFIGURATION_AUTHORITY_CHANGED",
  "RESEARCH_PROJECT_MODEL_CONFIGURATION_AUTHORITY_STALE",
  "RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE",
  "RESEARCH_PROJECT_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED",
  "RESEARCH_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED",
]);

/** A narrowly classified project-service failure; arbitrary callback errors remain storage failures. */
export class ResearchRunProjectSelectionFailure extends Error {
  public constructor(
    public readonly code: string,
    public readonly status: number,
    cause: unknown,
  ) {
    super("Selected project configuration could not be resolved", { cause });
    this.name = "ResearchRunProjectSelectionFailure";
  }
}

/** Preserve only known project authority/configuration failures across the run-snapshot boundary. */
export function translateResearchProjectSelectionFailure(error: unknown): ResearchRunProjectSelectionFailure | null {
  if (!(error instanceof Error) || error.name !== "ResearchProjectModelConfigurationAuthorityError") return null;
  const code = "code" in error && typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as { readonly code: string }).code : "";
  const status = "status" in error && typeof (error as { readonly status?: unknown }).status === "number"
    ? (error as { readonly status: number }).status : NaN;
  if (!PROJECT_SELECTION_FAILURE_CODES.has(code) || !Number.isInteger(status) || status < 400 || status > 599) return null;
  return new ResearchRunProjectSelectionFailure(code, status, error);
}
