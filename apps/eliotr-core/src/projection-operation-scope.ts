import { z } from "zod";
import { IdentifierSchema, Sha256Schema, VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createD1ScopeSnapshotStore } from "@eliotr/cloudflare-evidence";
import { createD1ScopeService, createOwnerScopeAuthority, resolveD1ProjectCopyScope } from "@eliotr/cloudflare-navigation";
import { createD1ScopePorts } from "@eliotr/retrieval";
import {
  canonicalProjectionJson, createD1ProjectionAuthority, projectionFail, resolveManagedTargetSelectionV2,
  type ManagedTargetSelectionV2, type ProjectionSourceContext, type ProjectCopyScopeV2,
} from "@eliotr/cloudflare-projection";

const BindingSchema = z.object({
  protocol: z.literal("eliotr.projection-operation-owner-scope.v1"),
  intent_ref: VersionedRefSchema,
  job_id: IdentifierSchema,
  source_revision_ref: IdentifierSchema,
  scope_snapshot_ref: VersionedRefSchema,
  scope_snapshot_digest: Sha256Schema,
  access: z.object({
    principal_ref: IdentifierSchema,
    client_class: z.literal("owner_pwa"),
    credential_generation: IdentifierSchema,
  }).strict(),
}).strict();
type Binding = z.infer<typeof BindingSchema>;

interface OperationRow {
  readonly principal_ref: string;
  readonly progress_cursor: string | null;
  readonly checked_at: string;
}

async function operation(database: D1Database, context: ProjectionSourceContext): Promise<OperationRow> {
  // Reuse the outbox/admission/acceptance loader; a supplied context is not
  // sufficient authority to bind a different operation, job or source.
  const current = await createD1ProjectionAuthority({ database }).load(context.message);
  if (canonicalProjectionJson(current.intent_ref) !== canonicalProjectionJson(context.intent_ref) ||
      current.job_id !== context.job_id || current.acceptance_attempt_id !== context.acceptance_attempt_id ||
      canonicalProjectionJson(current.source_revision) !== canonicalProjectionJson(context.source_revision)) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Owner scope binding differs from the durable projection operation");
  }
  const row = await database.prepare(
    "SELECT i.principal_ref,j.progress_cursor,strftime('%Y-%m-%dT%H:%M:%fZ','now') AS checked_at " +
    "FROM job j JOIN operation_intent i ON i.intent_id=j.intent_id AND i.revision=j.intent_revision " +
    "WHERE j.job_id=?1 AND j.intent_id=?2 AND j.intent_revision=?3 AND i.operation_kind='PROJECTION' LIMIT 1",
  ).bind(context.job_id, context.intent_ref.id, context.intent_ref.revision).first<OperationRow>();
  if (row === null || !Number.isFinite(Date.parse(row.checked_at)) ||
      new Date(row.checked_at).toISOString() !== row.checked_at) {
    projectionFail("PROJECTION_SETTLEMENT_UNCERTAIN", "Projection owner scope has no current D1 operation authority", true);
  }
  return row;
}

async function currentSnapshot(database: D1Database, context: ProjectionSourceContext, binding: Binding, row: OperationRow) {
  if (binding.intent_ref.id !== context.intent_ref.id || binding.intent_ref.revision !== context.intent_ref.revision ||
      binding.job_id !== context.job_id || binding.source_revision_ref !== context.source_revision.source_revision_ref ||
      binding.access.principal_ref !== row.principal_ref) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Persisted owner scope belongs to another projection operation");
  }
  const snapshot = await createD1ScopeSnapshotStore(database).readSnapshot(
    binding.scope_snapshot_ref.id, binding.scope_snapshot_ref.revision,
  );
  if (snapshot === null || snapshot.digest !== binding.scope_snapshot_digest ||
      !snapshot.member_source_revision_refs.includes(context.source_revision.source_revision_ref) ||
      snapshot.source_owner_generations[context.source_revision.source_revision_ref] !== context.source_revision.source_owner_generation) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Projection operation has no matching persisted live owner ScopeSnapshot");
  }
  if (snapshot.resolved_scope_expression.kind !== "PROJECT") {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Projection copy authority requires one explicit persisted PROJECT scope; retrieval representatives cannot authorize source fanout");
  }
  const now = () => Date.parse(row.checked_at);
  const owner = createOwnerScopeAuthority(database, binding.access, now);
  const scopes = createD1ScopeService(database, owner, { now });
  const grants = createD1ScopePorts(database, binding.access, () => row.checked_at);
  await scopes.requireCurrent(snapshot);
  await grants.requireCurrentScope(snapshot);
  return snapshot;
}

function decodeBinding(value: string | null): Binding {
  if (value === null || new TextEncoder().encode(value).byteLength > 4096) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Projection operation has no bounded owner ScopeSnapshot binding");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Projection owner scope binding is malformed"); }
  const binding = BindingSchema.safeParse(parsed);
  if (!binding.success) projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Projection owner scope binding is invalid");
  return binding.data;
}

/**
 * Bind an existing single-PROJECT owner snapshot/grant to this exact accepted
 * projection job. This is not generic source-ingestion fanout authority.
 * The owner admission caller must supply its verified context; ingestion
 * admission or a retained credential string cannot mint owner scope authority.
 * job.progress_cursor is unused by the legacy projection path. Its first V1
 * binding is CAS-pinned and never replaces another checkpoint or stale scope.
 */
