-- Eliot Research replacement schema, starter version.
-- Rules live in docs/IMPLEMENTATION.md §4; this file owns table, column and state names.
-- Edit this file in place until its first remote apply; after that, add numbered migrations.
--
-- Conventions: TEXT UUID primary keys, INTEGER Unix-millisecond timestamps, 0/1 INTEGER booleans.
-- `actor` columns hold the server-resolved actor ID ('owner' or 'agent:<agent.id>'), never a client-supplied name.
-- Bodies live in R2 (keys in IMPLEMENTATION §4) or in the chat Durable Object, not here.
-- Input tables reference exactly one source revision or one page revision (CHECK + expression unique index).

-- Models -------------------------------------------------------------------

CREATE TABLE model_connection (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('workers_ai', 'gateway_catalog', 'dynamic_route', 'vendor_byok', 'custom_provider')),
  gateway_id TEXT,
  provider TEXT,
  credential_ref TEXT,              -- Secrets Store / Gateway BYOK key name; never the secret value
  status TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (status IN ('unchecked', 'ok', 'auth_failed', 'unreachable')),
  status_message TEXT,
  checked_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE model_profile (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES model_connection(id),
  model_id TEXT NOT NULL,           -- provider-native, catalog or dynamic route ID, unchanged
  label TEXT NOT NULL,
  profile_version INTEGER NOT NULL DEFAULT 1,  -- bump on any capability edit; turns/jobs pin it
  context_tokens INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL,
  streaming INTEGER NOT NULL DEFAULT 1,
  image_input INTEGER NOT NULL DEFAULT 0,
  tools INTEGER NOT NULL DEFAULT 0,
  structured_output INTEGER NOT NULL DEFAULT 0,
  capability_source TEXT NOT NULL
    CHECK (capability_source IN ('provider_doc', 'catalog', 'owner', 'observed', 'conservative_default')),
  billing_mode TEXT NOT NULL CHECK (billing_mode IN ('workers_ai', 'unified', 'byok', 'custom', 'unknown')),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'deprecated', 'retired', 'unknown')),
  privacy_note TEXT,                -- owner-visible logging/retention/ZDR summary for this route
  enabled INTEGER NOT NULL DEFAULT 1,
  checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (connection_id, model_id)
);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  chat_model_profile_id TEXT REFERENCES model_profile(id),
  research_model_profile_id TEXT REFERENCES model_profile(id),
  search_instance TEXT NOT NULL DEFAULT 'library-v1',
  search_config_version INTEGER NOT NULL DEFAULT 1,  -- index-shaping config the current instance was built with
  conversion_support_json TEXT,     -- cached toMarkdown().supported() result
  conversion_support_checked_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- Outgoing MCP tools -------------------------------------------------------

CREATE TABLE mcp_connection (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,         -- canonical HTTPS endpoint chosen by the owner
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('none', 'oauth', 'secret_header')),
  credential_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'needs_auth', 'needs_scope', 'catalog_changed', 'failed')),
  catalog_fingerprint TEXT,
  checked_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Owner-approved tools. A changed descriptor digest blocks only that tool until re-approved.
CREATE TABLE mcp_tool (
  connection_id TEXT NOT NULL REFERENCES mcp_connection(id),
  tool_name TEXT NOT NULL,
  descriptor_digest TEXT NOT NULL,
  effect_class TEXT NOT NULL CHECK (effect_class IN ('read', 'mutate', 'spend')),
  approved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, tool_name)
);

