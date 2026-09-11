import {
  VersionedRefSchema,
  WikiPageRevisionSchema,
  type WikiPageRevision,
} from "@eliotr/contracts";
import {
  type WikiHeadCommit,
  type WikiHeadCommitDisposition,
  type WikiHeadReadback,
  type WikiPublicationPort,
} from "@eliotr/research";
import {
  MAX_BODY_BYTES,
  MAX_EVIDENCE_MAP_BYTES,
  MAX_MANIFEST_BYTES,
  RISK_CLASSES,
  SAFE_REF,
  decodeProposal,
  dependencyDigest,
  fail,
  loadAuthority,
  loadProposalRow,
  nowIso,
  pageJson,
  readObject,
  sameCoverage,
  sha256,
  textDigest,
  validIdempotency,
  validPrincipal,
  validRef,
  type AuthorityRow,
  type HeadRow,
  type ProposalRow,
  type WikiStoreContext,
} from "./wiki-publication-store-support.js";

export {
  recordWikiPublicationAuthority,
  type WikiAuthorityAdmission,
  type WikiStoreContext,
} from "./wiki-publication-store-support.js";

export function createD1R2WikiPublicationPort(
  database: D1Database,
  bucket: R2Bucket,
  context: WikiStoreContext,
): WikiPublicationPort {
  const principal = validPrincipal(context.principal_ref);
  const idempotencyKey = validIdempotency(context.idempotency_key);
  let active: ProposalRow | null = null;

  async function authorityFor(page: WikiPageRevision): Promise<AuthorityRow | null> {
    const proposal = active;
    if (proposal === null || proposal.page_id !== page.page_ref.id || proposal.page_revision !== page.page_ref.revision) {
      return null;
    }
    return loadAuthority(database, proposal);
  }

  return {
    async saveProposal(page, riskClass) {
      if (!RISK_CLASSES.has(riskClass)) fail("WIKI_INPUT_INVALID", "draft risk class is invalid");
      const encoded = pageJson(page);
      const pageSha = await textDigest(encoded);
      const body = await readObject(bucket, page.body_object_ref, MAX_BODY_BYTES);
      if (body.sha256 !== page.body_sha256) {
        fail("WIKI_PUBLICATION_INCOMPLETE", "Wiki body digest does not match the admitted page");
      }
      const evidence = await readObject(bucket, page.evidence_map_ref, MAX_EVIDENCE_MAP_BYTES);
      const dependenciesSha = await dependencyDigest(page);
      const requestSha = await textDigest(JSON.stringify({
        principal_ref: principal,
        idempotency_key: idempotencyKey,
        page_sha256: pageSha,
        risk_class: riskClass,
        body_size: body.bytes.byteLength,
        evidence_map_sha256: evidence.sha256,
        evidence_map_size: evidence.bytes.byteLength,
        dependency_refs_sha256: dependenciesSha,
      }));
      const proposalId = `wiki-proposal-${requestSha.slice(0, 48)}`;
      try {
        await database.prepare(
          "INSERT OR IGNORE INTO wiki_publication_proposal " +
          "(proposal_id, proposal_revision, principal_ref, idempotency_key, request_sha256, page_id, " +
          "page_revision, page_sha256, page_json, risk_class, body_size, evidence_map_sha256, " +
          "evidence_map_size, dependency_refs_sha256, state, created_at) " +
          "VALUES (?1,1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'PROPOSED',?14)",
        ).bind(
          proposalId, principal, idempotencyKey, requestSha, page.page_ref.id, page.page_ref.revision,
          pageSha, encoded, riskClass, body.bytes.byteLength, evidence.sha256, evidence.bytes.byteLength,
          dependenciesSha, nowIso(context),
        ).run();
      } catch (cause) {
        fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki proposal mutation is uncertain", true, cause);
      }
      let row: ProposalRow | null;
      try {
        row = await database.prepare(
          "SELECT proposal_id, proposal_revision, principal_ref, idempotency_key, request_sha256, page_id, " +
          "page_revision, page_sha256, page_json, risk_class, body_size, evidence_map_sha256, " +
          "evidence_map_size, dependency_refs_sha256, state FROM wiki_publication_proposal " +
          "WHERE principal_ref = ?1 AND idempotency_key = ?2 LIMIT 1",
        ).bind(principal, idempotencyKey).first<ProposalRow>();
      } catch (cause) {
        fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki proposal readback is unavailable", true, cause);
      }
      if (row === null || row.proposal_id !== proposalId || row.request_sha256 !== requestSha
          || row.page_sha256 !== pageSha || row.page_json !== encoded || row.risk_class !== riskClass
          || row.body_size !== body.bytes.byteLength || row.evidence_map_sha256 !== evidence.sha256
          || row.evidence_map_size !== evidence.bytes.byteLength || row.dependency_refs_sha256 !== dependenciesSha) {
        fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki proposal idempotency identity is occupied by different bytes");
      }
      active = row;
      return { id: proposalId, revision: 1 };
    },

    async readProposal(proposalRef) {
      const parsed = VersionedRefSchema.safeParse(proposalRef);
      if (!parsed.success || parsed.data.revision !== 1) fail("WIKI_INPUT_INVALID", "proposal reference is invalid");
      const row = await loadProposalRow(database, parsed.data, principal);
      if (row === null) return null;
      const decoded = decodeProposal(row);
      if (await textDigest(pageJson(decoded.page)) !== row.page_sha256) {
        fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki proposal digest is corrupt");
      }
      active = row;
      return decoded;
    },

    async validateEvidenceMap(page) {
      const proposal = active;
      const authority = await authorityFor(page);
      if (proposal === null || authority === null || authority.state !== "VERIFIED" || authority.evidence_receipt_ref.length < 1) return false;
      const evidence = await readObject(bucket, page.evidence_map_ref, MAX_EVIDENCE_MAP_BYTES);
      return evidence.sha256 === proposal.evidence_map_sha256 && evidence.bytes.byteLength === proposal.evidence_map_size;
    },

    async validateCoverage(page) {
      const authority = await authorityFor(page);
      return authority !== null && authority.state === "VERIFIED" && authority.coverage_complete === 1
        && authority.conflict_count === 0 && authority.changes_current_state === 0
        && authority.verifier_receipt_ref.length > 0 && sameCoverage(page, authority.coverage_receipt_json);
    },

    async validateDependencyClosure(page) {
      const proposal = active;
      const authority = await authorityFor(page);
      return proposal !== null && authority !== null && authority.state === "VERIFIED"
        && authority.dependency_closure_complete === 1 && authority.dependency_closure_receipt_ref.length > 0
        && await dependencyDigest(page) === proposal.dependency_refs_sha256;
    },

    async writeImmutableRevision(page) {
      const encoded = pageJson(page);
      const bytes = new TextEncoder().encode(encoded);
      const manifestSha = await sha256(bytes);
      const pageKey = (await textDigest(page.page_ref.id)).slice(0, 32);
      const key = `wiki/revisions/${pageKey}/${page.page_ref.revision}/${manifestSha}.json`;
      try {
        await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, sha256: manifestSha,
          customMetadata: { immutable: "true", page_id_sha256: await textDigest(page.page_ref.id), page_revision: String(page.page_ref.revision) } });
      } catch {
        // Conditional collision and lost acknowledgement both require exact readback.
      }
      const observed = await readObject(bucket, key, MAX_MANIFEST_BYTES);
      if (observed.sha256 !== manifestSha || new TextDecoder("utf-8", { fatal: true }).decode(observed.bytes) !== encoded) {
        fail("WIKI_IMMUTABLE_READBACK_MISMATCH", "immutable Wiki revision failed exact R2 readback");
      }
      return { page_ref: { ...page.page_ref }, manifest_ref: key, body_object_ref: page.body_object_ref, body_sha256: page.body_sha256 };
    },

    async readImmutableRevision(pageRef, manifestRef) {
      const parsedRef = VersionedRefSchema.safeParse(pageRef);
      if (!parsedRef.success) fail("WIKI_INPUT_INVALID", "Wiki page reference is invalid");
      const observed = await readObject(bucket, manifestRef, MAX_MANIFEST_BYTES);
      let decoded: unknown;
      try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(observed.bytes)); }
      catch (cause) { fail("WIKI_IMMUTABLE_READBACK_MISMATCH", "immutable Wiki revision is malformed", false, cause); }
      const page = WikiPageRevisionSchema.safeParse(decoded);
      if (!page.success || page.data.page_ref.id !== parsedRef.data.id || page.data.page_ref.revision !== parsedRef.data.revision) {
        fail("WIKI_IMMUTABLE_READBACK_MISMATCH", "immutable Wiki revision identity is foreign");
      }
      return page.data;
    },

          async commitHeadAndOutbox(input: WikiHeadCommit): Promise<WikiHeadCommitDisposition> {
        const proposal = active;
        if (proposal === null || input.proposal_ref.id !== proposal.proposal_id
            || input.proposal_ref.revision !== proposal.proposal_revision) {
          fail("WIKI_HEAD_CONFLICT", "Wiki commit is not bound to the active proposal");
        }
        const current = await this.readHead(input.page.page_ref.id);
        if (current !== null && current.page_ref.revision === input.page.page_ref.revision) {
          return current.manifest_ref === input.manifest_ref ? "EXISTING" : "CONFLICT";
        }
        const currentRevision = current?.page_ref.revision ?? null;
        if (currentRevision !== input.expected_head_revision) return "CONFLICT";

        const encoded = pageJson(input.page);
        const pageSha = await textDigest(encoded);
        const outboxRef = `wiki-outbox-${(await textDigest(
          `${input.page.page_ref.id}:${input.page.page_ref.revision}:${input.manifest_ref}`,
        )).slice(0, 48)}`;
        const timestamp = nowIso(context);
        const revisionValues = [
          input.page.page_ref.id,
          input.page.page_ref.revision,
          proposal.proposal_id,
          proposal.proposal_revision,
          input.manifest_ref,
          pageSha,
          encoded,
          input.page.body_object_ref,
          input.page.body_sha256,
          input.committer_ref,
          timestamp,
        ] as const;

        const revisionStatement = input.expected_head_revision === null
          ? database.prepare(
            "INSERT OR IGNORE INTO wiki_publication_revision " +
            "(page_id, revision, proposal_id, proposal_revision, manifest_ref, page_sha256, page_json, " +
            "body_object_ref, body_sha256, committer_ref, created_at) " +
            "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11 " +
            "WHERE NOT EXISTS (SELECT 1 FROM wiki_publication_head WHERE page_id = ?1)",
          ).bind(...revisionValues)
          : database.prepare(
            "INSERT OR IGNORE INTO wiki_publication_revision " +
            "(page_id, revision, proposal_id, proposal_revision, manifest_ref, page_sha256, page_json, " +
            "body_object_ref, body_sha256, committer_ref, created_at) " +
            "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11 " +
            "WHERE EXISTS (SELECT 1 FROM wiki_publication_head WHERE page_id = ?1 AND revision = ?12)",
          ).bind(...revisionValues, input.expected_head_revision);

        const exactRevision =
          "EXISTS (SELECT 1 FROM wiki_publication_revision " +
          "WHERE page_id = ?1 AND revision = ?2 AND manifest_ref = ?3 " +
          "AND page_sha256 = ?7 AND proposal_id = ?8 AND proposal_revision = ?9)";
        const headStatement = input.expected_head_revision === null
          ? database.prepare(
            "INSERT OR IGNORE INTO wiki_publication_head " +
            "(page_id, revision, manifest_ref, outbox_ref, updated_at) " +
            "SELECT ?1,?2,?3,?4,?5 WHERE NOT EXISTS " +
            "(SELECT 1 FROM wiki_publication_head WHERE page_id = ?1) AND " + exactRevision,
          ).bind(
            input.page.page_ref.id,
            input.page.page_ref.revision,
            input.manifest_ref,
            outboxRef,
            timestamp,
            null,
            pageSha,
            proposal.proposal_id,
            proposal.proposal_revision,
          )
          : database.prepare(
            "UPDATE wiki_publication_head SET revision = ?2, manifest_ref = ?3, " +
            "outbox_ref = ?4, updated_at = ?5 WHERE page_id = ?1 AND revision = ?6 AND " + exactRevision,
          ).bind(
            input.page.page_ref.id,
            input.page.page_ref.revision,
            input.manifest_ref,
            outboxRef,
            timestamp,
            input.expected_head_revision,
            pageSha,
            proposal.proposal_id,
            proposal.proposal_revision,
          );

        const statements = [
          revisionStatement,
          headStatement,
          database.prepare(
            "INSERT OR IGNORE INTO wiki_publication_outbox " +
            "(outbox_ref, page_id, revision, manifest_ref, payload_sha256, state, created_at) " +
            "SELECT ?1,?2,?3,?4,?5,'PENDING',?6 WHERE EXISTS " +
            "(SELECT 1 FROM wiki_publication_head WHERE page_id = ?2 AND revision = ?3 " +
            "AND manifest_ref = ?4 AND outbox_ref = ?1)",
          ).bind(
            outboxRef,
            input.page.page_ref.id,
            input.page.page_ref.revision,
            input.manifest_ref,
            pageSha,
            timestamp,
          ),
          database.prepare(
            "UPDATE wiki_publication_proposal SET state = 'PUBLISHED', published_at = ?3 " +
            "WHERE proposal_id = ?1 AND proposal_revision = ?2 AND state IN ('PROPOSED','PUBLISHED') " +
            "AND EXISTS (SELECT 1 FROM wiki_publication_head WHERE page_id = ?4 AND revision = ?5 " +
            "AND manifest_ref = ?6 AND outbox_ref = ?7)",
          ).bind(
            proposal.proposal_id,
            proposal.proposal_revision,
            timestamp,
            input.page.page_ref.id,
            input.page.page_ref.revision,
            input.manifest_ref,
            outboxRef,
          ),
        ];

        let batchCause: unknown = undefined;
        try {
          await database.batch(statements);
        } catch (cause) {
          batchCause = cause;
        }

        const settled = await this.readHead(input.page.page_ref.id);
        if (settled !== null && settled.page_ref.revision === input.page.page_ref.revision
            && settled.manifest_ref === input.manifest_ref && settled.outbox_ref === outboxRef) {
          let closure: {
            revision_manifest_ref: string;
            revision_page_sha256: string;
            revision_proposal_id: string;
            revision_proposal_revision: number;
            outbox_ref: string;
            outbox_manifest_ref: string;
            outbox_payload_sha256: string;
            proposal_state: string;
          } | null;
          try {
            closure = await database.prepare(
              "SELECT r.manifest_ref AS revision_manifest_ref, r.page_sha256 AS revision_page_sha256, " +
              "r.proposal_id AS revision_proposal_id, r.proposal_revision AS revision_proposal_revision, " +
              "o.outbox_ref AS outbox_ref, o.manifest_ref AS outbox_manifest_ref, " +
              "o.payload_sha256 AS outbox_payload_sha256, p.state AS proposal_state " +
              "FROM wiki_publication_revision r JOIN wiki_publication_outbox o " +
              "ON o.page_id = r.page_id AND o.revision = r.revision " +
              "JOIN wiki_publication_proposal p ON p.proposal_id = r.proposal_id " +
              "AND p.proposal_revision = r.proposal_revision " +
              "WHERE r.page_id = ?1 AND r.revision = ?2 LIMIT 1",
            ).bind(input.page.page_ref.id, input.page.page_ref.revision).first<{
              revision_manifest_ref: string;
              revision_page_sha256: string;
              revision_proposal_id: string;
              revision_proposal_revision: number;
              outbox_ref: string;
              outbox_manifest_ref: string;
              outbox_payload_sha256: string;
              proposal_state: string;
            }>();
          } catch (cause) {
            fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki publication closure readback is unavailable", true, cause);
          }
          if (closure !== null
              && closure.revision_manifest_ref === input.manifest_ref
              && closure.revision_page_sha256 === pageSha
              && closure.revision_proposal_id === proposal.proposal_id
              && closure.revision_proposal_revision === proposal.proposal_revision
              && closure.outbox_ref === outboxRef
              && closure.outbox_manifest_ref === input.manifest_ref
              && closure.outbox_payload_sha256 === pageSha
              && closure.proposal_state === "PUBLISHED") {
            return "COMMITTED";
          }
          fail(
            "WIKI_SETTLEMENT_UNCERTAIN",
            "Wiki head exists without exact revision, outbox and proposal closure",
            true,
            batchCause,
          );
        }

        const authorityMoved = current === null
          ? settled !== null
          : settled === null
            || settled.page_ref.revision !== current.page_ref.revision
            || settled.manifest_ref !== current.manifest_ref
            || settled.outbox_ref !== current.outbox_ref;
        if (authorityMoved) return "CONFLICT";
        if (batchCause !== undefined) {
          fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki head and outbox transaction is uncertain", true, batchCause);
        }
        return "CONFLICT";
      },

async readHead(pageId): Promise<WikiHeadReadback | null> {
      validRef(pageId, "Wiki page id");
      let row: HeadRow | null;
      try {
        row = await database.prepare(
          "SELECT page_id, revision, manifest_ref, outbox_ref FROM wiki_publication_head WHERE page_id = ?1 LIMIT 1",
        ).bind(pageId).first<HeadRow>();
      } catch (cause) {
        fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki head readback is unavailable", true, cause);
      }
      if (row === null) return null;
      if (row.page_id !== pageId || !Number.isSafeInteger(row.revision) || row.revision < 1
          || !SAFE_REF.test(row.manifest_ref) || !SAFE_REF.test(row.outbox_ref)) {
        fail("WIKI_IMMUTABLE_READBACK_MISMATCH", "Wiki head row is malformed");
      }
      return { page_ref: { id: row.page_id, revision: row.revision }, manifest_ref: row.manifest_ref, outbox_ref: row.outbox_ref };
    },
  };
}
