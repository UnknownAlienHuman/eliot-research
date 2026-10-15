import { ServiceModelSettingsSchema, ServiceModelProviderCreateRequestSchema,
  ServiceModelProviderCreateReceiptSchema, ServiceModelProviderReadbackEnvelopeSchema,
  type ServiceModelSettings, type ServiceModelProviderCreateRequest,
  type ServiceModelProviderCreateReceipt, type ServiceModelProviderReadbackEnvelope } from '@eliotr/contracts';
import type { LegacyErrorFactory, LegacyHttpAdapter } from '../legacy/http';
import type { EpochPort } from '../transport/client';

const SETTINGS = '/api/v1/system/model-settings';
const PROVIDERS = '/api/v1/system/model-providers';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** Global owner settings. Keys are write-only request data, never returned or cached here. */
export function createServiceModelSettingsApi(http: Pick<LegacyHttpAdapter, 'requestApiWithStatuses'>,
  errors: LegacyErrorFactory, epoch: EpochPort) {
  const fail = (code: string, status: number, message: string): never => {
    throw errors({ code, status, message, traceId: null, retryable: false });
  };
  const capture = () => {
    const value = epoch.capture();
    if (value === undefined || !epoch.isCurrent(value)) return fail('API_SESSION_CLOSED', 503, 'Owner session is closed.');
    return value;
  };
  const current = (value: object) => {
    if (!epoch.isCurrent(value)) fail('API_SESSION_CLOSED', 503, 'Owner session is closed.');
  };
  const data = (raw: unknown, generation: string): unknown => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return fail('SERVICE_MODEL_RESPONSE_INVALID', 502, 'Model settings response is invalid.');
    }
    const envelope = raw as Record<string, unknown>;
    const keys = Object.keys(envelope);
    if (keys.length !== 3 || keys.some(key => !['data', 'trace_id', 'deployment_generation'].includes(key)) ||
      typeof envelope.trace_id !== 'string' || !TRACE_ID.test(envelope.trace_id)) {
      return fail('SERVICE_MODEL_RESPONSE_INVALID', 502, 'Model settings response is invalid.');
    }
    if (envelope.deployment_generation !== generation) {
      return fail('API_GENERATION_MISMATCH', 409, 'Deployment changed. Refresh model settings.');
    }
    return envelope.data;
  };
  const assertGeneration = (generation: string) => {
    if (typeof generation !== 'string' || !IDENTIFIER.test(generation)) fail('SERVICE_MODEL_INPUT_INVALID', 400, 'Deployment generation is invalid.');
  };

  async function readServiceModelSettings(generation: string, signal?: AbortSignal): Promise<ServiceModelSettings> {
    const context = capture(); assertGeneration(generation);
    const raw = await http.requestApiWithStatuses(SETTINGS, { method: 'GET', ...(signal === undefined ? {} : { signal }) }, [200]);
    current(context);
    const parsed = ServiceModelSettingsSchema.safeParse(data(raw, generation));
    if (!parsed.success) return fail('SERVICE_MODEL_RESPONSE_INVALID', 502, 'Model settings response is invalid.');
    return parsed.data;
  }

  async function createServiceModelProvider(input: ServiceModelProviderCreateRequest, generation: string,
    signal?: AbortSignal): Promise<ServiceModelProviderCreateReceipt> {
    const context = capture(); assertGeneration(generation);
    const parsed = ServiceModelProviderCreateRequestSchema.safeParse(input);
    if (!parsed.success) return fail('SERVICE_MODEL_INPUT_INVALID', 400, 'Provider settings are invalid.');
    const expected = { operation: parsed.data.operation_id, provider: parsed.data.provider_id,
      name: parsed.data.display_name, models: new Set(parsed.data.model_ids), base: parsed.data.base_url || null };
    const raw = await http.requestApiWithStatuses(PROVIDERS, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-eliotr-csrf': '1', 'idempotency-key': expected.operation },
      body: JSON.stringify(parsed.data), ...(signal === undefined ? {} : { signal }),
    }, [200, 201]);
    current(context);
    const receipt = ServiceModelProviderCreateReceiptSchema.safeParse(data(raw, generation));
    if (!receipt.success || receipt.data.operation_id !== expected.operation || receipt.data.provider_id !== expected.provider ||
      receipt.data.display_name !== expected.name || receipt.data.base_url !== expected.base ||
      new Set(receipt.data.model_ids).size !== expected.models.size || receipt.data.model_ids.some(model => !expected.models.has(model))) {
      return fail('SERVICE_MODEL_RESPONSE_INVALID', 502, 'Provider setup receipt is invalid.');
    }
    return receipt.data;
  }

  async function readServiceModelProviderOperation(operationId: string, generation: string,
    signal?: AbortSignal): Promise<ServiceModelProviderReadbackEnvelope> {
    const context = capture(); assertGeneration(generation);
    if (!ServiceModelProviderCreateRequestSchema.shape.operation_id.safeParse(operationId).success) {
      return fail('SERVICE_MODEL_INPUT_INVALID', 400, 'Provider operation is invalid.');
    }
    const raw = await http.requestApiWithStatuses(`${PROVIDERS}?operation_id=${encodeURIComponent(operationId)}`,
      { method: 'GET', ...(signal === undefined ? {} : { signal }) }, [200]);
    current(context);
    const result = ServiceModelProviderReadbackEnvelopeSchema.safeParse(data(raw, generation));
    if (!result.success || (result.data.connection !== null && result.data.connection.operation_id !== operationId)) {
      return fail('SERVICE_MODEL_RESPONSE_INVALID', 502, 'Provider status is invalid.');
    }
    return result.data;
  }
  return { readServiceModelSettings, createServiceModelProvider, readServiceModelProviderOperation };
}
