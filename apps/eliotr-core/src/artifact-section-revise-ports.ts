import { createArtifactCowSectionRevisionPorts } from "@eliotr/cloudflare-artifacts/artifact-cow-section-revision-ports.js";
import {
  readArtifactCowHistoricalFreeze,
  type createArtifactCowDraftMaterialization,
} from "@eliotr/cloudflare-research";
import type { ArtifactSectionReviseAttempt } from "@eliotr/cloudflare-workflows";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";

/** Core adapter for environment bindings, historical workflow reads and HTTP errors. */
export function createOwnerArtifactCowPorts(input: {
  readonly env: Env;
  readonly attempt: ArtifactSectionReviseAttempt;
  readonly navigation: NavigationReadAuthority;
  readonly materialization: Awaited<ReturnType<typeof createArtifactCowDraftMaterialization>>;
}) {
  const { env, attempt, navigation, materialization } = input;
  return createArtifactCowSectionRevisionPorts({
    database: env.CORE_DB,
    search_database: env.SEARCH_DB,
    work_bucket: env.WORK_BUCKET,
    evidence_bucket: env.EVIDENCE_BUCKET,
    attempt,
    navigation,
    materialization,
    read_historical_freeze: readArtifactCowHistoricalFreeze,
    fail: (code, status, message) => { throw new HttpRequestError(code, status, message); },
  });
}
