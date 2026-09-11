import { createWikiProposalService } from "./wiki-service.js";
import { createD1ScopeService, createOrientationApi, createOwnerScopeAuthority, ORIENTATION_PROFILE, OrientationError } from "@eliotr/cloudflare-navigation";
import type { ScopeSnapshot, VersionedRef } from "@eliotr/contracts";
import type {
  ApplicationLifecycle,
  AuthenticatedRequestContext,
  FederationApi,
  OwnerApi,
  RawFileCaptureRequest,
  SemanticApi,
} from "@eliotr/interfaces";
import { artifactSectionResponse, ROUTES } from "@eliotr/interfaces";
import {
  createD1IngestAdmissionAuthority,
  createR2StagedBundlePort,
  IngestAuthorityError,
  type PreparedIngestOperation,
} from "@eliotr/platform-cloudflare";
import { readSourceRevisions } from "./source-revisions.js";
import { readCatalog } from "./catalog-service.js";
import { createEvidenceService } from "./evidence-service.js";
import { createResearchQueryService, createResearchRunService } from "./research-session.js";
import { createExhaustiveWorkflowService } from "./exhaustive-workflow-service.js";
import { readRetrievalTrace } from "@eliotr/retrieval";
export { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";
import {
  authorizeIngestPromotion,
  requireCurrentIngestOwner,
} from "./ingest-promotion-authorization.js";
import { createIngestService } from "./ingest-service.js";
import { readReadiness } from "./readiness.js";
import { createSourceAdmissionService } from "./source-admission-service.js";
import { readGoogleExternalTransport } from "@eliotr/cloudflare-workspace-mcp";
import { createRawCaptureService } from "@eliotr/cloudflare-raw-ingest";
import { createRawMarkdownOwnerConverter } from "@eliotr/cloudflare-markdown";
import { createRawNormalizedAdmissionService } from "./raw-normalized-admission.js";
import { readLibraryReadiness } from "./library-readiness.js";
import { readArtifactDraft, readArtifactDraftSection, readArtifactDraftSectionCitations } from "@eliotr/cloudflare-research";
import { ArtifactReadNotFoundError } from "./artifact-draft-http.js";
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
    google_external_transport: readGoogleExternalTransport(env.GOOGLE_EXTERNAL_TRANSPORT),
    enabled_slices: ["HEALTH", "ACCESS", "CATALOG", "INGEST", "EVIDENCE", "ORIENTATION_METADATA", "RESEARCH"],
    partial_slices: ["WIKI"],
    disabled_slices: [
      "RETRIEVAL",
      "FEDERATION",
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
  const researchQuery = createResearchQueryService(env);
  const exhaustiveWorkflow = createExhaustiveWorkflowService(env);
  const researchRun = createResearchRunService(env);
  const artifactInput = (context: AuthenticatedRequestContext, artifactRef: VersionedRef) => {
    const now = Date.now;
    const authority = createOwnerScopeAuthority(env.CORE_DB, context, now);
    const scopes = createD1ScopeService(env.CORE_DB, authority, { now });
    return {
      database: env.CORE_DB, work_bucket: env.WORK_BUCKET, artifact_ref: artifactRef, access: context,
      require_current: (scope: ScopeSnapshot) => scopes.requireCurrent(scope), now,
    };
  };
  return {
    catalog: (context, request) => readCatalog(env.CORE_DB, context, request, env.DEPLOYMENT_GENERATION),
    orient: (context, request) => orientation.orient(context, request),
    query: (context, request) => {
      const product = request !== null && typeof request === "object" && "product" in request
        ? (request as { readonly product?: unknown }).product
        : undefined;
      return product === "EXHAUSTIVE_JOB"
      ? exhaustiveWorkflow.launch(context, request)
      : researchQuery.query(context, request);
    },
    queryStatus: (context, workflowInstanceId) => exhaustiveWorkflow.status(context, workflowInstanceId),
    queryCancel: (context, workflowInstanceId) => exhaustiveWorkflow.cancel(context, workflowInstanceId),
    runStatus: (context, workflowInstanceId) => researchRun.runStatus(context, workflowInstanceId),
    queryJobs: (context, request) => exhaustiveWorkflow.list(context, request),
    open: (context, ref, range) => evidence.open(context, ref, range),
    verify: (context, request) => evidence.verify(context, request),
    run: (context, request) => researchRun.run(context, request),
    artifact: async (context, artifactRef) => {
      const revision = await readArtifactDraft(artifactInput(context, artifactRef));
      if (revision === null) throw new ArtifactReadNotFoundError();
      return revision;
    },
    artifactSection: async (context, artifactRef, sectionRef) => {
      const section = await readArtifactDraftSection({
        ...artifactInput(context, artifactRef), section_ref: sectionRef,
      });
      if (section === null) throw new ArtifactReadNotFoundError("artifact section does not exist");
      return artifactSectionResponse(section);
    },
    artifactSectionCitations: async (context, artifactRef, sectionRef) => {
      const citations = await readArtifactDraftSectionCitations({
        ...artifactInput(context, artifactRef), section_ref: sectionRef,
      });
      if (citations === null) throw new ArtifactReadNotFoundError("artifact section citations do not exist");
      return { protocol: "eliotr.artifact-section-citations.v1", ...citations };
    },
    proposeWiki: createWikiProposalService(env),
    trace: (context, ref) => ref.id.startsWith("query-") ? readRetrievalTrace(env.CORE_DB, context, ref).then((r) => {
      if (r.status === "ok") return r.trace; throw new OrientationError(r.status === "invalid" ? "ORIENTATION_TRACE_INVALID" : r.status === "missing" ? "ORIENTATION_TRACE_NOT_FOUND" : r.status === "stale" ? "ORIENTATION_TRACE_CORRUPT" : "ORIENTATION_RESERVATION_UNCERTAIN", r.status === "invalid" ? 400 : r.status === "missing" ? 404 : r.status === "stale" ? 409 : 503, r.status === "uncertain"); }) : orientation.trace(context, ref),
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
  const rawCapture = createRawCaptureService(env);
  const convertRawMarkdown = createRawMarkdownOwnerConverter({
    database: env.CORE_DB, bucket: env.EVIDENCE_BUCKET, ...(env.AI === undefined ? {} : { ai: env.AI }), profile_generation: env.DEPLOYMENT_GENERATION,
    readCapture: (context, captureId) => rawCapture.readRawCaptureForServer(context, captureId),
  });
  const ownerBase: Omit<OwnerApi, "admitRawFileToNormalized" | "getRawNormalizedAdmissionStatus"> = {
    ...ingest,
    captureRawFile: (context, request: RawFileCaptureRequest) => rawCapture.captureRawFile(context, request),
    readRawFile: (context, captureId) => rawCapture.readRawFile(context, captureId),
    readRawFileByIdempotency: (context, idempotencyKey) => rawCapture.readRawFileByIdempotency(context, idempotencyKey),
    convertRawFileToMarkdown: (context, captureId, request) => convertRawMarkdown(context, captureId, request),
    sourceRevisions: (context, request) => readSourceRevisions(env.CORE_DB, context, request, env.DEPLOYMENT_GENERATION),
    libraryReadiness: (context, request) => readLibraryReadiness(
      env.CORE_DB, env.SEARCH_DB, context, request, env.DEPLOYMENT_GENERATION,
    ),
    async systemHealth(): Promise<Record<string, unknown>> {
      return {
        ...await readReadiness(env),
        google_external_transport: readGoogleExternalTransport(env.GOOGLE_EXTERNAL_TRANSPORT),
      };
    },
    async systemCapabilities(): Promise<Record<string, unknown>> {
      return capabilities(env);
    },
  };
  const rawNormalized = createRawNormalizedAdmissionService({
    database: env.CORE_DB,
    bucket: env.EVIDENCE_BUCKET,
    owner: ownerBase,
    readCapture: (context, captureId) => rawCapture.readRawCaptureForServer(context, captureId),
  });
  return {
    ...ownerBase,
    admitRawFileToNormalized: rawNormalized.admit,
    getRawNormalizedAdmissionStatus: rawNormalized.getStatus,
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
