import {
  authorizeIngestPromotion,
  createIngestWorkflowOwnerService,
  createSourceAdmissionService,
  type RawNormalizedAdmissionBundlePort,
} from "@eliotr/cloudflare-raw-ingest";
import type { WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import {
  createD1IngestAdmissionAuthority,
  createR2StagedBundlePort,
  IngestAuthorityError,
  requireCurrentIngestPolicy,
} from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";
import { createResearchWorkflowOwnerAuthorityReader } from "./research-workflow-owner-authority.js";

/** Compose the existing bundle engine for one canonically authorized owner run. */
export function createResearchWorkflowIngestOwner(
  env: Env,
  operationId: string,
  principal: WorkflowPrincipal & { readonly signal?: AbortSignal },
): RawNormalizedAdmissionBundlePort {
  const database = env.CORE_DB;
  const deterministic = createSourceAdmissionService();
  return createIngestWorkflowOwnerService({
    operation_id: operationId,
    principal,
    read_current_authority: createResearchWorkflowOwnerAuthorityReader(env, operationId, principal),
    dependencies: {
      authority: createD1IngestAdmissionAuthority(database),
      create_staged_bundles: (options) => createR2StagedBundlePort({
        work_bucket: env.WORK_BUCKET,
        evidence_bucket: env.EVIDENCE_BUCKET,
        ...options,
      }),
      authorize_promotion: (authority, input, receipt) => authorizeIngestPromotion(
        database,
        authority,
        input,
        receipt,
      ),
      admission: {
        async evaluate(operation, verification) {
          if (Date.parse(operation.expires_at) <= Date.now()) {
            throw new IngestAuthorityError("INGEST_STATE_CONFLICT", "Import expired before admission");
          }
          await requireCurrentIngestPolicy(database, operation, Date.now);
          return deterministic.evaluate(operation, verification);
        },
      },
    },
  });
}