-- Projects and Library -----------------------------------------------------

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  archived_at INTEGER,
  chat_model_profile_id TEXT REFERENCES model_profile(id),
  research_model_profile_id TEXT REFERENCES model_profile(id),
  settings_json TEXT NOT NULL DEFAULT '{}',  -- response style/length/instructions and default tool selection
  agent_edit_mode TEXT NOT NULL DEFAULT 'review' CHECK (agent_edit_mode IN ('review', 'direct')),
  corpus_version INTEGER NOT NULL DEFAULT 0, -- bumped on membership change; flags project-wide pages
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE source (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'url', 'text')),
  origin_url TEXT,
  language TEXT,
  published TEXT,                   -- date as given by the source, possibly partial ('2024', '2024-05')
  metadata_version INTEGER NOT NULL DEFAULT 1,
  current_revision_id TEXT REFERENCES source_revision(id),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived', 'deleting', 'deleted')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE source_author (
  source_id TEXT NOT NULL REFERENCES source(id),
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (source_id, position)
);
CREATE INDEX source_author_name ON source_author(name);

CREATE TABLE source_tag (
  source_id TEXT NOT NULL REFERENCES source(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (source_id, tag)
);
CREATE INDEX source_tag_tag ON source_tag(tag);

-- Normalized external IDs. Equal IDs produce owner-visible duplicate candidates, not merges.
CREATE TABLE source_identifier (
  source_id TEXT NOT NULL REFERENCES source(id),
  scheme TEXT NOT NULL CHECK (scheme IN ('doi', 'arxiv', 'isbn', 'pmid', 'url', 'other')),
  value TEXT NOT NULL,
  PRIMARY KEY (source_id, scheme, value)
);
CREATE INDEX source_identifier_value ON source_identifier(scheme, value);

CREATE TABLE source_revision (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(id),
  revision_no INTEGER NOT NULL,
  original_key TEXT,                -- source/<revision>/original; NULL for pasted text
  original_sha256 TEXT,             -- intake digest for exact-duplicate detection only
  original_size INTEGER,
  original_filename TEXT,
  original_mime TEXT,
  readable_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (readable_state IN ('pending', 'readable', 'readable_with_warnings', 'stored_needs_conversion', 'failed')),
  converter TEXT,                   -- 'local_utf8', 'workers_ai_markdown', 'owner_markdown', ...
  converter_version TEXT,           -- options, warnings and omissions: source/<revision>/conversion.json
  readable_key TEXT,                -- source/<revision>/text.md
  readable_size INTEGER,
  warning_summary TEXT,             -- one owner-readable line; NULL when clean
  anchor_fidelity TEXT NOT NULL DEFAULT 'unavailable'
    CHECK (anchor_fidelity IN ('verified', 'observed', 'mixed', 'unavailable')),
  index_state TEXT NOT NULL DEFAULT 'none'
    CHECK (index_state IN ('none', 'queued', 'indexing', 'ready', 'partial', 'failed', 'removed')),
  card_key TEXT,                    -- source/<revision>/card/<card-id>.json
  card_state TEXT NOT NULL DEFAULT 'none' CHECK (card_state IN ('none', 'ready', 'stale', 'failed')),
  deleted_at INTEGER,               -- tombstone: identity and coordinates stay for history
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (source_id, revision_no)
);
CREATE INDEX source_revision_original_sha ON source_revision(original_sha256);

CREATE TABLE project_source (
  project_id TEXT NOT NULL REFERENCES project(id),
  source_id TEXT NOT NULL REFERENCES source(id),
  retrieval_enabled INTEGER NOT NULL DEFAULT 1,  -- 0 = excluded from new retrieval in this project
  note TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, source_id)
);
CREATE INDEX project_source_by_source ON project_source(source_id);

-- Disposable AI Search projection. One item normally maps to one native chunk.
CREATE TABLE search_item (
  instance TEXT NOT NULL,
  item_key TEXT NOT NULL,
  source_revision_id TEXT REFERENCES source_revision(id),
  page_revision_id TEXT REFERENCES page_revision(id),
  record_kind TEXT NOT NULL CHECK (record_kind IN ('source_block', 'source_card', 'page_block')),
  block_id TEXT NOT NULL,
  start_byte INTEGER NOT NULL,      -- UTF-8 range in text.md / body.md
  end_byte INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'published', 'failed', 'deleting', 'deleted')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (instance, item_key),
  CHECK ((source_revision_id IS NULL) <> (page_revision_id IS NULL)),
  CHECK (end_byte > start_byte)
);
CREATE INDEX search_item_by_source ON search_item(source_revision_id);
CREATE INDEX search_item_by_page ON search_item(page_revision_id);

