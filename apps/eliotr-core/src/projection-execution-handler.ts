import {
  createD1ProjectionAuthority,
  createD1ProjectionSearchPort,
  createProjectionExecutionHandler as createExecutor,
  createR2ProjectionContentPort,
  createR2ProjectionWorkPort,
  type ProjectionExecutionProfile,
} from "@eliotr/cloudflare-projection";
import {
  createD1ExecutionLeaseStore,
  type DeliveryHandler,
} from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";

const PROJECTION_EXECUTION_PROFILE: ProjectionExecutionProfile = Object.freeze({
  projector_profile: "structural-markdown-v1",
  managed_instance_id: "private-prose-g2",
  managed_generation: "g2-qwen3-2026-09-03",
  managed_generation_active: false,
  maximum_markdown_bytes: 4 * 1024 * 1024,
  maximum_synchronous_items: 64,
  target_item_utf8_bytes: 32 * 1024,
  maximum_item_utf8_bytes: 64 * 1024,
  managed_poll_interval_ms: 1_000,
  managed_timeout_ms: 30_000,
});

/** Source delivery writes canonical Work and D1 FTS; project outbox delivery owns native AI Search uploads. */
export function createProjectionExecutionDeliveryHandler(env: Env): DeliveryHandler {
  const executor = createExecutor({
    authority: createD1ProjectionAuthority({ database: env.CORE_DB }),
    content: createR2ProjectionContentPort({ evidence_bucket: env.EVIDENCE_BUCKET }),
    work: createR2ProjectionWorkPort({ work_bucket: env.WORK_BUCKET }),
    search: createD1ProjectionSearchPort(env.SEARCH_DB),
    leases: createD1ExecutionLeaseStore(env.CORE_DB),
    profile: PROJECTION_EXECUTION_PROFILE,
  });
  return (message) => executor.execute(message);
}
