PRAGMA foreign_keys = ON;

-- A publication witness is a transaction-local fence.  The Core service
-- inserts it before the immutable revision, head, outbox, and proposal state
-- effects.  Every value below is read back from the owner authorization and
-- the current D1 authority before that batch begins.
CREATE TABLE IF NOT EXISTS wiki_owner_publication_guard (
  guard_id TEXT PRIMARY KEY CHECK(length(guard_id) BETWEEN 1 AND 256),
  page_id TEXT NOT NULL CHECK(length(page_id) BETWEEN 1 AND 256),
  page_revision INTEGER NOT NULL CHECK(page_revision BETWEEN 1 AND 1000000000),
  proposal_id TEXT NOT NULL CHECK(length(proposal_id) BETWEEN 1 AND 256),
  proposal_revision INTEGER NOT NULL CHECK(proposal_revision BETWEEN 1 AND 1000000000),
  expected_head_revision INTEGER CHECK(
    expected_head_revision IS NULL OR expected_head_revision BETWEEN 0 AND 1000000000
  ),
  manifest_ref TEXT NOT NULL CHECK(length(manifest_ref) BETWEEN 1 AND 512),
  page_sha256 TEXT NOT NULL CHECK(
    length(page_sha256) = 64 AND page_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  body_object_ref TEXT NOT NULL CHECK(length(body_object_ref) BETWEEN 1 AND 512),
  body_sha256 TEXT NOT NULL CHECK(
    length(body_sha256) = 64 AND body_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  committer_ref TEXT NOT NULL CHECK(length(committer_ref) BETWEEN 1 AND 256),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  client_class TEXT NOT NULL CHECK(client_class = 'owner_pwa'),
  credential_generation TEXT NOT NULL CHECK(length(credential_generation) BETWEEN 1 AND 256),
  authorization_receipt_ref TEXT NOT NULL CHECK(length(authorization_receipt_ref) BETWEEN 1 AND 256),
  scope_snapshot_id TEXT NOT NULL CHECK(length(scope_snapshot_id) BETWEEN 1 AND 256),
  scope_snapshot_revision INTEGER NOT NULL CHECK(scope_snapshot_revision BETWEEN 1 AND 1000000000),
  scope_snapshot_digest TEXT NOT NULL CHECK(
    length(scope_snapshot_digest) = 64 AND scope_snapshot_digest NOT GLOB '*[^0-9a-f]*'
  ),
  policy_generation TEXT NOT NULL CHECK(length(policy_generation) BETWEEN 1 AND 256),
  policy_authority_ref TEXT NOT NULL CHECK(length(policy_authority_ref) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  global_purge_revision INTEGER NOT NULL CHECK(global_purge_revision BETWEEN 0 AND 1000000000),
  scope_purge_revision INTEGER NOT NULL CHECK(scope_purge_revision BETWEEN 0 AND 1000000000),
  orientation_epoch INTEGER NOT NULL CHECK(orientation_epoch BETWEEN 1 AND 1000000000),
  ledger_epoch INTEGER NOT NULL CHECK(ledger_epoch BETWEEN 1 AND 1000000000),
  source_revision_refs_json TEXT NOT NULL CHECK(
    json_valid(source_revision_refs_json)
    AND json_type(source_revision_refs_json) = 'array'
    AND json_array_length(source_revision_refs_json) BETWEEN 0 AND 64
    AND length(CAST(source_revision_refs_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  source_owner_generations_json TEXT NOT NULL CHECK(
    json_valid(source_owner_generations_json)
    AND json_type(source_owner_generations_json) = 'object'
    AND length(CAST(source_owner_generations_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  allowed_use_json TEXT NOT NULL CHECK(
    json_valid(allowed_use_json)
    AND json_type(allowed_use_json) = 'array'
    AND json_array_length(allowed_use_json) BETWEEN 1 AND 16
    AND length(CAST(allowed_use_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  disclosure_ceiling TEXT NOT NULL CHECK(length(disclosure_ceiling) BETWEEN 1 AND 256),
  scope_expires_at TEXT NOT NULL CHECK(
    scope_expires_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(scope_expires_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', scope_expires_at) IS scope_expires_at
  ),
  grant_expires_at TEXT NOT NULL CHECK(
    grant_expires_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(grant_expires_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', grant_expires_at) IS grant_expires_at
  ),
  observed_at TEXT NOT NULL CHECK(
    observed_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(observed_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS observed_at
  ),
  expires_at TEXT NOT NULL CHECK(
    expires_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(expires_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at
  ),
  CHECK(committer_ref IS principal_ref),
  CHECK(julianday(scope_expires_at) > julianday(observed_at)),
  CHECK(julianday(grant_expires_at) > julianday(observed_at)),
  CHECK(julianday(expires_at) > julianday(observed_at)),
  CHECK(julianday(expires_at) <= julianday(scope_expires_at)),
  CHECK(julianday(expires_at) <= julianday(grant_expires_at)),
  FOREIGN KEY(scope_snapshot_id, scope_snapshot_revision)
    REFERENCES scope_snapshot(snapshot_id, revision)
) STRICT;

CREATE INDEX IF NOT EXISTS wiki_owner_publication_guard_page_idx
  ON wiki_owner_publication_guard(page_id, page_revision);
CREATE INDEX IF NOT EXISTS wiki_owner_publication_guard_proposal_idx
  ON wiki_owner_publication_guard(proposal_id, proposal_revision, principal_ref);

-- The witness is append-only.  Publication effects do not mutate or remove
-- the authority record, so its exact currentness evidence remains durable.
CREATE TRIGGER IF NOT EXISTS wiki_owner_publication_guard_immutable_update
BEFORE UPDATE ON wiki_owner_publication_guard
BEGIN
  SELECT RAISE(ABORT, 'WIKI_PUBLICATION_GUARD_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS wiki_owner_publication_guard_immutable_delete
BEFORE DELETE ON wiki_owner_publication_guard
BEGIN
  SELECT RAISE(ABORT, 'WIKI_PUBLICATION_GUARD_IMMUTABLE');
END;

-- The proposal and expected head are the exact CAS target.  A guard cannot
-- authorize a different proposal body or a concurrent head revision.
CREATE TRIGGER IF NOT EXISTS wiki_owner_publication_guard_target_current
BEFORE INSERT ON wiki_owner_publication_guard
BEGIN
  SELECT RAISE(ABORT, 'WIKI_PUBLICATION_TARGET_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM wiki_publication_proposal p
    WHERE p.proposal_id = NEW.proposal_id
      AND p.proposal_revision = NEW.proposal_revision
      AND p.principal_ref = NEW.principal_ref
      AND p.page_id = NEW.page_id
      AND p.page_revision = NEW.page_revision
      AND json_extract(p.page_json, '$.body_sha256') IS NEW.body_sha256
      AND json_extract(p.page_json, '$.body_object_ref') IS NEW.body_object_ref
      AND p.state = 'PROPOSED'
  );

  SELECT RAISE(ABORT, 'WIKI_PUBLICATION_HEAD_STALE')
  WHERE (NEW.expected_head_revision IS NULL
         AND EXISTS (SELECT 1 FROM wiki_publication_head h WHERE h.page_id = NEW.page_id))
     OR (NEW.expected_head_revision IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM wiki_publication_head h
           WHERE h.page_id = NEW.page_id AND h.revision = NEW.expected_head_revision
         ));
END;

-- Snapshot identity, member set, policy authority, and purge frontier must
-- still be the exact values read into the witness and must not be expired.
CREATE TRIGGER IF NOT EXISTS wiki_owner_publication_guard_scope_current
BEFORE INSERT ON wiki_owner_publication_guard
BEGIN
  SELECT RAISE(ABORT, 'WIKI_PUBLICATION_SCOPE_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM scope_snapshot s
    WHERE s.snapshot_id = NEW.scope_snapshot_id
      AND s.revision = NEW.scope_snapshot_revision
      AND s.snapshot_digest = NEW.scope_snapshot_digest
      AND s.member_source_revision_refs_json IS NEW.source_revision_refs_json
      AND s.source_owner_generations_json IS NEW.source_owner_generations_json
      AND s.policy_authority_ref IS NEW.policy_authority_ref
      AND s.purge_ledger_revision = NEW.scope_purge_revision
      AND s.invalidated_at IS NULL
      AND s.expires_at IS NEW.scope_expires_at
      AND julianday(s.expires_at) > julianday(NEW.observed_at)
      AND julianday(s.expires_at) > julianday('now')
  );
END;

-- Grant allowed_use is compared as a set: the witness is canonical and
-- sorted, while the persisted grant is an older JSON representation.
CREATE TRIGGER IF NOT EXISTS wiki_owner_publication_guard_grant_current
BEFORE INSERT ON wiki_owner_publication_guard
BEGIN
  SELECT RAISE(ABORT, 'WIKI_PUBLICATION_GRANT_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM scope_access_grant g
    WHERE g.snapshot_id = NEW.scope_snapshot_id
      AND g.snapshot_revision = NEW.scope_snapshot_revision
      AND g.principal_ref = NEW.principal_ref
      AND g.client_class = NEW.client_class
      AND g.credential_generation = NEW.credential_generation
      AND g.policy_authority_ref = NEW.policy_authority_ref
      AND g.authorization_receipt_ref = NEW.authorization_receipt_ref
      AND g.disclosure_ceiling = NEW.disclosure_ceiling
      AND g.state = 'ACTIVE'
      AND g.expires_at IS NEW.grant_expires_at
      AND julianday(g.expires_at) > julianday(NEW.observed_at)
      AND julianday(g.expires_at) > julianday('now')
      AND json_type(g.allowed_use_json) = 'array'
      AND json_array_length(g.allowed_use_json) = json_array_length(NEW.allowed_use_json)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(g.allowed_use_json) gu
        WHERE NOT EXISTS (
          SELECT 1 FROM json_each(NEW.allowed_use_json) wu WHERE wu.value IS gu.value
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.allowed_use_json) wu
        WHERE NOT EXISTS (
          SELECT 1 FROM json_each(g.allowed_use_json) gu WHERE gu.value IS wu.value
        )
      )
      AND EXISTS (
        SELECT 1 FROM json_each(g.allowed_use_json) gu WHERE gu.value = 'research'
      )
  );
END;

CREATE TRIGGER IF NOT EXISTS wiki_owner_publication_guard_policy_current
BEFORE INSERT ON wiki_owner_publication_guard
BEGIN
  SELECT RAISE(ABORT, 'WIKI_PUBLICATION_POLICY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM investigation_current_policy p
    WHERE p.policy_generation = NEW.policy_generation
      AND p.policy_authority_ref = NEW.policy_authority_ref
      AND p.state = 'ACTIVE'
  );
END;

CREATE TRIGGER IF NOT EXISTS wiki_owner_publication_guard_deployment_current
BEFORE INSERT ON wiki_owner_publication_guard
BEGIN
  SELECT RAISE(ABORT, 'WIKI_PUBLICATION_DEPLOYMENT_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM investigation_current_deployment d
    WHERE d.deployment_generation = NEW.deployment_generation
      AND d.state = 'ACTIVE'
  );
END;

CREATE TRIGGER IF NOT EXISTS wiki_owner_publication_guard_purge_current
BEFORE INSERT ON wiki_owner_publication_guard
BEGIN
  SELECT RAISE(ABORT, 'WIKI_PUBLICATION_PURGE_STALE')
  WHERE NEW.global_purge_revision IS NOT COALESCE(
          (SELECT MAX(ledger_revision) FROM purge_ledger), 0
        )
     OR NEW.scope_purge_revision IS NOT (
          SELECT s.purge_ledger_revision FROM scope_snapshot s
          WHERE s.snapshot_id = NEW.scope_snapshot_id AND s.revision = NEW.scope_snapshot_revision
        )
     OR (
          SELECT s.purge_ledger_revision FROM scope_snapshot s
          WHERE s.snapshot_id = NEW.scope_snapshot_id AND s.revision = NEW.scope_snapshot_revision
        ) < COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger), 0);
END;

CREATE TRIGGER IF NOT EXISTS wiki_owner_publication_guard_epoch_current
BEFORE INSERT ON wiki_owner_publication_guard
BEGIN
  SELECT RAISE(ABORT, 'WIKI_PUBLICATION_ORIENTATION_STALE')
  WHERE NEW.orientation_epoch IS NOT (
    SELECT generation FROM orientation_authority_epoch WHERE singleton = 1
  );

  SELECT RAISE(ABORT, 'WIKI_PUBLICATION_LEDGER_STALE')
  WHERE NEW.ledger_epoch IS NOT (
    SELECT generation FROM investigation_ledger_epoch WHERE singleton = 1
  );
END;

-- Every frozen source must still have an active owner, an ADMITTED decision,
-- a LIVE revision, and an active owner_pwa read policy.  Allowed-use values
-- are checked as sets because both source decisions and read policies may be
-- persisted with a different JSON ordering than the canonical witness.
CREATE TRIGGER IF NOT EXISTS wiki_owner_publication_guard_sources_current
BEFORE INSERT ON wiki_owner_publication_guard
BEGIN
  SELECT RAISE(ABORT, 'WIKI_PUBLICATION_SOURCE_STALE')
  WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.source_revision_refs_json) member
    WHERE NOT EXISTS (
      SELECT 1
      FROM source_revision sr
      JOIN source s ON s.source_id = sr.source_id
      JOIN source_namespace_ownership owner
        ON owner.source_namespace_id = s.source_namespace_id
       AND owner.status = 'ACTIVE'
       AND owner.owner_system_id IS s.source_owner_system_id
      JOIN source_admission_decision admission
        ON admission.source_revision_ref = sr.source_revision_ref
       AND admission.decision = 'ADMITTED'
      JOIN scope_read_policy policy
        ON policy.source_namespace_id = s.source_namespace_id
       AND policy.principal_ref = NEW.principal_ref
       AND policy.client_class = NEW.client_class
       AND policy.state = 'ACTIVE'
      WHERE member.type = 'text'
        AND sr.source_revision_ref = member.value
        AND sr.purge_state = 'LIVE'
        AND sr.source_owner_generation IS owner.source_owner_generation
        AND json_extract(
              NEW.source_owner_generations_json,
              '$."' || member.value || '"'
            ) IS sr.source_owner_generation
        AND admission.source_namespace_id IS s.source_namespace_id
        AND admission.owner_system_id IS s.source_owner_system_id
        AND admission.source_owner_generation IS sr.source_owner_generation
        AND admission.source_revision_ref IS sr.source_revision_ref
        AND (admission.expires_at IS NULL
             OR julianday(admission.expires_at) > julianday(NEW.observed_at))
        AND (admission.expires_at IS NULL
             OR julianday(admission.expires_at) > julianday('now'))
        AND admission.disclosure_ceiling IS NEW.disclosure_ceiling
        AND policy.disclosure_ceiling IS NEW.disclosure_ceiling
        AND julianday(policy.expires_at) > julianday(NEW.observed_at)
        AND julianday(policy.expires_at) > julianday('now')
        AND json_type(admission.allowed_use_json) = 'array'
        AND json_type(policy.allowed_use_json) = 'array'
        AND EXISTS (
          SELECT 1 FROM json_each(admission.allowed_use_json) au
          WHERE au.value = 'research'
        )
        AND EXISTS (
          SELECT 1 FROM json_each(policy.allowed_use_json) pu
          WHERE pu.value = 'research'
        )
        AND NOT EXISTS (
          SELECT 1 FROM json_each(admission.allowed_use_json) au
          WHERE NOT EXISTS (
            SELECT 1 FROM json_each(policy.allowed_use_json) pu
            WHERE pu.value IS au.value
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM json_each(admission.allowed_use_json) au
          WHERE NOT EXISTS (
            SELECT 1 FROM json_each(NEW.allowed_use_json) wu
            WHERE wu.value IS au.value
          )
        )
    )
  );
END;