-- Knowledge pages (notes, digests, reports, Wiki, Corpus Map, Audit) ---------

CREATE TABLE page (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  kind TEXT NOT NULL CHECK (kind IN ('note', 'digest', 'report', 'wiki', 'map', 'audit')),
  title TEXT NOT NULL,
  slug TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived', 'deleted')),
  retrieval_enabled INTEGER NOT NULL DEFAULT 1,
  head_revision_id TEXT REFERENCES page_revision(id),  -- accepted head; NULL until first publish
  draft_key TEXT,                   -- R2 key of the current server draft
  draft_version INTEGER NOT NULL DEFAULT 0,
  freshness TEXT NOT NULL DEFAULT 'current' CHECK (freshness IN ('current', 'stale', 'scope_changed')),
  summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, slug)
);
CREATE INDEX page_by_project ON page(project_id, kind, updated_at DESC);

CREATE TABLE page_revision (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES page(id),
  revision_no INTEGER NOT NULL,
  base_revision_id TEXT REFERENCES page_revision(id),  -- edit lineage, not a freshness dependency
  status TEXT NOT NULL CHECK (status IN ('accepted', 'proposed', 'rejected')),
  body_key TEXT NOT NULL,           -- page/<revision>/body.md (plain UTF-8 Markdown)
  body_size INTEGER NOT NULL,
  data_key TEXT,                    -- page/<revision>/data.json (resolved citations, Map/Audit data)
  default_freshness TEXT NOT NULL DEFAULT 'follow_current' CHECK (default_freshness IN ('follow_current', 'snapshot')),
  origin TEXT NOT NULL CHECK (origin IN ('owner', 'agent', 'chat_answer', 'job', 'import')),
  actor TEXT NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  mutation_id TEXT NOT NULL UNIQUE, -- stable operation ID: exact retry returns this row
  created_at INTEGER NOT NULL,
  UNIQUE (page_id, revision_no)
);
CREATE INDEX page_revision_proposed ON page_revision(page_id) WHERE status = 'proposed';

CREATE TABLE page_input (
  page_revision_id TEXT NOT NULL REFERENCES page_revision(id),
  source_revision_id TEXT REFERENCES source_revision(id),
  input_page_revision_id TEXT REFERENCES page_revision(id),
  mode TEXT NOT NULL CHECK (mode IN ('follow_current', 'snapshot')),
  inherited INTEGER NOT NULL DEFAULT 0,  -- carried from a reused page's recorded provenance
  CHECK ((source_revision_id IS NULL) <> (input_page_revision_id IS NULL))
);
CREATE UNIQUE INDEX page_input_unique ON page_input(page_revision_id, coalesce(source_revision_id, input_page_revision_id));
CREATE INDEX page_input_by_source ON page_input(source_revision_id);
CREATE INDEX page_input_by_page ON page_input(input_page_revision_id);

-- Chat ----------------------------------------------------------------------

CREATE TABLE chat (
  id TEXT PRIMARY KEY,              -- also the AIChatAgent Durable Object name
  project_id TEXT NOT NULL REFERENCES project(id),  -- immutable destination
  title TEXT NOT NULL DEFAULT '',
  archived_at INTEGER,
  snapshot_key TEXT,                -- latest verified portable snapshot in R2
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX chat_by_project ON chat(project_id, updated_at DESC);

-- One row per accepted submission, written before it waits or dispatches. It holds the pinned settings,
-- the single-continuation flag and the counters that recovery and limits read. Messages stay in the DO.
CREATE TABLE chat_turn (
  chat_id TEXT NOT NULL REFERENCES chat(id),
  turn_id TEXT NOT NULL,            -- stable client request ID
  actor TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('ask', 'tools')),
  scope_mode TEXT NOT NULL CHECK (scope_mode IN ('project_default', 'explicit', 'empty')),
  model_profile_id TEXT NOT NULL REFERENCES model_profile(id),
  profile_version INTEGER NOT NULL,
  observed_model TEXT,              -- provider/model that actually answered
  state TEXT NOT NULL DEFAULT 'admitted'
    CHECK (state IN ('admitted', 'streaming', 'completed', 'partial', 'interrupted', 'cancelled', 'failed')),
  continuation_used INTEGER NOT NULL DEFAULT 0,
  model_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  PRIMARY KEY (chat_id, turn_id)
);

