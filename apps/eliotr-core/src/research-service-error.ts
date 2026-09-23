import { CatalogInputError } from "./catalog-service.js";

export class ResearchServiceError extends CatalogInputError {}

export function failResearch(code: string, message: string, status = 400, retryable = false): never {
  throw new ResearchServiceError(code, message, status, retryable);
}
