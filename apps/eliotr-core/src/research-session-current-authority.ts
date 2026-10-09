import { createD1EvidenceAuthorityPort } from "@eliotr/cloudflare-evidence";
import { createD1ScopePorts } from "@eliotr/retrieval";
import { createD1InvestigationLedgerStore } from "@eliotr/research";
import type { LedgerD1Database } from "@eliotr/research";
import type { WorkflowPrincipal } from "@eliotr/cloudflare-research";
import type { Env } from "./env.js";

type SessionAuthorityRead = "CURRENT" | "STALE" | "UNAVAILABLE";
type SessionAuthorityFailure = Exclude<SessionAuthorityRead, "CURRENT">;

export type SessionAuthorityReadWithExpiry =
  | { readonly status: "CURRENT"; readonly scope_expires_at: string; readonly grant_expires_at: string }
  | { readonly status: "STALE" }
  | { readonly status: "UNAVAILABLE" };

function sessionAuthorityReadFailure(error: unknown): SessionAuthorityFailure {
  const code = error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code: unknown }).code)
    : "";
  return code === "RETRIEVAL_AUTHORITY_STALE" || code === "RETRIEVAL_SCOPE_STALE" ? "STALE" : "UNAVAILABLE";
}

export async function readCurrentSessionAuthorityWithExpiry(
  env: Env,
  caller: WorkflowPrincipal,
  investigationId: string,
): Promise<SessionAuthorityReadWithExpiry> {
  const ledger = createD1InvestigationLedgerStore(env.CORE_DB as unknown as LedgerD1Database);
  let investigation: Awaited<ReturnType<typeof ledger.read>>;
  try {
    investigation = await ledger.read(investigationId);
  } catch {
    return { status: "UNAVAILABLE" };
  }
  if (investigation === null) return { status: "STALE" };
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
    return { status: sessionAuthorityReadFailure(error) };
  }
  if (authority === null) return { status: "STALE" };
  try {
    const expiry = await createD1ScopePorts(env.CORE_DB, access)
      .requireCurrentScopeWithExpiry(authority.snapshot);
    return { status: "CURRENT", ...expiry };
  } catch (error) {
    return { status: sessionAuthorityReadFailure(error) };
  }
}

export async function readCurrentSessionAuthority(
  env: Env,
  caller: WorkflowPrincipal,
  investigationId: string,
): Promise<SessionAuthorityRead> {
  return (await readCurrentSessionAuthorityWithExpiry(env, caller, investigationId)).status;
}
