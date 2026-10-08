import { prepareWorkflowCancelAction } from "@eliotr/cloudflare-workflows";
import type { WorkflowCancelActionFailure } from "@eliotr/cloudflare-workflows";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { CatalogInputError } from "@eliotr/cloudflare-navigation";
import type { AuthorizedRunControl } from "./research-run-control-fence.js";

/** Attribute the command to the real client in the existing operation journal.
 * The W2 receipt still identifies the run's cancellation, not who won a race to stop it. */
export async function prepareProjectClientCancelAction(
  database: D1Database, context: AuthenticatedRequestContext, read: AuthorizedRunControl,
): Promise<{ confirm(cancellationReceipt: string): Promise<void> }> {
  const fail: WorkflowCancelActionFailure = (code) => {
    const conflict = code === "RESEARCH_RUN_CANCEL_CONFLICT";
    throw new CatalogInputError(code, "Cancellation action could not be reconciled; retain the original request identity",
      conflict ? 409 : 503, !conflict);
  };
  return prepareWorkflowCancelAction(database, context, read, fail);
}
