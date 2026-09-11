PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS wiki_publication_proposal (
  proposal_id TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision = 1),
  principal_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  page_id TEXT NOT NULL,
  page_revision INTEGER NOT NULL CHECK (page_revision > 0),
  page_sha256 TEXT NOT NULL CHECK (length(page_sha256) = 64),
  page_json TEXT NOT NULL,
  risk_class TEXT NOT NULL CHECK (risk_class IN ('D0_MECHANICAL','D1_LOW_RISK_ADDITIVE','D2_ANALYTICAL','D3_AUTHORITY_SENSITIVE')),
  body_size INTEGER NOT NULL CHECK (body_size > 0 AND body_size <= 8388608),
  evidence_map_sha256 TEXT NOT NULL CHECK (length(evidence_map_sha256) = 64),
  evidence_map_size INTEGER NOT NULL CHECK (evidence_map_size > 0 AND evidence_map_size <= 1048576),
  dependency_refs_sha256 TEXT NOT NULL CHECK (length(dependency_refs_sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('PROPOSED','PUBLISHED')),
  created_at TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (proposal_id, proposal_revision),
  UNIQUE (principal_ref, idempotency_key),
  CHECK ((state = 'PROPOSED' AND published_at IS NULL) OR (state = 'PUBLISHED' AND published_at IS NOT NULL))
);

CREATE TRIGGER IF NOT EXISTS wiki_publication_proposal_no_delete
BEFORE DELETE ON wiki_publication_proposal BEGIN SELECT RAISE(ABORT, 'WIKI_PROPOSAL_IMMUTABLE'); END;

CREATE TABLE IF NOT EXISTS wiki_publication_authority (
  proposal_id TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL,
  evidence_receipt_ref TEXT NOT NULL,
  coverage_receipt_json TEXT NOT NULL,
  dependency_closure_receipt_ref TEXT NOT NULL,
  verifier_receipt_ref TEXT NOT NULL,
  policy_receipt_ref TEXT,
  coverage_complete INTEGER NOT NULL CHECK (coverage_complete IN (0,1)),
  dependency_closure_complete INTEGER NOT NULL CHECK (dependency_closure_complete IN (0,1)),
  conflict_count INTEGER NOT NULL CHECK (conflict_count >= 0),
  changes_current_state INTEGER NOT NULL CHECK (changes_current_state IN (0,1)),
  state TEXT NOT NULL CHECK (state = 'VERIFIED'),
  admitted_at TEXT NOT NULL,
  PRIMARY KEY (proposal_id, proposal_revision),
  FOREIGN KEY (proposal_id, proposal_revision) REFERENCES wiki_publication_proposal(proposal_id, proposal_revision)
);

CREATE TRIGGER IF NOT EXISTS wiki_publication_authority_no_update
BEFORE UPDATE ON wiki_publication_authority BEGIN SELECT RAISE(ABORT, 'WIKI_AUTHORITY_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS wiki_publication_authority_no_delete
BEFORE DELETE ON wiki_publication_authority BEGIN SELECT RAISE(ABORT, 'WIKI_AUTHORITY_IMMUTABLE'); END;

CREATE TABLE IF NOT EXISTS wiki_publication_revision (
  page_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  proposal_id TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL,
  manifest_ref TEXT NOT NULL,
  page_sha256 TEXT NOT NULL CHECK (length(page_sha256) = 64),
  page_json TEXT NOT NULL,
  body_object_ref TEXT NOT NULL,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  committer_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (page_id, revision),
  UNIQUE (manifest_ref),
  FOREIGN KEY (proposal_id, proposal_revision) REFERENCES wiki_publication_proposal(proposal_id, proposal_revision)
);

CREATE TRIGGER IF NOT EXISTS wiki_publication_revision_no_update
BEFORE UPDATE ON wiki_publication_revision BEGIN SELECT RAISE(ABORT, 'WIKI_REVISION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS wiki_publication_revision_no_delete
BEFORE DELETE ON wiki_publication_revision BEGIN SELECT RAISE(ABORT, 'WIKI_REVISION_IMMUTABLE'); END;

CREATE TABLE IF NOT EXISTS wiki_publication_head (
  page_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  manifest_ref TEXT NOT NULL,
  outbox_ref TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (page_id, revision) REFERENCES wiki_publication_revision(page_id, revision)
);

CREATE TABLE IF NOT EXISTS wiki_publication_outbox (
  outbox_ref TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  manifest_ref TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('PENDING','DELIVERED','DEAD_LETTER')),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  FOREIGN KEY (page_id, revision) REFERENCES wiki_publication_revision(page_id, revision),
  UNIQUE (page_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_wiki_publication_outbox_pending
  ON wiki_publication_outbox(state, created_at);
