import { ClientGrantError } from "@eliotr/cloudflare-navigation";
import {
  WORKFLOW_RUN_CONTROL_FENCE_SQL,
  workflowRunControlFenceBindings,
} from "@eliotr/cloudflare-workflows";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { ReauthenticatedRunRead } from "./research-run-read-authorization.js";
import type { ProjectClientRunRead } from "./research-client-run-read.js";

export type AuthorizedRunControl = ReauthenticatedRunRead | ProjectClientRunRead;
/** Both owner and service controls reference the same migrated SQL views. */
export async function requireRunControlSchema(database: D1Database): Promise<void> {
  let ready = false;
  try {
    const row = await database.prepare("SELECT value FROM schema_state WHERE key='project_client_run_control_generation'")
      .first<{ readonly value: string }>();
    ready = row?.value === "project-client-run-control-v2";
  } catch { /* Unavailable schema is never permission to dispatch native recovery. */ }
  if (!ready) throw new ClientGrantError("CLIENT_GRANT_SCHEMA_NOT_READY", 503,
    "Migration 0080 is required before Research run controls", true);
}
/** Shared write-time owner/delegation fence, not a new source of authority. */
export const RUN_CONTROL_FENCE_SQL = WORKFLOW_RUN_CONTROL_FENCE_SQL;

export async function runControlFenceBindings(
  context: AuthenticatedRequestContext, read: AuthorizedRunControl, operation: "cancel" | "recover",
  validUntil = Infinity,
): Promise<readonly (string | number)[]> {
  return workflowRunControlFenceBindings(context, read, operation, validUntil);
}
