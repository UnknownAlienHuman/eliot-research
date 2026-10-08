import { authorizeProjectClientGrant } from "@eliotr/cloudflare-navigation";
import {
  authorizeIngestPromotion,
  createIngestApplicationService,
} from "@eliotr/cloudflare-raw-ingest";
import {
  createD1IngestAdmissionAuthority,
  createR2StagedBundlePort,
} from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";

type IngestApi = ReturnType<typeof createIngestApplicationService>;

/** Bind Worker resources and verified request authorization to the Raw Ingest application service. */
export function createIngestApplication(env: Env): IngestApi {
  const database = env.CORE_DB;
  return createIngestApplicationService({
    database,
    authorize_project_client_grant: (context, namespace) => authorizeProjectClientGrant(
      database,
      context,
      { operation: "ingest.bundle", ingest_namespace_id: namespace },
    ),
    create_authority: (client) => createD1IngestAdmissionAuthority(
      database,
      client === undefined ? {} : { client },
    ),
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
  });
}
