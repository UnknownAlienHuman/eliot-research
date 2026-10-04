import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { createResearchRunReadEnvironment } from "./research-run-read-authorization.js";
import {
  prepareProjectClientRunRead as prepareProjectClientRunReadCapability,
  readProjectClientRunAnswer as readProjectClientRunAnswerCapability,
} from "@eliotr/cloudflare-research-runtime";
import type { ProjectClientRunRead } from "@eliotr/cloudflare-research-runtime";

export function createProjectClientRunReadEnvironment(env: Env) {
  return { run_read: createResearchRunReadEnvironment(env) };
}

export function prepareProjectClientRunRead(
  env: Env, context: AuthenticatedRequestContext, operationId: string,
  operation: "status" | "cancel" | "recover" = "status",
) {
  return prepareProjectClientRunReadCapability(
    createProjectClientRunReadEnvironment(env), context, operationId, operation,
  );
}

export function readProjectClientRunAnswer(
  env: Env, context: AuthenticatedRequestContext, read: ProjectClientRunRead, materializeHandlerGeneration: string,
) {
  return readProjectClientRunAnswerCapability(
    createProjectClientRunReadEnvironment(env), context, read, materializeHandlerGeneration,
  );
}

export type { ProjectClientRunRead, ProjectClientRunCancelFence } from "@eliotr/cloudflare-research-runtime";
