import { WorkflowCheckpointError } from "@eliotr/cloudflare-research";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface ResearchDeploymentCompatibility {
  readonly origin_deployment_generation: string;
  readonly active_deployment_generation: string;
  readonly backend_fingerprint: string | null;
}

function stale(): never {
  throw new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE");
}

/**
 * Exact deployment generation remains immutable provenance. Execution may move
 * only to the single ACTIVE deployment whose reviewed backend fingerprint is
 * identical. Legacy rows without a fingerprint are compatible only with
 * themselves while still ACTIVE.
 */
export async function requireResearchDeploymentCompatibility(
  database: D1Database,
  originDeploymentGeneration: string,
  activeDeploymentGeneration: string,
): Promise<ResearchDeploymentCompatibility> {
  if (!ID.test(originDeploymentGeneration) || !ID.test(activeDeploymentGeneration)) stale();
  let row: ResearchDeploymentCompatibility | null;
  try {
    row = await database.prepare(
      "SELECT origin_deployment_generation,active_deployment_generation,backend_fingerprint " +
      "FROM research_deployment_compatible WHERE origin_deployment_generation=?1 " +
      "AND active_deployment_generation=?2 LIMIT 1",
    ).bind(originDeploymentGeneration, activeDeploymentGeneration).first<ResearchDeploymentCompatibility>();
  } catch { stale(); }
  if (row === null || row.origin_deployment_generation !== originDeploymentGeneration ||
      row.active_deployment_generation !== activeDeploymentGeneration ||
      (row.backend_fingerprint !== null && !SHA256.test(row.backend_fingerprint))) stale();
  return Object.freeze({ ...row });
}
