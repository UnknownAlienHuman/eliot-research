import type { NormalizedBundleManifest } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  canonicalJson,
  IngestAuthorityError,
  requireCurrentIngestPolicy,
  type BundlePromotionAuthorization,
  type IngestAdmissionAuthority,
  type IngestClientAuthorization,
  type R2StagedBundleDependencies,
  type StagedBundlePort,
} from "@eliotr/platform-cloudflare";
import { createIngestService, IngestServiceError } from "./ingest-service.js";
import { createSourceAdmissionService } from "./source-admission-service.js";

export interface IngestProjectClientGrantLease {
  readonly grant: IngestClientAuthorization["origin"]["grant"];
  readonly project_generation: IngestClientAuthorization["project_generation"];
  readonly requireGrantCurrent: () => Promise<void>;
}

type IngestStagingApplicationOptions = Pick<
  R2StagedBundleDependencies,
  "require_current" | "authorize_promotion"
>;

export interface IngestApplicationServiceDependencies {
  readonly database: D1Database;
  readonly authorize_project_client_grant: (
    context: AuthenticatedRequestContext,
    namespace: string,
  ) => Promise<IngestProjectClientGrantLease>;
  readonly create_authority: (
    client?: IngestClientAuthorization,
  ) => IngestAdmissionAuthority;
  readonly create_staged_bundles: (
    options: IngestStagingApplicationOptions,
  ) => StagedBundlePort;
  readonly authorize_promotion: (
    authority: IngestAdmissionAuthority,
    input: BundlePromotionAuthorization,
    admissionReceiptRef: string,
  ) => Promise<boolean>;
}

type IngestApi = ReturnType<typeof createIngestService>;
interface IngestLocator {
  readonly manifest?: NormalizedBundleManifest;
  readonly operation_id?: string;
}

