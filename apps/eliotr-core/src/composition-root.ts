import type { ApplicationLifecycle } from "@eliotr/interfaces";
import type { Env } from "./env.js";

export interface CompositionRootInput {
  readonly env: Env;
  readonly executionContext: ExecutionContext;
}

export function createApplication(_input: CompositionRootInput): ApplicationLifecycle {
  throw new Error("ER-24 must compose implemented ports; HTTP remains fail-closed until then");
}
