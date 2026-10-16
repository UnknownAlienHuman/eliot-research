import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { decodeProviderNativeModelCatalogPreparationV2 } from "@eliotr/cloudflare-native-models";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createD1ResearchCatalogModelUseStore, type ResearchCatalogModelUseAuthorizationRow } from
  "./research-catalog-model-use-store.js";

const TERMINAL_HTTP_FAILURES = new Set([400, 401, 403, 404, 405, 406, 410, 413, 415, 422]);
const LOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MAX_READ_BYTES = 65_536;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);

export interface CatalogQualificationGatewayLogRead {
  readonly account_id: string;
  readonly gateway_id: string;
  readonly operation_id: string;
  readonly stage: string;
  readonly prepared_at: string;
  readonly expires_at: string;
}

/** A successful return means an authenticated, complete list read from this exact account/gateway. */
export type CatalogQualificationGatewayLogReader = (input: CatalogQualificationGatewayLogRead) => Promise<Readonly<{
  account_id: string; gateway_id: string; logs: readonly unknown[];
}> | null>;

/** Metadata-only GET. No inference, payload endpoint, redirect, pagination retry or credential fallback. */
export function createCatalogQualificationGatewayLogReader(input: Readonly<{
  account_id: string; gateway_id: string; control_token: string | undefined;
  signal: AbortSignal; fetcher?: typeof fetch;
}>): CatalogQualificationGatewayLogReader {
  return async (query) => {
    if (query.account_id !== input.account_id || query.gateway_id !== input.gateway_id ||
        !/^[a-f0-9]{32}$/u.test(input.account_id) || !/^[a-z0-9_-]{1,64}$/u.test(input.gateway_id) ||
        typeof input.control_token !== "string" || input.control_token.length < 1 || input.control_token.length > 4096 ||
        /\s/u.test(input.control_token) || input.signal.aborted) return null;
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${input.account_id}/ai-gateway/gateways/${input.gateway_id}/logs`);
    url.searchParams.set("page", "1");
    url.searchParams.set("per_page", "50");
    url.searchParams.set("filters", JSON.stringify([
      { key: "metadata.key", operator: "eq", value: ["operation_id"] },
      { key: "metadata.value", operator: "eq", value: [query.operation_id] },
      { key: "created_at", operator: "gt", value: [new Date(Date.parse(query.prepared_at) - 1).toISOString()] },
      { key: "created_at", operator: "lt", value: [query.expires_at] },
    ]));
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 5_000);
    try {
      const response = await (input.fetcher ?? globalThis.fetch.bind(globalThis))(url.href, {
        method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", signal: controller.signal,
        headers: { authorization: `Bearer ${input.control_token}`, accept: "application/json" },
      });
      if (response.status !== 200 || response.redirected || (response.url !== "" && response.url !== url.href) ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json") || response.body === null) {
        await response.body?.cancel();
        return null;
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > MAX_READ_BYTES || controller.signal.aborted) { await reader.cancel(); return null; }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      if (controller.signal.aborted) return null;
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!record(body) || body.success !== true || !Array.isArray(body.result) || body.result.length < 1 || body.result.length > 50 ||
          !record(body.result_info) || body.result_info.total_count !== body.result.length || body.result_info.page !== 1) return null;
      return Object.freeze({ account_id: input.account_id, gateway_id: input.gateway_id, logs: body.result });
    } catch { return null; }
    finally { clearTimeout(timer); input.signal.removeEventListener("abort", abort); }
  };
}

/** Read reconciliation only: retain the native UNCERTAIN row and append exact failure evidence. */
export function createCatalogQualificationFailureReconciler(input: Readonly<{
  database: D1Database; context: AuthenticatedRequestContext;
  deployment_generation?: string;
  read_logs: CatalogQualificationGatewayLogReader; now?: () => string;
}>) {
  const db = input.database;
  const store = createD1ResearchCatalogModelUseStore(db);
  return async (authorization: ResearchCatalogModelUseAuthorizationRow): Promise<ResearchCatalogModelUseAuthorizationRow> => {
    const row = authorization;
    if (row.state !== "UNCERTAIN" || row.phase !== "QUALIFICATION" || row.provider_operation_id === null ||
        input.context.client_class !== "owner_pwa" || input.context.principal_ref !== row.owner_id ||
        input.context.credential_generation.length === 0 || input.context.request.signal.aborted ||
        (input.context.access?.credential_generation !== undefined &&
          input.context.access.credential_generation !== input.context.credential_generation)) return row;
    try {
      const currentOwner = await db.prepare("SELECT p.generation FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
        "WHERE p.project_id=?1 AND o.principal_ref=?2").bind(row.project_id, row.owner_id).first<{ generation: number }>();
      if (currentOwner?.generation !== row.project_generation) return row;
      const provider = await db.prepare("SELECT provider_id,provider_slug,alias,provider_config_id,metadata_sha256 " +
        "FROM service_model_provider_operation WHERE owner_id=?1 AND operation_id=?2 AND state='CONFIGURED' " +
        "AND failure_code IS NULL AND provider_http_status IS NULL").bind(row.owner_id, row.provider_operation_id)
        .first<{ provider_id: string; provider_slug: string; alias: string; provider_config_id: string; metadata_sha256: string }>();
      if (provider === null || provider.provider_id !== row.provider_id || provider.provider_slug !== row.route_provider_id ||
          provider.alias !== row.alias || provider.provider_config_id !== row.provider_config_id ||
          provider.metadata_sha256 !== row.configuration_metadata_sha256) return row;
      const evidence = await db.prepare("SELECT stage,preparation_ref,preparation_sha256,preparation_json " +
        "FROM provider_native_model_catalog_v2_evidence WHERE owner_ref=?1 AND project_id=?2 AND consent_operation_id=?3 " +
        "AND state='UNCERTAIN' ORDER BY stage LIMIT 2").bind(row.owner_id, row.project_id, row.operation_id)
        .all<{ stage: string; preparation_ref: string; preparation_sha256: string; preparation_json: string }>();
      if (evidence.results.length !== 1) return row;
      const e = evidence.results[0];
      if (e === undefined) return row;
      const preparation = decodeProviderNativeModelCatalogPreparationV2(JSON.parse(e.preparation_json) as unknown);
      if (canonicalModelGatewayJson(preparation) !== e.preparation_json ||
          await modelGatewaySha256(e.preparation_json) !== e.preparation_sha256 ||
          e.preparation_ref !== `provider-native-model-preparation-v2-${e.preparation_sha256}` ||
          preparation.owner_ref !== row.owner_id || preparation.project_id !== row.project_id ||
          preparation.consent_operation_id !== row.operation_id || preparation.owner_operation_id !== row.operation_id ||
          preparation.stage !== e.stage || preparation.provider_id !== row.provider_id ||
          preparation.provider_operation_id !== row.provider_operation_id || preparation.provider_slug !== row.route_provider_id ||
          preparation.model_id !== row.model_id || preparation.request_sha256 !== row.request_sha256 ||
          preparation.key_binding.account_id !== row.account_id || preparation.key_binding.gateway_id !== row.gateway_id ||
          preparation.key_binding.alias !== row.alias || preparation.key_binding.provider_config_id !== row.provider_config_id ||
          preparation.key_binding.configuration_metadata_sha256 !== row.configuration_metadata_sha256) return row;
      const read = await input.read_logs({ account_id: preparation.key_binding.account_id,
        gateway_id: preparation.key_binding.gateway_id, operation_id: row.operation_id, stage: e.stage,
        prepared_at: preparation.prepared_at, expires_at: preparation.preparation_expires_at });
      if (read === null || read.account_id !== row.account_id || read.gateway_id !== row.gateway_id) return row;
      const stageLogs: RecordValue[] = [];
      for (const item of read.logs) {
        if (!record(item)) return row;
        const metadata: unknown = typeof item.metadata === "string" ? JSON.parse(item.metadata) : item.metadata;
        if (!record(metadata) || metadata.operation_id !== row.operation_id || typeof metadata.pricing_snapshot_ref !== "string") return row;
        if (metadata.pricing_snapshot_ref === preparation.pricing_snapshot_ref) stageLogs.push(item);
        else if (item.success !== true) return row;
      }
      if (stageLogs.length !== 1) return row;
      const log = stageLogs[0];
      if (!record(log) || typeof log.id !== "string" || !LOG_ID.test(log.id) || log.success !== false || log.cached !== false ||
          typeof log.status_code !== "number" || !TERMINAL_HTTP_FAILURES.has(log.status_code) ||
          log.provider !== row.route_provider_id || log.model !== row.model_id || typeof log.created_at !== "string") return row;
      const observedAt = (input.now ?? (() => new Date().toISOString()))();
      const loggedMs = Date.parse(log.created_at), observedMs = Date.parse(observedAt);
      // Gateway log publication can follow the local UNCERTAIN update. Only
      // the original preparation window and current read observation bound it.
      if (!Number.isFinite(loggedMs) || !Number.isFinite(observedMs) || new Date(observedMs).toISOString() !== observedAt ||
          loggedMs < Date.parse(preparation.prepared_at) || loggedMs >= Date.parse(preparation.preparation_expires_at) ||
          loggedMs > observedMs) return row;
      const metadata: unknown = typeof log.metadata === "string" ? JSON.parse(log.metadata) : log.metadata;
      const deployment = preparation.probe_deployment;
      // Gateway retains five metadata fields. Stage is derived from the exact
      // immutable stage pricing snapshot, never an absent stage_id field.
      const expected = { operation_id: row.operation_id,
        parameters_digest: preparation.probe_parameters_sha256, pricing_snapshot_ref: preparation.pricing_snapshot_ref,
        prompt_generation: deployment.prompt_generation, route_ref: deployment.route_ref };
      if (!record(metadata) || canonicalModelGatewayJson(metadata) !== canonicalModelGatewayJson(expected)) return row;
      const receipt = { protocol: "eliotr.catalog-model-qualification-failure.v1", owner_ref: row.owner_id,
        project_id: row.project_id, operation_id: row.operation_id, stage: preparation.stage,
        account_id: row.account_id, gateway_id: row.gateway_id, provider_id: row.provider_id,
        provider_operation_id: row.provider_operation_id, provider_slug: row.route_provider_id, model_id: row.model_id,
        request_sha256: row.request_sha256, owner_credential_generation: row.owner_credential_generation,
        reader_credential_generation: input.context.credential_generation,
        deployment_generation: row.deployment_generation,
        ...(input.deployment_generation === undefined ? {} : { reader_deployment_generation: input.deployment_generation }),
        preparation_ref: e.preparation_ref, preparation_sha256: e.preparation_sha256,
        pricing_snapshot_sha256: preparation.pricing_snapshot_sha256, gateway_metadata: expected,
        gateway_log_id: log.id, http_status: log.status_code, gateway_authenticated: true,
        success: false, original_state: "UNCERTAIN", original_failure_code: row.failure_code,
        original_updated_at: row.updated_at, provider_effects: "UNKNOWN", classification: "GATEWAY_HTTP_REJECTED",
        logged_at: new Date(loggedMs).toISOString(), observed_at: observedAt };
      const receiptJson = canonicalModelGatewayJson(receipt);
      const receiptSha = await modelGatewaySha256(receiptJson);
      if (input.context.request.signal.aborted) return row;
      await db.batch([
        db.prepare("INSERT INTO provider_native_model_catalog_v2_failure(owner_ref,project_id,consent_operation_id,stage," +
          "preparation_ref,preparation_sha256,account_id,gateway_id,gateway_log_id,http_status,logged_at,observed_at,receipt_json,receipt_sha256) " +
          "VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14) ON CONFLICT(owner_ref,project_id,consent_operation_id) DO NOTHING")
          .bind(row.owner_id, row.project_id, row.operation_id, e.stage, e.preparation_ref, e.preparation_sha256,
            row.account_id, row.gateway_id, log.id, log.status_code, receipt.logged_at, observedAt, receiptJson, receiptSha),
        db.prepare("INSERT INTO provider_native_model_catalog_v2_revocation(owner_ref,project_id,consent_operation_id,stage," +
          "qualification_ref,qualification_sha256,revoked_by,reason,revoked_at) SELECT e.owner_ref,e.project_id,e.consent_operation_id,e.stage," +
          "e.qualification_ref,e.qualification_sha256,e.owner_ref,'Authenticated Gateway qualification failure',?4 " +
          "FROM provider_native_model_catalog_v2_evidence e JOIN provider_native_model_catalog_v2_failure f " +
          "ON f.owner_ref=e.owner_ref AND f.project_id=e.project_id AND f.consent_operation_id=e.consent_operation_id " +
          "WHERE e.owner_ref=?1 AND e.project_id=?2 AND e.consent_operation_id=?3 AND e.state='COMPLETED' AND f.receipt_sha256=?5 " +
          "ON CONFLICT(owner_ref,project_id,qualification_ref,qualification_sha256) DO NOTHING")
          .bind(row.owner_id, row.project_id, row.operation_id, observedAt, receiptSha),
        db.prepare("UPDATE research_catalog_model_use_authorization SET state='BLOCKED',phase='QUALIFICATION'," +
          "failure_code='NATIVE_RECEIPT_INVALID',updated_at=?4 WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3 " +
          "AND state='UNCERTAIN' AND phase='QUALIFICATION' AND owner_credential_generation=?5 " +
          "AND EXISTS(SELECT 1 FROM provider_native_model_catalog_v2_failure f WHERE f.owner_ref=?1 AND f.project_id=?2 " +
          "AND f.consent_operation_id=?3 AND f.receipt_sha256=?6)")
          .bind(row.owner_id, row.project_id, row.operation_id, observedAt, row.owner_credential_generation, receiptSha),
      ]);
      const [persisted, updated] = await Promise.all([
        db.prepare("SELECT receipt_json,receipt_sha256 FROM provider_native_model_catalog_v2_failure " +
          "WHERE owner_ref=?1 AND project_id=?2 AND consent_operation_id=?3").bind(row.owner_id, row.project_id, row.operation_id)
          .first<{ receipt_json: string; receipt_sha256: string }>(),
        store.read(row.owner_id, row.project_id, row.operation_id),
      ]);
      if (persisted?.receipt_json !== receiptJson || persisted.receipt_sha256 !== receiptSha ||
          updated?.state !== "BLOCKED" || input.context.request.signal.aborted) return row;
      return updated;
    } catch { return row; } // Unknown authentication, correlation, authority or storage never authorizes settlement.
  };
}
