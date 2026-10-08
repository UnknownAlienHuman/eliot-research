import type {
  ErasureDependencyClosure,
  ErasureFence,
  ErasureRequest,
} from "@eliotr/contracts";
import {
  assertErasureIdentifier,
  erasureDigest,
  isoFromMs,
  stableErasureId,
} from "./canonical.js";
import type {
  ErasureDependentInvalidation,
  ErasureInvalidationPort,
} from "./types.js";

interface HandleRow {
  readonly handle_id: unknown;
  readonly revision: unknown;
}

interface ScopeRow {
  readonly snapshot_id: unknown;
  readonly revision: unknown;
}

interface WikiRow {
  readonly page_id: unknown;
  readonly revision: unknown;
}

interface ArtifactRow {
  readonly artifact_id: unknown;
  readonly revision: unknown;
}

interface PublicationHeadRow {
  readonly artifact_id: unknown;
  readonly draft_revision: unknown;
  readonly publication_revision: unknown;
  readonly publication_ref: unknown;
  readonly disposition: unknown;
}

interface InvestigationRow {
  readonly investigation_id: unknown;
  readonly revision: unknown;
}

function positiveRevision(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} revision is invalid`);
  }
  return value;
}

function revisionRefs(closure: ErasureDependencyClosure): readonly string[] {
  const refs = new Set<string>();
  for (const target of closure.targets) {
    for (const prefix of [
      "d1-core:source-revision:",
      "d1-core:operational:",
      "d1-core:route:source-revision:",
    ]) {
      if (target.canonical_ref.startsWith(prefix)) refs.add(target.canonical_ref.slice(prefix.length));
    }
    if (target.canonical_ref.startsWith("d1-search:")) {
      const body = target.canonical_ref.slice("d1-search:".length);
      const separator = body.lastIndexOf(":");
      if (separator > 0) refs.add(body.slice(0, separator));
    }
  }
  return [...refs].map((value) => assertErasureIdentifier(value, "invalidation source revision"));
}

function explicitHandles(closure: ErasureDependencyClosure): readonly { id: string; revision: number }[] {
  const output: { id: string; revision: number }[] = [];
  for (const target of closure.targets) {
    const prefixes = ["d1-core:evidence-handle:", "d1-core:route:evidence-handle:"];
    const prefix = prefixes.find((candidate) => target.canonical_ref.startsWith(candidate));
    if (prefix === undefined) continue;
    const body = target.canonical_ref.slice(prefix.length);
    const separator = body.lastIndexOf(":");
    if (separator > 0 && /^[1-9][0-9]*$/u.test(body.slice(separator + 1))) {
      output.push({ id: body.slice(0, separator), revision: positiveRevision(Number(body.slice(separator + 1)), "explicit handle") });
    }
  }
  return output;
}

function explicitScopes(closure: ErasureDependencyClosure): readonly { id: string; revision: number }[] {
  const output: { id: string; revision: number }[] = [];
  for (const target of closure.targets) {
    const prefixes = ["d1-core:scope-snapshot:", "d1-core:route:scope-snapshot:"];
    const prefix = prefixes.find((candidate) => target.canonical_ref.startsWith(candidate));
    if (prefix === undefined) continue;
    const body = target.canonical_ref.slice(prefix.length);
    const separator = body.lastIndexOf(":");
    if (separator > 0 && /^[1-9][0-9]*$/u.test(body.slice(separator + 1))) {
      output.push({ id: body.slice(0, separator), revision: positiveRevision(Number(body.slice(separator + 1)), "explicit scope") });
    }
  }
  return output;
}

async function currentPublicationHeads(
  database: D1Database,
  closure: ErasureDependencyClosure,
): Promise<readonly PublicationHeadRow[]> {
  // The immutable accepted receipt carries exact current evidence graph edges.
  // Use those persisted edges instead of inferring publication dependencies.
  const exactDependencies = [
    ...revisionRefs(closure).map((source_revision_ref) => ({ source_revision_ref })),
    ...explicitHandles(closure).map((handle) => ({ handle_id: handle.id, handle_revision: handle.revision })),
    ...explicitScopes(closure).map((scope) => ({ scope_snapshot_id: scope.id, scope_snapshot_revision: scope.revision })),
  ];
  if (exactDependencies.length === 0) return [];
  const result = await database.prepare(
    "SELECT h.artifact_id,p.draft_revision,h.publication_revision,h.publication_ref,h.disposition " +
    "FROM artifact_publication_head h JOIN artifact_publication_receipt p " +
    "ON p.publication_ref=h.publication_ref " +
    "WHERE h.disposition IN ('ACCEPTED','PENDING_REVALIDATION') AND EXISTS (" +
    "SELECT 1 FROM json_each(p.evidence_currentness_json) c JOIN json_each(?1) d WHERE " +
    "json_extract(d.value,'$.source_revision_ref')=json_extract(c.value,'$.source_revision_ref') " +
    "OR (json_extract(d.value,'$.handle_id')=json_extract(c.value,'$.handle_id') " +
    "AND json_extract(d.value,'$.handle_revision')=json_extract(c.value,'$.handle_revision')) " +
    "OR (json_extract(d.value,'$.scope_snapshot_id')=json_extract(c.value,'$.scope_snapshot_id') " +
    "AND json_extract(d.value,'$.scope_snapshot_revision')=json_extract(c.value,'$.scope_snapshot_revision'))) " +
    "ORDER BY h.artifact_id,h.publication_revision LIMIT 10001",
  ).bind(JSON.stringify(exactDependencies)).all<PublicationHeadRow>();
  const rows = result.results ?? [];
  if ((result as { readonly success?: boolean }).success === false) throw new Error("publication dependency inventory failed");
  if (rows.length > 10000) throw new Error("publication dependency inventory exceeds the bounded 10000-row limit");
  return rows;
}

function safePublicationDisposition(value: unknown): "ACCEPTED" | "PENDING_REVALIDATION" | "REDACTED_DEPENDENCY" {
  if (value !== "ACCEPTED" && value !== "PENDING_REVALIDATION" && value !== "REDACTED_DEPENDENCY") {
    throw new Error("publication head disposition is invalid");
  }
  return value;
}

async function allRows<T>(statement: D1PreparedStatement, label: string): Promise<readonly T[]> {
  const result = await statement.all<T>();
  if ((result as { readonly success?: boolean }).success === false) throw new Error(`${label} inventory failed`);
  return result.results ?? [];
}

async function invalidation(
  kind: ErasureDependentInvalidation["dependent_kind"],
  disposition: ErasureDependentInvalidation["disposition"],
  dependentRef: string,
  ledgerRef: string,
): Promise<ErasureDependentInvalidation> {
  return {
    dependent_kind: kind,
    disposition,
    dependent_ref: dependentRef,
    receipt_ref: await stableErasureId("invalidation", ledgerRef, kind, dependentRef, disposition),
  };
}

export interface D1ErasureInvalidationDependencies {
  readonly database: D1Database;
  readonly now?: () => number;
}

export function createD1ErasureInvalidationPort(
  dependencies: D1ErasureInvalidationDependencies,
): ErasureInvalidationPort {
  const database = dependencies.database;
  const clock = dependencies.now ?? Date.now;
  return {
    async invalidate(
      request: ErasureRequest,
      fence: ErasureFence,
      closure,
      ledgerEntryRef,
    ): Promise<readonly ErasureDependentInvalidation[]> {
      const revisions = revisionRefs(closure);
      const handles = new Map<string, HandleRow>();
      const scopes = new Map<string, ScopeRow>();

      for (const revisionRef of revisions) {
        for (const row of await allRows<HandleRow>(database.prepare(
          "SELECT handle_id,revision FROM evidence_handle WHERE source_revision_ref=?1 " +
          "ORDER BY handle_id,revision LIMIT 10000",
        ).bind(revisionRef), "evidence handle")) {
          handles.set(`${String(row.handle_id)}:${String(row.revision)}`, row);
        }
        for (const row of await allRows<ScopeRow>(database.prepare(
          "SELECT snapshot_id,revision FROM scope_snapshot WHERE EXISTS " +
          "(SELECT 1 FROM json_each(member_source_revision_refs_json) WHERE value=?1) " +
          "ORDER BY snapshot_id,revision LIMIT 10000",
        ).bind(revisionRef), "scope snapshot")) {
          scopes.set(`${String(row.snapshot_id)}:${String(row.revision)}`, row);
        }
      }
      for (const item of explicitHandles(closure)) {
        handles.set(`${item.id}:${item.revision}`, { handle_id: item.id, revision: item.revision });
      }
      for (const item of explicitScopes(closure)) {
        scopes.set(`${item.id}:${item.revision}`, { snapshot_id: item.id, revision: item.revision });
      }

      const invalidations: ErasureDependentInvalidation[] = [];
      const publicationInvalidations: ErasureDependentInvalidation[] = [];
      const now = isoFromMs(clock());
      if (fence.erasure_id !== request.erasure_ref.id || fence.revision !== request.erasure_ref.revision ||
          closure.erasure_ref.id !== request.erasure_ref.id || closure.erasure_ref.revision !== request.erasure_ref.revision) {
        throw new Error("publication invalidation request, closure, and fence do not match");
      }
      const requestedSubjects = new Set(request.exact_subject_refs);
      if (closure.targets.some((target) => !requestedSubjects.has(target.exact_subject_ref))) {
        throw new Error("publication invalidation closure contains a subject outside the exact erasure request");
      }
      const publicationHeads = await currentPublicationHeads(database, closure);
      let desiredHeadDisposition: "PENDING_REVALIDATION" | "REDACTED_DEPENDENCY" | undefined;
      if (publicationHeads.length > 0) {
        const ledger = await database.prepare(
          "SELECT erasure_id,non_revealing_subject_digest,disposition FROM purge_ledger " +
          "WHERE receipt_ref=?1 ORDER BY ledger_revision DESC LIMIT 1",
        ).bind(ledgerEntryRef).first<{
          readonly erasure_id: unknown;
          readonly non_revealing_subject_digest: unknown;
          readonly disposition: unknown;
        }>();
        const expectedSubjectDigest = await erasureDigest([...request.exact_subject_refs].sort());
        if (ledger === null || ledger.erasure_id !== request.erasure_ref.id ||
            ledger.non_revealing_subject_digest !== expectedSubjectDigest) {
          throw new Error("publication invalidation purge ledger does not match the exact erasure request");
        }
        if (ledger.disposition === "COMPLETE") desiredHeadDisposition = "REDACTED_DEPENDENCY";
        else if (ledger.disposition === "BLOCKED") desiredHeadDisposition = "PENDING_REVALIDATION";
        else throw new Error("publication invalidation requires its exact persisted purge-ledger disposition");
      }
      for (const row of publicationHeads) {
        const artifactId = assertErasureIdentifier(row.artifact_id, "publication artifact ID");
        const draftRevision = positiveRevision(row.draft_revision, "publication draft");
        const publicationRevision = positiveRevision(row.publication_revision, "publication head");
        const publicationRef = assertErasureIdentifier(row.publication_ref, "publication receipt ref");
        const updated = await database.prepare(
          "UPDATE artifact_publication_head SET disposition=?4,updated_at=?5 " +
          "WHERE artifact_id=?1 AND publication_revision=?2 AND publication_ref=?3 " +
          "AND (disposition='ACCEPTED' OR (?4='REDACTED_DEPENDENCY' AND disposition='PENDING_REVALIDATION')) " +
          "RETURNING disposition",
        ).bind(artifactId, publicationRevision, publicationRef, desiredHeadDisposition, now)
          .first<{ readonly disposition: unknown }>();
        const current = updated ?? await database.prepare(
          "SELECT disposition FROM artifact_publication_head WHERE artifact_id=?1 " +
          "AND publication_revision=?2 AND publication_ref=?3 LIMIT 1",
        ).bind(artifactId, publicationRevision, publicationRef).first<{ readonly disposition: unknown }>();
        if (current === null) continue;
        const finalDisposition = safePublicationDisposition(current.disposition);
        if (finalDisposition === "ACCEPTED") throw new Error("publication head invalidation did not change the accepted head");
        const dependentDisposition = finalDisposition === "REDACTED_DEPENDENCY" ? "REDACTED" : "PENDING_REVALIDATION";
        publicationInvalidations.push(await invalidation(
          "ArtifactRevision",
          dependentDisposition,
          `artifact:${artifactId}:${draftRevision}`,
          ledgerEntryRef,
        ));
      }
      for (const row of handles.values()) {
        const id = assertErasureIdentifier(row.handle_id, "evidence handle ID");
        const revision = positiveRevision(row.revision, "evidence handle");
        const ref = `evidence-handle:${id}:${revision}`;
        const item = await invalidation("EvidenceHandle", "REDACTED", ref, ledgerEntryRef);
        invalidations.push(item);
        await database.batch([
          database.prepare(
            "UPDATE evidence_handle SET terminal_state='REDACTED',invalidation_ref=?3 " +
            "WHERE handle_id=?1 AND revision=?2 AND terminal_state<>'RETENTION_BLOCKED'",
          ).bind(id, revision, item.receipt_ref),
          database.prepare(
            "INSERT INTO evidence_handle_invalidation(invalidation_ref,handle_id,handle_revision," +
            "terminal_state,reason_code,observed_at) VALUES (?1,?2,?3,'REDACTED'," +
            "'ERASURE_LEDGER_APPLIED',?4) ON CONFLICT(invalidation_ref) DO NOTHING",
          ).bind(item.receipt_ref, id, revision, now),
        ]);
      }

      for (const row of scopes.values()) {
        const id = assertErasureIdentifier(row.snapshot_id, "scope snapshot ID");
        const revision = positiveRevision(row.revision, "scope snapshot");
        const ref = `scope-snapshot:${id}:${revision}`;
        const item = await invalidation("ScopeSnapshot", "REVOKED", ref, ledgerEntryRef);
        invalidations.push(item);
        await database.batch([
          database.prepare(
            "UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,?3)," +
            "invalidation_reason='ERASURE_LEDGER_APPLIED' WHERE snapshot_id=?1 AND revision=?2",
          ).bind(id, revision, now),
          database.prepare(
            "UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 " +
            "AND snapshot_revision=?2 AND state='ACTIVE'",
          ).bind(id, revision),
        ]);
      }

      for (const revisionRef of revisions) {
        const item = await invalidation(
          "ProjectionGeneration",
          "RETIRED",
          `projection-source:${revisionRef}`,
          ledgerEntryRef,
        );
        invalidations.push(item);
        await database.batch([
          database.prepare(
            "UPDATE projection_generation SET state='RETIRED',reason_codes_json=" +
            "'[\"ERASURE_LEDGER_APPLIED\"]',updated_at=?2 WHERE source_revision_ref=?1",
          ).bind(revisionRef, now),
          database.prepare(
            "UPDATE source_readiness SET state='redacted',reason_codes_json=" +
            "'[\"ERASURE_LEDGER_APPLIED\"]',receipt_ref=?2,updated_at=?3 " +
            "WHERE source_revision_ref=?1",
          ).bind(revisionRef, item.receipt_ref, now),
        ]);
      }

      for (const scope of scopes.values()) {
        const id = String(scope.snapshot_id);
        const revision = positiveRevision(scope.revision, "scope snapshot");
        const wikiRows = await allRows<WikiRow>(database.prepare(
          "SELECT page_id,revision FROM wiki_revision WHERE scope_snapshot_id=?1 " +
          "AND scope_snapshot_revision=?2 ORDER BY page_id,revision LIMIT 10000",
        ).bind(id, revision), "wiki dependency");
        for (const row of wikiRows) {
          const ref = `wiki:${String(row.page_id)}:${String(row.revision)}`;
          invalidations.push(await invalidation("WikiRevision", "PENDING_REVALIDATION", ref, ledgerEntryRef));
        }
        await database.prepare(
          "UPDATE wiki_revision SET status='REDACTED_DEPENDENCY' WHERE scope_snapshot_id=?1 " +
          "AND scope_snapshot_revision=?2 AND status IN ('DRAFT','PUBLISHED','PENDING_REVALIDATION')",
        ).bind(id, revision).run();

        const artifacts = await allRows<ArtifactRow>(database.prepare(
          "SELECT ar.artifact_id,ar.revision FROM artifact_revision ar JOIN evidence_freeze ef " +
          "ON ef.freeze_id=ar.evidence_freeze_id AND ef.revision=ar.evidence_freeze_revision " +
          "WHERE ef.scope_snapshot_id=?1 AND ef.scope_snapshot_revision=?2 " +
          "ORDER BY ar.artifact_id,ar.revision LIMIT 10000",
        ).bind(id, revision), "artifact dependency");
        for (const row of artifacts) {
          const ref = `artifact:${String(row.artifact_id)}:${String(row.revision)}`;
          invalidations.push(await invalidation("ArtifactRevision", "PENDING_REVALIDATION", ref, ledgerEntryRef));
        }
        await database.prepare(
          "UPDATE artifact_revision SET status='REDACTED_DEPENDENCY' WHERE " +
          "(artifact_id,revision) IN (SELECT ar.artifact_id,ar.revision FROM artifact_revision ar " +
          "JOIN evidence_freeze ef ON ef.freeze_id=ar.evidence_freeze_id " +
          "AND ef.revision=ar.evidence_freeze_revision WHERE ef.scope_snapshot_id=?1 " +
          "AND ef.scope_snapshot_revision=?2) AND status IN ('DRAFT','PUBLISHED','PENDING_REVALIDATION')",
        ).bind(id, revision).run();

        const investigations = await allRows<InvestigationRow>(database.prepare(
          "SELECT investigation_id,revision FROM investigation WHERE scope_snapshot_id=?1 " +
          "AND scope_snapshot_revision=?2 ORDER BY investigation_id,revision LIMIT 10000",
        ).bind(id, revision), "investigation dependency");
        for (const row of investigations) {
          const ref = `investigation:${String(row.investigation_id)}:${String(row.revision)}`;
          invalidations.push(await invalidation("Investigation", "PENDING_REVALIDATION", ref, ledgerEntryRef));
        }
        await database.prepare(
          "UPDATE investigation SET current_stage='PENDING_REVALIDATION'," +
          "terminal_disposition='REDACTED_DEPENDENCY' WHERE scope_snapshot_id=?1 " +
          "AND scope_snapshot_revision=?2",
        ).bind(id, revision).run();
      }

      invalidations.push(...publicationInvalidations);
      const unique = new Map<string, ErasureDependentInvalidation>();
      for (const item of invalidations) unique.set(item.dependent_ref, item);
      return [...unique.values()].sort((left, right) => left.dependent_ref.localeCompare(right.dependent_ref));
    },
  };
}