CREATE TABLE chat_input (
  chat_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  source_revision_id TEXT REFERENCES source_revision(id),
  page_revision_id TEXT REFERENCES page_revision(id),
  FOREIGN KEY (chat_id, turn_id) REFERENCES chat_turn(chat_id, turn_id),
  CHECK ((source_revision_id IS NULL) <> (page_revision_id IS NULL))
);
CREATE UNIQUE INDEX chat_input_unique ON chat_input(chat_id, turn_id, coalesce(source_revision_id, page_revision_id));
CREATE INDEX chat_input_by_source ON chat_input(source_revision_id);
CREATE INDEX chat_input_by_page ON chat_input(page_revision_id);

-- Durable jobs (every Workflow instance) --------------------------------------

CREATE TABLE job (
  id TEXT PRIMARY KEY,              -- also the Workflow instance ID, chosen before create()
  project_id TEXT REFERENCES project(id),  -- NULL only for Library-wide cleanup/export
  kind TEXT NOT NULL CHECK (kind IN (
    'ingest', 'distill_source', 'compare', 'deep_research', 'revise_section',
    'refresh_wiki', 'refresh_map', 'run_audit', 'cleanup', 'export')),
  profile TEXT CHECK (profile IN ('fact_check', 'hypothesis_review', 'project_vs_literature')),
  actor TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE, -- exact retry returns this job
  input_digest TEXT NOT NULL,       -- same operation_id with a different input conflicts
  input_key TEXT NOT NULL,          -- job/<id>/input.json, immutable
  model_profile_id TEXT REFERENCES model_profile(id),
  workflow_name TEXT NOT NULL,
  workflow_version INTEGER NOT NULL, -- step contract of the deployed Workflow code
  workflow_created_at INTEGER,      -- bound from WorkflowEvent on first entry
  state TEXT NOT NULL DEFAULT 'start_pending' CHECK (state IN (
    'start_pending', 'start_failed', 'running', 'waiting', 'completed', 'partial', 'cancelled', 'failed', 'unknown')),
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  progress_label TEXT,
  limit_calls INTEGER,
  limit_tokens INTEGER,
  limit_seconds INTEGER,
  used_calls INTEGER NOT NULL DEFAULT 0,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  result_page_revision_id TEXT REFERENCES page_revision(id),
  result_key TEXT,                  -- R2 key for non-page results (export archive, audit data)
  stop_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  CHECK (profile IS NULL OR kind = 'deep_research')
);
CREATE INDEX job_by_project ON job(project_id, created_at DESC);
CREATE INDEX job_active ON job(state) WHERE state IN ('start_pending', 'running', 'waiting', 'unknown');

CREATE TABLE job_input (
  job_id TEXT NOT NULL REFERENCES job(id),
  source_revision_id TEXT REFERENCES source_revision(id),
  page_revision_id TEXT REFERENCES page_revision(id),
  admitted_at INTEGER NOT NULL,     -- captured web evidence is appended before use
  CHECK ((source_revision_id IS NULL) <> (page_revision_id IS NULL))
);
CREATE UNIQUE INDEX job_input_unique ON job_input(job_id, coalesce(source_revision_id, page_revision_id));
CREATE INDEX job_input_by_source ON job_input(source_revision_id);
CREATE INDEX job_input_by_page ON job_input(page_revision_id);