export async function bindProjectionOperationOwnerScope(input: {
  readonly database: D1Database;
  readonly context: ProjectionSourceContext;
  readonly owner: AuthenticatedRequestContext;
  readonly scope_snapshot_ref: VersionedRef;
}): Promise<void> {
  const { database, context, owner } = input;
  const row = await operation(database, context);
  const access = owner.access;
  if (owner.client_class !== "owner_pwa" || access?.authentication_method !== "cloudflare_access" ||
      access.principal_ref !== owner.principal_ref || access.credential_generation !== owner.credential_generation ||
      owner.principal_ref !== row.principal_ref || owner.request.signal.aborted ||
      !Number.isFinite(Date.parse(access.expires_at)) || Date.parse(access.expires_at) <= Date.parse(row.checked_at)) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "A current verified operation owner must bind the projection scope");
  }
  const snapshot = await createD1ScopeSnapshotStore(database).readSnapshot(input.scope_snapshot_ref.id, input.scope_snapshot_ref.revision);
  if (snapshot === null) projectionFail("PROJECTION_AUTHORITY_CONFLICT", "The owner snapshot must already be persisted");
  const binding = BindingSchema.parse({
    protocol: "eliotr.projection-operation-owner-scope.v1",
    intent_ref: context.intent_ref, job_id: context.job_id, source_revision_ref: context.source_revision.source_revision_ref,
    scope_snapshot_ref: input.scope_snapshot_ref, scope_snapshot_digest: snapshot.digest,
    access: { principal_ref: owner.principal_ref, client_class: "owner_pwa", credential_generation: owner.credential_generation },
  });
  await currentSnapshot(database, context, binding, row);
  const bytes = canonicalProjectionJson(binding);
  if (new TextEncoder().encode(bytes).byteLength > 4096) projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Projection owner scope binding exceeds its byte bound");
  if (row.progress_cursor !== null && row.progress_cursor !== bytes) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Projection job already has another immutable scope or progress checkpoint");
  }
  try {
    await database.prepare(
      "UPDATE job SET progress_cursor=?1 WHERE job_id=?2 AND intent_id=?3 AND intent_revision=?4 " +
      "AND state IN ('ACCEPTED','RUNNING') AND (progress_cursor IS NULL OR progress_cursor=?1) " +
      "AND julianday(?5)>julianday('now') AND EXISTS (SELECT 1 FROM operation_intent i " +
      "WHERE i.intent_id=?3 AND i.revision=?4 AND i.principal_ref=?6 AND i.operation_kind='PROJECTION')",
    ).bind(bytes, context.job_id, context.intent_ref.id, context.intent_ref.revision, access.expires_at, owner.principal_ref).run();
  } catch {
    // Lost ACK is reconciled only by exact readback below.
  }
  const stored = await operation(database, context);
  if (stored.progress_cursor !== bytes) projectionFail("PROJECTION_SETTLEMENT_UNCERTAIN", "Projection owner scope binding did not settle exactly", true);
  await currentSnapshot(database, context, binding, stored);
}

/**
 * Core-only per-project resolver for the optional projection-authority seam.
 * The retrieval helper selects one representative, so only an explicit PROJECT
 * scope can identify that copy without dropping other admitted projects.
 * The caller still needs a distinct per-project operation/generation identity;
 * this binding cannot split a generic ingest job into independent project jobs.
 */
export function createProjectionOperationScopeResolver(input: {
  readonly database: D1Database;
  readonly search_database: D1Database;
  /** Exact Root-owned target decision, never an owner HTTP selector. */
  readonly resolve_selections: (context: ProjectionSourceContext) => Promise<readonly ManagedTargetSelectionV2[]>;
}): (context: ProjectionSourceContext) => Promise<readonly ProjectCopyScopeV2[]> {
  return async context => {
    const { database, search_database: searchDatabase } = input;
    const row = await operation(database, context);
    const binding = decodeBinding(row.progress_cursor);
    const snapshot = await currentSnapshot(database, context, binding, row);
    const expression = snapshot.resolved_scope_expression;
    if (expression.kind !== "PROJECT") projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Projection scope must select one explicit project");
    const selections = await input.resolve_selections(context);
    if (!Array.isArray(selections) || selections.length < 1 || selections.length > 2 ||
        new Set(selections.map(selection => selection.purpose)).size !== selections.length ||
        new Set(selections.map(selection => selection.target.managed_generation)).size !== selections.length) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Projection requires distinct bounded ACTIVE/SHADOW target selections");
    }
    const assertSelection = async (selection: ManagedTargetSelectionV2) => {
      const current = await resolveManagedTargetSelectionV2(searchDatabase, selection.purpose,
        selection.purpose === "SHADOW" ? selection.target.managed_generation : undefined);
      if (canonicalProjectionJson(current) !== canonicalProjectionJson(selection)) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Projection target selection differs from the exact current registry capture");
      }
    };
    const scopes: ProjectCopyScopeV2[] = [];
    for (const selection of selections) {
      await assertSelection(selection);
      const scope = await resolveD1ProjectCopyScope({
        database, access: binding.access, scope_snapshot: snapshot, observed_at: row.checked_at,
        target: selection.target, selection,
        require_current_scope: async candidate => {
          const fresh = await operation(database, context);
          if (fresh.progress_cursor !== row.progress_cursor || candidate.digest !== snapshot.digest) {
            projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Projection operation scope binding changed during resolution");
          }
          await currentSnapshot(database, context, binding, fresh);
        },
      });
      if (scope.layout !== "PROJECT_COPY_V2") projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Projection V2 selection resolved a legacy copy scope");
      const copies = scope.copies.filter(copy => copy.source_revision_ref === context.source_revision.source_revision_ref);
      if (copies.length !== 1 || copies[0]?.project_id !== expression.project_id ||
          copies[0]?.source_owner_generation !== context.source_revision.source_owner_generation) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Projection source lacks one exact owner-authorized project copy");
      }
      scopes.push(Object.freeze({ ...scope, copies: Object.freeze(copies) }));
    }
    for (const selection of selections) await assertSelection(selection);
    return Object.freeze(scopes);
  };
}
