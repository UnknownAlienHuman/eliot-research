import type { AuthenticatedRequestContext, ResearchChangeItem } from "@eliotr/interfaces";
import { canonicalErasureJson, erasureSha256Utf8 } from "@eliotr/cloudflare-erasure";
import { readErasureOwnerStatus } from "@eliotr/cloudflare-erasure-operations";
import type { Env } from "./env.js";

// Reuse the status reader's admitted principal/credential and exact receipt authority.
export function createErasureChangeAuthorizer(env: Pick<Env, "CORE_DB">) {
  return async (context: AuthenticatedRequestContext, change: ResearchChangeItem): Promise<boolean> => {
    if (context.client_class !== "owner_pwa" || change.kind !== "ERASURE_COMPLETED" ||
        change.visibility_principal_ref !== context.principal_ref || change.visibility_scope_ref !== undefined) return false;
    const ref = { id: change.subject_ref, revision: change.subject_revision };
    const status = await readErasureOwnerStatus({ database: env.CORE_DB }, {
      principal_ref: context.principal_ref, credential_generation: context.credential_generation,
    }, ref);
    const receipt = status?.receipt;
    if (status?.state !== "COMPLETE" || receipt?.state !== "COMPLETE") return false;
    return change.change_ref === `erasure-completed:${ref.id}:${ref.revision}` &&
      change.payload_ref === receipt.purge_ledger_entry_ref && change.occurred_at === receipt.issued_at &&
      Object.keys(change.metadata).length === 0 &&
      change.payload_sha256 === await erasureSha256Utf8(canonicalErasureJson(receipt));
  };
}
