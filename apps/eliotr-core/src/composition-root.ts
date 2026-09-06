import { createOrientationApi, ORIENTATION_PROFILE } from "@eliotr/cloudflare-navigation";
import type {
  ApplicationLifecycle,
  FederationApi,
  OwnerApi,
  SemanticApi,
} from "@eliotr/interfaces";
import { ROUTES } from "@eliotr/interfaces";
import {
  createD1IngestAdmissionAuthority,
  createR2StagedBundlePort,
  IngestAuthorityError,
  type PreparedIngestOperation,
} from "@eliotr/platform-cloudflare";
import { readSourceRevisions } from "./source-revisions.js";
import { readCatalog } from "./catalog-service.js";
import { createEvidenceService } from "./evidence-service.js";
export { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";
import {
  authorizeIngestPromotion,
  requireCurrentIngestOwner,
} from "./ingest-promotion-authorization.js";
import { createIngestService } from "./ingest-service.js";
import { readReadiness } from "./readiness.js";
import { createSourceAdmissionService } from "./source-admission-service.js";

export interface CompositionRootInput {
  readonly env: Env;
  readonly executionContext: ExecutionContext;
}

export class CapabilityUnavailableError extends Error {
  public readonly code = "IMPLEMENTATION_SLICE_PENDING";
  public readonly operation: string;
  public readonly retryable = false;

  public constructor(operation: string) {
    super(`Capability ${operation} is unavailable in the active Worker generation`);
    this.name = "CapabilityUnavailableError";
    this.operation = operation;
  }
}

function unavailable(operation: string): Promise<never> {
  return Promise.reject(new CapabilityUnavailableError(operation));
}

function capabilities(env: Env): Record<string, unknown> {
  return {
    protocol: "eliotr.capabilities.v1",
    deployment_generation: env.DEPLOYMENT_GENERATION,
    enabled_slices: ["HEALTH", "ACCESS", "CATALOG", "INGEST", "EVIDENCE", "ORIENTATION_METADATA"],
    disabled_slices: [
      "RETRIEVAL",
      "RESEARCH",
      "FEDERATION",
      "WIKI",
      "DRIVE_EXCHANGE",
      "ERASURE",
    ],
    orientation_profile: ORIENTATION_PROFILE,
    orientation_max_sources: 64,
    orientation_max_results: 16,
    routes: ROUTES,
    exact_evidence_resolution_required: true,
    transport_completion_is_research_completion: false,
    ingest_live_qualified: false,
  };
}

function semanticApi(env: Env): SemanticApi {
  const evidence = createEvidenceService(env);
  const orientation = createOrientationApi(env);
  return {
    catalog: (context, request) => readCatalog(env.CORE_DB, context, request, env.DEPLOYMENT_GENERATION),
    orient: (context, request) => orientation.orient(context, request),
    query: () => unavailable("research.query"),
    open: (context, ref, range) => evidence.open(context, ref, range),
    verify: (context, request) => evidence.verify(context, request),
    run: () => unavailable("research.run"),
    artifact: () => unavailable("research.artifact"),
    proposeWiki: () => unavailable("research.wiki.propose"),
    trace: (context, ref) => orientation.trace(context, ref),
    changes: () => unavailable("research.changes"),
  };
}

function federationApi(): FederationApi {
  return {
    submit: () => unavailable("federation.submit"),
    status: () => unavailable("federation.status"),
    result: () => unavailable("federation.result"),
    cancel: () => unavailable("federation.cancel"),
    readBundle: () => unavailable("federation.bundle.read"),
    readBundleManifest: () => unavailable("federation.bundle.manifest"),
    changes: () => unavailable("federation.changes"),
  };
}

function ownerApi(env: Env): OwnerApi {
  const authority = createD1IngestAdmissionAuthority(env.CORE_DB);
  const stagedBundles = createR2StagedBundlePort({
    work_bucket: env.WORK_BUCKET,
    evidence_bucket: env.EVIDENCE_BUCKET,
    authorize_promotion: (input, admissionReceiptRef) =>
      authorizeIngestPromotion(env.CORE_DB, authority, input, admissionReceiptRef),
  });
  const deterministicAdmission = createSourceAdmissionService();
  const ingest = createIngestService({
    authority,
    stagedBundles,
    admission: {
      async evaluate(operation: PreparedIngestOperation, verification) {
        const expiresAt = Date.parse(operation.expires_at);
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
          throw new IngestAuthorityError(
            "INGEST_STATE_CONFLICT",
            "ingest operation expired before source-admission decision",
          );
        }
        await requireCurrentIngestOwner(env.CORE_DB, {
          source_namespace_id: operation.source_namespace_id,
          owner_system_id: operation.owner_system_id,
          source_owner_generation: operation.source_owner_generation,
          policy_revision: operation.policy.revision,
        });
        return deterministicAdmission.evaluate(operation, verification);
      },
    },
  });
  return {
    ...ingest,
    sourceRevisions: (context, request) => readSourceRevisions(env.CORE_DB, context, request, env.DEPLOYMENT_GENERATION),
    async systemHealth(): Promise<Record<string, unknown>> {
      return { ...await readReadiness(env) };
    },
    async systemCapabilities(): Promise<Record<string, unknown>> {
      return capabilities(env);
    },
  };
}

async function countPendingOutbox(database: D1Database): Promise<number> {
  const row = await database.prepare(
    "SELECT COUNT(*) AS pending_count FROM outbox " +
    "WHERE state IN ('PENDING','LEASED','FAILED')",
  ).first<{ pending_count: number }>();
  const count = row?.pending_count ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("D1 returned an invalid pending outbox count");
  }
  return count;
}

// IMPLEMENTED_NOT_LIVE: ER-24 Worker composition requires live Access and remote D1 receipts.
export function createApplication(input: CompositionRootInput): ApplicationLifecycle {
  const services = {
    semantic: semanticApi(input.env),
    federation: federationApi(),
    owner: ownerApi(input.env),
  };
  return {
    services,
    async readiness() {
      const report = await readReadiness(input.env);
      return { ready: report.ready, blocking_reason_codes: report.blocking_reason_codes };
    },
    async reconcile(limit: number) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new RangeError("reconcile limit must be an integer in [1, 1000]");
      }
      return { repaired: 0, still_pending: await countPendingOutbox(input.env.CORE_DB) };
    },
  };
}
