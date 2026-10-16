import {
  ResearchCatalogModelUseReceiptSchema,
  ResearchCatalogModelUseRequestSchema,
  type ResearchCatalogModelUseReceipt,
  type ResearchCatalogModelUseRequest,
} from "@eliotr/contracts";
import type { LegacyErrorFactory, LegacyHttpAdapter } from "../legacy/http";
import type { EpochPort } from "../transport/client";

const PATH = "/api/v1/research/projects";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface ResearchCatalogModelUseApi {
  /** GET the active unresolved operation for this owner/project; null permits a new choice. */
  readCurrentResearchCatalogModelUse(
    projectId: string,
    expectedGeneration: string,
    signal?: AbortSignal,
  ): Promise<ResearchCatalogModelUseReceipt | null>;
  startResearchCatalogModelUse(
    projectId: string,
    expectedGeneration: string,
    request: ResearchCatalogModelUseRequest,
    signal?: AbortSignal,
  ): Promise<ResearchCatalogModelUseReceipt>;
  readResearchCatalogModelUse(
    projectId: string,
    expectedGeneration: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ResearchCatalogModelUseReceipt>;
}

export function createResearchCatalogModelUseApi(
  http: Pick<LegacyHttpAdapter, "requestApiWithStatuses">,
  errors: LegacyErrorFactory,
  epoch: EpochPort,
): ResearchCatalogModelUseApi {
  const invalid = (message: string): never => {
    throw errors({ status: 400, code: "RESEARCH_CATALOG_MODEL_USE_INPUT_INVALID", message,
      traceId: null, retryable: false });
  };
  function mismatch(message: string): never {
    throw errors({ status: 502, code: "API_RESPONSE_SCHEMA_MISMATCH", message,
      traceId: null, retryable: false });
  }
  const current = (): object => {
    const captured = epoch.capture();
    if (captured === undefined || !epoch.isCurrent(captured)) {
      throw errors({ status: 503, code: "API_SESSION_CLOSED", message: "Owner session is not current",
        traceId: null, retryable: false });
    }
    return captured;
  };
  const assertCurrent = (captured: object): void => {
    if (!epoch.isCurrent(captured)) {
      throw errors({ status: 503, code: "API_SESSION_CLOSED", message: "Response belongs to a closed owner session",
        traceId: null, retryable: false });
    }
  };
  const validateContext = (projectId: string, generation: string): void => {
    if (!IDENTIFIER.test(projectId) || !IDENTIFIER.test(generation)) invalid("Project or deployment identity is invalid");
  };
  const path = (projectId: string): string => `${PATH}/${encodeURIComponent(projectId)}/catalog-model-use`;

  function decode(raw: unknown, projectId: string, generation: string, nullable: true): ResearchCatalogModelUseReceipt | null;
  function decode(raw: unknown, projectId: string, generation: string, nullable?: false): ResearchCatalogModelUseReceipt;
  function decode(raw: unknown, projectId: string, generation: string, nullable = false): ResearchCatalogModelUseReceipt | null {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) mismatch("Catalog model-use envelope is invalid");
    const envelope = raw as Record<string, unknown>;
    if (Object.keys(envelope).length !== 3 || !Object.hasOwn(envelope, "data") ||
        !Object.hasOwn(envelope, "trace_id") || !Object.hasOwn(envelope, "deployment_generation")) {
      mismatch("Catalog model-use envelope has missing or unknown fields");
    }
    const traceId = typeof envelope.trace_id === "string" && TRACE_ID.test(envelope.trace_id)
      ? envelope.trace_id : mismatch("Catalog model-use trace is invalid");
    if (envelope.deployment_generation !== generation) {
      throw errors({ status: 409, code: "API_GENERATION_MISMATCH", message: "Deployment changed during model qualification",
        traceId, retryable: true });
    }
    if (nullable && envelope.data === null) return null;
    const parsed = ResearchCatalogModelUseReceiptSchema.safeParse(envelope.data);
    const data = parsed.success ? parsed.data : mismatch("Catalog model-use receipt identity is invalid");
    if (data.project_id !== projectId) mismatch("Catalog model-use receipt identity is invalid");
    return data;
  }

  const api: ResearchCatalogModelUseApi = {
    async readCurrentResearchCatalogModelUse(projectId, expectedGeneration, signal) {
      const captured = current();
      validateContext(projectId, expectedGeneration);
      const raw = await http.requestApiWithStatuses(path(projectId), {
        method: 'GET', ...(signal === undefined ? {} : { signal }),
      }, [200]);
      assertCurrent(captured);
      return decode(raw, projectId, expectedGeneration, true);
    },
    async startResearchCatalogModelUse(projectId, expectedGeneration, request, signal) {
      const captured = current();
      validateContext(projectId, expectedGeneration);
      const parsed = ResearchCatalogModelUseRequestSchema.safeParse(request);
      const body = parsed.success ? parsed.data : invalid("Catalog model-use request is invalid");
      const raw = await http.requestApiWithStatuses(path(projectId), {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": body.operation_id,
          "x-eliotr-csrf": "1" },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      }, [200, 202]);
      assertCurrent(captured);
      return decode(raw, projectId, expectedGeneration);
    },
    async readResearchCatalogModelUse(projectId, expectedGeneration, operationId, signal) {
      const captured = current();
      validateContext(projectId, expectedGeneration);
      if (!OPERATION_ID.test(operationId)) invalid("Catalog model-use operation ID is invalid");
      const raw = await http.requestApiWithStatuses(`${path(projectId)}/${encodeURIComponent(operationId)}`, {
        method: "GET",
        ...(signal === undefined ? {} : { signal }),
      }, [200]);
      assertCurrent(captured);
      return decode(raw, projectId, expectedGeneration);
    },
  };
  return Object.freeze(api);
}
