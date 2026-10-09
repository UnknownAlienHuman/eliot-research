import { createD1EvidenceAuthorityPort } from "@eliotr/cloudflare-evidence";
import { createD1ScopePorts } from "@eliotr/retrieval";
import { createD1InvestigationLedgerStore } from "@eliotr/research";
import type { LedgerD1Database } from "@eliotr/research";
import type { WorkflowPrincipal } from "@eliotr/cloudflare-research";
import type { Env } from "./env.js";

type SessionAuthorityRead = "CURRENT" | "STALE" | "UNAVAILABLE";

function sessionAuthorityReadFailure(error: unknown): SessionAuthorityRead {
  const code = error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code: unknown }).code)
    : "";
  return code === "RETRIEVAL_AUTHORITY_STALE" || code === "RETRIEVAL_SCOPE_STALE" ? "STALE" : "UNAVAILABLE";
}

export async function readCurrentSessionAuthority(
  env: Env,
  caller: WorkflowPrincipal,
  investigationId: string,
): Promise<SessionAuthorityRead> {
  const ledger = createD1InvestigationLedgerStore(env.CORE_DB as unknown as LedgerD1Database);
  let investigation: Awaited<ReturnType<typeof ledger.read>>;
  try {
    investigation = await ledger.read(investigationId);
  } catch {
    return "UNAVAILABLE";
  }
  if (investigation === null) return "STALE";
  const access = { principal_ref: caller.principal_ref, client_class: "owner_pwa" as const, credential_generation: caller.credential_generation };
  let authority: Awaited<ReturnType<ReturnType<typeof createD1EvidenceAuthorityPort>["loadScope"]>>;
  try {
    authority = await createD1EvidenceAuthorityPort({
      core_database: env.CORE_DB,
      search_database: env.SEARCH_DB,
    }).loadScope({
      id: investigation.head.scope_snapshot_id,
      revision: investigation.head.scope_snapshot_revision,
    });
  } catch (error) {
    return sessionAuthorityReadFailure(error);
  }
  if (authority === null) return "STALE";
  try {
    await createD1ScopePorts(env.CORE_DB, access).requireCurrentScope(authority.snapshot);
  } catch (error) {
    return sessionAuthorityReadFailure(error);
  }
  return "CURRENT";
}