/** Apply persisted client grant, operation-origin, and currentness rules to the shared ingest engine. */
export function createIngestApplicationService(
  dependencies: IngestApplicationServiceDependencies,
): IngestApi {
  async function call<T>(context: AuthenticatedRequestContext, locator: IngestLocator,
    execute: (api: IngestApi) => Promise<T>): Promise<T> {
    const database = dependencies.database;
    let client: IngestClientAuthorization | undefined;
    let operationId = locator.operation_id;
    if (context.client_class !== "owner_pwa") {
      const schema = await database.prepare("SELECT value FROM schema_state WHERE key='bundle_ingest_client_generation'")
        .first<{ value: string }>();
      if (schema?.value !== "bundle-ingest-client-v1") {
        throw new IngestAuthorityError("INGEST_SETTLEMENT_UNCERTAIN", "Namespace import schema is not installed", true);
      }
      const existing = operationId === undefined ? null : await database.prepare(
        "SELECT source_namespace_id FROM bundle_ingest_operation WHERE operation_id=?1 AND principal_ref=?2",
      ).bind(operationId, context.principal_ref).first<{ source_namespace_id: string }>();
      const namespace = locator.manifest?.origin.source_namespace_id ?? existing?.source_namespace_id;
      if (namespace === undefined) throw new IngestServiceError("INGEST_OPERATION_NOT_FOUND", 404, "Import operation is unavailable");
      // Raw conversion and ownership cutover have their own authority paths, not inferred from a bundle grant.
      if (locator.manifest && (locator.manifest.origin.ownership_mode !== "immutable_import" ||
          locator.manifest.origin.source_view_ref.startsWith("snapshot-view:v1:"))) {
        throw new IngestServiceError("INGEST_PRINCIPAL_DENIED", 403, "Delegation permits immutable normalized imports, not raw conversion or ownership changes");
      }
      const lease = await dependencies.authorize_project_client_grant(context, namespace);
      const credentialExpiry = context.access?.expires_at;
      if (credentialExpiry === undefined) throw new IngestServiceError("INGEST_PRINCIPAL_DENIED", 403, "Verified service credentials are required");
      client = { origin: { grant: lease.grant }, project_generation: lease.project_generation,
        credential_expires_at: credentialExpiry, requireCurrent: lease.requireGrantCurrent };
    }
    const authority = dependencies.create_authority(client);
    const requireCurrent = async () => {
      if (context.request.signal.aborted) throw new IngestServiceError("INGEST_PRINCIPAL_DENIED", 403, "Import request was cancelled");
      await client?.requireCurrent();
      if (operationId !== undefined) {
        const operation = await authority.loadForPrincipal(operationId, context.principal_ref);
        if (!operation) throw new IngestServiceError("INGEST_OPERATION_NOT_FOUND", 404, "Import operation is unavailable");
        if (client && canonicalJson(operation.client_origin) !== canonicalJson(client.origin)) {
          throw new IngestServiceError("INGEST_PRINCIPAL_DENIED", 403, "Import operation has another origin");
        }
      }
    };
    async function guarded<T>(effect: () => Promise<T>): Promise<T> {
      await requireCurrent();
      const result = await effect();
      await requireCurrent();
      return result;
    }
    const staging = dependencies.create_staged_bundles({
      ...(client ? { require_current: requireCurrent } : {}),
      authorize_promotion: async (input, receipt) => {
        await requireCurrent();
        return dependencies.authorize_promotion(authority, input, receipt);
      },
    });
    const readPromotion = staging.readPromotion;
    const stagedBundles: StagedBundlePort = {
      ...staging,
      prepare: (input) => guarded(() => staging.prepare(input)),
      uploadPart: (input) => guarded(() => staging.uploadPart(input)),
      completeFile: (session, path, parts) => guarded(() => staging.completeFile(session, path, parts)),
      verifyReadback: (session) => guarded(() => staging.verifyReadback(session)),
      promote: (session, receipt) => guarded(() => staging.promote(session, receipt)),
      ...(readPromotion ? { readPromotion: (session: string) => guarded(() => readPromotion(session)) } : {}),
    };
    const deterministic = createSourceAdmissionService();
    const api = createIngestService({
      authority: { ...authority,
        async loadForPrincipal(id, principal) {
          const operation = await authority.loadForPrincipal(id, principal);
          if (operation) operationId = operation.operation_id;
          return operation;
        },
        async loadBySourceRevisionForPrincipal(ref, principal) {
          const operation = await authority.loadBySourceRevisionForPrincipal(ref, principal);
          if (operation) operationId = operation.operation_id;
          return operation;
        },
        async prepare(input) {
          const prepared = await authority.prepare(input);
          operationId = prepared.operation.operation_id;
          await requireCurrent();
          return prepared;
        },
      },
      stagedBundles,
      admission: { async evaluate(operation, verification) {
        if (Date.parse(operation.expires_at) <= Date.now()) {
          throw new IngestAuthorityError("INGEST_STATE_CONFLICT", "Import expired before admission");
        }
        await requireCurrentIngestPolicy(database, operation, Date.now);
        await requireCurrent();
        return deterministic.evaluate(operation, verification);
      } },
    });
    return guarded(() => execute(api));
  }
  return {
    prepareBundle: (ctx, req) => call(ctx, { manifest: req.manifest }, (api) => api.prepareBundle(ctx, req)),
    uploadBundlePart: (ctx, req) => call(ctx, req, (api) => api.uploadBundlePart(ctx, req)),
    completeBundleFile: (ctx, req) => call(ctx, req, (api) => api.completeBundleFile(ctx, req)),
    commitBundle: (ctx, req) => call(ctx, req, (api) => api.commitBundle(ctx, req)),
    getBundleStatus: (ctx, id) => call(ctx, { operation_id: id }, (api) => api.getBundleStatus(ctx, id)),
    getBundleRecovery: (ctx, id) => call(ctx, { operation_id: id }, (api) => api.getBundleRecovery(ctx, id)),
    discoverBundle: (ctx, req) => call(ctx, { manifest: req.manifest }, (api) => api.discoverBundle(ctx, req)),
  };
}
