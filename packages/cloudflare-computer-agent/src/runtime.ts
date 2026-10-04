import type { D1Database } from "@cloudflare/workers-types";

/** Minimal Worker bindings consumed by the computer-agent capability. */
export interface ComputerAgentRuntime {
  readonly database: D1Database;
  readonly deployment_generation: string;
}
