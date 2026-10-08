import { loadScopeAuthority } from "@eliotr/cloudflare-evidence";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { db, principal, request, runtime, seedSource, successful } from "./orientation-fixture.js";

export function wikiOwnerContext(key: string): AuthenticatedRequestContext {
  return { request: new Request("https://research.example/api/v1/research/wiki/publish", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
  }), principal_ref: principal, client_class: "owner_pwa", credential_generation: "credential-v1", trace_id: `trace-${key}` };
}

/** Actual local owner authorization; publication still builds and validates its own witness. */
export async function wikiPublicationScope(tag: string) {
  const sourceId = `wiki-authority-${tag}`;
  await seedSource(sourceId);
  const orientation = await successful(request(sourceId));
  const scope = orientation.evidence_pack.scope_snapshot_ref;
  const authority = await loadScopeAuthority(db, scope);
  if (authority === null) throw new Error("missing admitted Wiki owner scope");
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO investigation_current_policy VALUES (?1,?2,'ACTIVE',?3)")
      .bind(`wiki-authority-policy-${tag}`, authority.snapshot.policy_authority_ref, now),
    db.prepare("INSERT INTO investigation_current_deployment(deployment_generation,state,created_at) " +
      "VALUES (?1,'ACTIVE',?2) ON CONFLICT(deployment_generation) DO NOTHING")
      .bind(runtime.DEPLOYMENT_GENERATION, now),
  ]);
  return { scope, dependency: `rev-${sourceId}` };
}
