from pathlib import Path

path = Path("apps/eliotr-core/src/wiki-publication-store.ts")
source = path.read_text(encoding="utf-8")
start = source.index("      async commitHeadAndOutbox(")
end = source.index("      async readHead(", start)

method = '''      async commitHeadAndOutbox(input: WikiHeadCommit): Promise<WikiHeadCommitDisposition> {
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

'''

path.write_text(source[:start] + method + source[end:], encoding="utf-8", newline="\n")
