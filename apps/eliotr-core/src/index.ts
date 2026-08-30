import type { Env } from "./env.js";
import { handleHttp } from "./http.js";
import { handleQueue } from "./queue.js";
import { handleScheduled } from "./scheduled.js";
export { ResearchSession } from "./research-session.js";
export { ResearchWorkflow } from "./research-workflow.js";

export default {
  fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    return handleHttp(request, env, executionContext);
  },
  queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    return handleQueue(batch, env);
  },
  scheduled(event: ScheduledController, env: Env): Promise<void> {
    return handleScheduled(event, env);
  },
} satisfies ExportedHandler<Env>;