-- Record of every mutating outgoing tool call, written before callTool. Not a billing ledger:
-- it exists so an interrupted call is shown as 'unknown' instead of being retried blindly.
CREATE TABLE tool_effect (
  id TEXT PRIMARY KEY,              -- stable Eliot effect key, never the provider toolCallId
  connection_id TEXT NOT NULL REFERENCES mcp_connection(id),
  tool_name TEXT NOT NULL,
  chat_id TEXT,
  turn_id TEXT,
  job_id TEXT REFERENCES job(id),
  actor TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('intent', 'done', 'failed', 'rejected', 'unknown')),
  result_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (chat_id, turn_id) REFERENCES chat_turn(chat_id, turn_id),
  CHECK ((chat_id IS NULL) <> (job_id IS NULL))
);
CREATE INDEX tool_effect_open ON tool_effect(state) WHERE state IN ('intent', 'unknown');

-- Connected agents and tasks ---------------------------------------------------

CREATE TABLE agent (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,               -- display only; never used for authentication
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('service_token', 'managed_oauth', 'owner_delegated')),
  identity_subject TEXT NOT NULL,   -- verified Access client ID or subject
  enabled INTEGER NOT NULL DEFAULT 1,
  can_use_tools INTEGER NOT NULL DEFAULT 0,
  can_manage_library INTEGER NOT NULL DEFAULT 0,
  can_delete_library INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (identity_kind, identity_subject)
);

CREATE TABLE agent_project (
  agent_id TEXT NOT NULL REFERENCES agent(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  access TEXT NOT NULL CHECK (access IN ('read', 'contribute')),
  can_work_tasks INTEGER NOT NULL DEFAULT 1,
  can_run_paid_jobs INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  PRIMARY KEY (agent_id, project_id)
);

CREATE TABLE task (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  offered_to_agent_id TEXT REFERENCES agent(id),  -- NULL = open task any permitted agent may claim
  scope_mode TEXT NOT NULL CHECK (scope_mode IN ('pinned', 'current_at_claim')),
  claimant_agent_id TEXT REFERENCES agent(id),
  claim_seq INTEGER NOT NULL DEFAULT 0,  -- every claim/reclaim increments; results must match it
  state TEXT NOT NULL CHECK (state IN ('open', 'claimed', 'completed', 'declined', 'cancelled', 'expired')),
  result_page_revision_id TEXT REFERENCES page_revision(id),
  waiting_job_id TEXT REFERENCES job(id),
  wake_pending INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX task_by_project ON task(project_id, state);

-- Requested logical scope, before exact revisions are frozen.
CREATE TABLE task_scope (
  task_id TEXT NOT NULL REFERENCES task(id),
  source_id TEXT REFERENCES source(id),
  page_id TEXT REFERENCES page(id),
  CHECK ((source_id IS NULL) <> (page_id IS NULL))
);
CREATE UNIQUE INDEX task_scope_unique ON task_scope(task_id, coalesce(source_id, page_id));

-- Exact revisions frozen at creation ('pinned') or at first successful claim ('current_at_claim').
CREATE TABLE task_input (
  task_id TEXT NOT NULL REFERENCES task(id),
  source_revision_id TEXT REFERENCES source_revision(id),
  page_revision_id TEXT REFERENCES page_revision(id),
  CHECK ((source_revision_id IS NULL) <> (page_revision_id IS NULL))
);
CREATE UNIQUE INDEX task_input_unique ON task_input(task_id, coalesce(source_revision_id, page_revision_id));
CREATE INDEX task_input_by_source ON task_input(source_revision_id);

-- Activity -----------------------------------------------------------------------

-- Successful attributed mutations only; short safe text, never source content or secrets.
CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  project_id TEXT REFERENCES project(id),
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL,
  operation_id TEXT,
  detail TEXT
);
CREATE INDEX activity_by_project ON activity(project_id, at DESC);
