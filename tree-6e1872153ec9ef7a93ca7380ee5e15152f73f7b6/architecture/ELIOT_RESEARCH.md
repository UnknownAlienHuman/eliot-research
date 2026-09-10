---
title: "Eliot Research Cloud — standalone research-grade system on Cloudflare"
short_name: "ERC"
version: "29.1"
date: 2026-08-28
status: "standalone normative and implementation-ready contract; live deployment not completed"
authority: "normative for the Eliot Research repository; external client architectures are optional compatibility profiles, not runtime dependencies"
product_role: "external research federation: acquisition, evidence library, retrieval, controlled investigations, Wiki, and publication"
eliot_compatibility_baseline:
  date: 2026-08-28
  architecture_sha256: "c6932eaf26935e752eefb4de591afc91ea1a7180be5a8ff0005554b8029bac1a"
  implementation_sha256: "7805bf238fe91819aba50d7e13aa86a8b977561195dbb98aa979f986e2fab063"
  role: "optional external research-federation provider; never the internal Researcher plane"
platform: "Cloudflare Workers Paid + managed services; the OpenAI-built Google Drive app is the selected Day-0 ChatGPT exchange transport, subject to exact account/action/write-readback qualification; heavy preprocessing is supplied by qualified external providers"
cloudflare_platform_facts_checked: 2026-08-28
chatgpt_google_drive_docs_checked: 2026-08-28
account_specific_drive_observation: "historical 2026-08-27 session observation; not reusable conformance"
original_donor_sha256: "406080157b5dec8a3194e0adfa0c34b39c3e4296e829f96727563fc5415ce4cb"
aligned_english_donor_sha256: "96cdbb52f71c2dc4eb231d327f5b8c1586514e28249e90e4bc6c25904e83d346"
supersedes:
  - "ELIOT_RESEARCH_CLOUDFLARE.md v24.1, blob da1eb64a03c73f0bd631a959a5113ab3be00c5c6"
  - "all previous Eliot Research Cloudflare profiles v13–v29"
  - "separate Cloudflare architecture audits, deltas, resource maps, and bridge registries"
implementation_status: "ready for Slice 0 implementation; live Cloudflare and Google Drive write/readback remain mandatory gates"
revision_29:
  - "made ERC a standalone external product rather than the ELIOT Researcher plane or module"
  - "isolated ELIOT integration behind one optional generated-schema adapter with no ELIOT runtime dependency"
  - "added one authoritative mutable source owner per namespace and an explicit source-owner cutover"
  - "expanded ObjectResidencyKey to scope, access, confidentiality, encryption-key, retention, erasure, and content-digest domains"
  - "prohibited cross-domain co-residency, ciphertext/key reuse, and implicit unsaved-buffer persistence"
  - "aligned Evidence Grade, inquiry protocol, confirmatory/exploratory lanes, evidence freeze, claim audit, research debt, and honest closure"
  - "made normalized-bundle imports preserve origin owner, source view, exact revision, residency, and disclosure lineage"
  - "replaced legacy internal-module dependencies with generic provider/client boundaries and optional compatibility profiles"
revision_29_1:
  - "made the eliotr.normalized.v1 ownership-cutover mode and receipt identical to the Search export contract"
  - "assigned owner-cutover, complete-residency, unsaved-content, normalized-bundle, and federation mappings to explicit implementation slices and tests"
  - "separated official platform facts from historical account observations and rechecked Cloudflare/OpenAI documentation on 2026-08-28"
  - "removed unsupported or over-precise model facts and corrected current reranker pricing"
  - "made Evidence Grade lowering an explicit supersession and kept required rigor separate from observed execution/status axes"
  - "typed untrusted acquisition candidates and unsupported precision so prose cannot create sources or exactness"
  - "separated federation transport completion from the exact nine-value research completion disposition"
  - "made source-owner generation an explicit wire-stable token with fence/incarnation/cutover invalidation semantics"
  - "defined exact source.owner-cutover.v1 receipt semantics with bilateral authorization and revision-set/view bindings"
  - "completed the reference firewall with tool/verifier allowlists, stale entries, expansion routes, and a manifest digest/fence"
  - "made claim audit verify references, values, specifications, method/artifact alignment, and source-versus-excerpt sufficiency separately"
  - "required explicit EvidenceFreeze reopen/revision before post-freeze material can affect synthesis"
  - "bound CoverageReceipt to the frozen denominator and made complete/sampled/unknown coverage explicit"
---

# Eliot Research Cloud

> **In one sentence:** Eliot Research Cloud is a governed cloud evidence library, Corpus Lens, Research Wiki, and controlled investigation system with model choice, exact citations, and stable interfaces for humans, agents, and optional external clients.

---

# 0. Final decision

## ERC24-DEC-001 — what is being built

Eliot Research Cloud, hereafter **ERC**, has four user-facing surfaces:

```text
LIBRARY
  sources, originals, versions, web snapshots, exports, repositories

LENS
  exact + lexical + semantic retrieval, structure, SourceCards, ProjectAtlas

WIKI
  versioned Research Wiki with evidence, hypotheses, and limitations

RESEARCH
  governed investigations, comparisons, fact-checking, audits, deep-research execution products, and reports
```

The system must serve three fundamentally different products:

```text
ORIENTATION
  understand what the corpus contains, how it connects, and where to read next

PRECISION
  retrieve an exact passage, number, table, row, page, event, or code handle

MATERIALIZATION
  build a study, audit, Wiki, or report of any practical size
```

One top-k RAG pass, one summary, or one long prompt cannot satisfy all three.

## ERC29-DEC-002 — ERC is an external research system, not a client Memory OS or Researcher plane

**Legacy disposition:** `ERC24-DEC-002` is superseded. Its durable intent—ERC is not a second client Memory OS—is retained; its identification of ERC with an internal `Researcher` module is rejected.

ERC owns its own product state:

```text
ERC
  acquires, snapshots, parses, indexes, retrieves, investigates, and publishes research artifacts;
  owns the mutable source identity/revision lineage for namespaces admitted directly into ERC;
  returns evidence bundles, coverage, typed dispositions, and synthesis candidates.

Consuming client
  owns task purpose, interpretation, canonical admission, policy, and completion;
  may import or reject ERC output under its own authority.
```

ERC owns:

- its source namespaces and source revisions;
- normalized documents and retrieval projections;
- Corpus Lens, Investigation, hypotheses, evidence ledgers, and research debts;
- Research Wiki, artifacts, reports, jobs, receipts, and purge state.

ERC does not own:

- a client system's task graph, memory, policy, canonical knowledge, or finish authority;
- authority to promote synthesis into a client's truth or procedures;
- mutable source history for a namespace owned by another provider unless an explicit owner cutover completes.

Every intellectual result crosses a client boundary as:

```text
evidence_bundle
or
synthesis_candidate
or
typed_gap_or_disposition
```

For the optional ELIOT compatibility profile, ELIOT's internal `Researcher` plane decides ELIOT-side inquiry protocol and whether returned material is admissible to ELIOT; ERC independently governs its own ingestion, source qualification, disclosure, and execution. ERC remains only the external research-federation provider. ERC never becomes that plane, never shares ELIOT's canonical database or authority lineage, and never initiates ELIOT writes.

## ERC24-DEC-003 — use Cloudflare where it already outperforms a custom stack

Cloudflare provides commodity infrastructure:

```text
Workers runtime
Static Assets / PWA
Access
D1
R2
Queues
Durable Objects
Workflows
AI Search
Workers AI embeddings and reranking
toMarkdown
Browser Rendering
AI Gateway BYOK
Dynamic Routes
Spend Limits
OAuth/MCP transport primitives
```

Custom code is limited to capabilities Cloudflare does not provide as a managed product:

```text
source identity and revisions
EvidenceHandle
project and scope algebra
qualification and readiness
exact/high-recall guarantees
Corpus Lens semantics
Investigation and InquiryProtocolProfile
hypothesis/evidence/counterevidence model
controlled distillation
CoverageReceipt
Research Wiki contract
Artifact Compiler
typed federation API
client/provider disclosure
Budget Governor policy
small semantic API
```

We do not build our own:

```text
vector database
embedding runtime
BM25 engine
reranker service
crawler platform
workflow server
OAuth server from scratch
generic agent framework
```

## ERC24-DEC-004 — final topology

```text
                                  CLIENTS
 ┌──────────────┬───────────────────┬──────────────────┬──────────────────┐
 │ Human PWA    │ API clients       │ Trusted agents   │ ChatGPT Web      │
 │ owner/full   │ typed federation  │ private MCP      │ Google Drive app │
 └──────┬───────┴─────────┬─────────┴────────┬─────────┴────────┬─────────┘
        │                 │                  │                  │
        │                 │                  │       exact fixed Sheet URL/ID
        │                 │                  │                  ▼
        │                 │                  │       Google Drive Exchange
        │                 │                  │       requests/results/catalog
        │                 │                  │                  │
        ▼                 ▼                  ▼                  ▼
 ┌───────────────────────────────────────────────────────────────────────┐
 │                            ELIOTR CORE                                │
 │ PWA · semantic API · MCP · federation · policy · Drive adapter       │
 └──────────────────────────────┬────────────────────────────────────────┘
                                │
      ┌──────────────┬──────────┼──────────┬────────────┬───────────────┐
      ▼              ▼          ▼          ▼            ▼               ▼
   D1 Core       D1 Search   R2 Evidence  R2 Work   AI Search      Workflows/DO
   authority      FTS5       immutable    staging    managed        research
   scopes/jobs    exact      originals    wiki       retrieval      runtime
   research       safety     normalized   reports
      │              │          │          │            │
      └──────────────┴──────────┴──────────┴────────────┘
                                │
                   ┌────────────┴─────────────┐
                   ▼                          ▼
          AI Gateway retrieval       AI Gateway reasoning
          no cache/rate limit        BYOK/routes/budgets/DLP
                                                │
                              Workers AI · Vertex/Gemini · other providers

 EXTERNAL LOCAL PREPROCESSING — NOT ERC RUNTIME
 qualified external preprocessing
   Xberg · OCR · Docling · code analyzers · heavy ETL
                 │
                 └── Normalized Bundle / repository snapshot → ERC ingest API
```

Humans work in the dedicated PWA. Trusted agents and optional client adapters use the direct semantic API. The Day-0 ChatGPT path selects the OpenAI-built **Google Drive app** and one pre-created Exchange Spreadsheet. This path is admitted only after the exact connected account exposes the required actions and passes disposable append/readback/reconnect tests; it receives no D1/R2 credentials and does not depend on review of a custom ERC app.

Google Cloud does not become a second backend. It provides only:

```text
Drive / Docs / Sheets API authorization
optional Vertex model provider
optional billing/evaluation experiments
```

Cloudflare continues to own runtime, storage, retrieval, workflows, Wiki, and Research state.

---

# 1. Deployable resources and trust boundaries

## 1.1. One active Worker application

Day 0 contains one Cloudflare Worker deployment:

### `eliotr-core`

It contains:

```text
PWA / owner API
typed federation API
private agent MCP
DriveExchangeAdapter
Queue consumer
ResearchSession Durable Object class
ResearchWorkflow class
```

This is one deployable application, not a cloud port of any client operating or memory system. Xberg, OCR, code analyzers, local search, and subscription CLI agents do not run inside the Worker.

## 1.2. ChatGPT Web qualifies the Google Drive app as the Day-0 transport

ChatGPT connects the OpenAI-built app:

```text
Google Drive
```

The product documentation establishes availability of unified Drive/Docs/Sheets/Slides actions and optional sync. It does not prove that the required actions are enabled for this exact plan, workspace, Google account, OAuth grant, or session; ERC proves those conditions through the live gates below.

and accesses only pre-created ERC exchange assets:

```text
one dedicated exchange Google account
one fixed spreadsheet
optional generated result documents
one exact folder ID
```

The normal path contains no:

```text
custom ChatGPT MCP
public-plugin review dependency
Supabase / Airtable / Notion / Gmail mailbox
Drive semantic search dependency
second mutable inbox
```

Historical account observation, 2026-08-27: one ChatGPT session exposed file/folder creation, Docs/Sheets batch updates, direct range reads, raw-file update, metadata reads, exports, and revision list/fetch operations. This observation is non-normative, account- and session-specific, and cannot be reused as repository conformance. The exact production account still requires a disposable live write/readback/reconnect test before launch.

## 1.3. Required resource profile

```text
1 active Worker
  eliotr-core

2 D1 databases
  eliotr-core
  eliotr-search

2 R2 buckets
  eliotr-evidence
  eliotr-work

1 AI Search namespace
  4–6 instances

1 Queue + DLQ
1 ResearchSession Durable Object class
1 ResearchWorkflow class
2 AI Gateways
1 Access application family
1 Analytics Engine binding
1 scheduled Steward/Drive-cursor trigger

Google:
  1 production project for Drive OAuth/API + optional Vertex
  1 dedicated exchange Google account
  1 ERC-created Exchange Spreadsheet
  1 optional temporary promo-test project
```

No Cloud Run service, Firestore database, Pub/Sub topic, Cloud Storage bucket or Vertex Search datastore is required by ERC production.

## 1.4. Cloudflare runtime envelope — the OS does not move to the cloud

Workers execute only bounded orchestration:

```text
authorize and validate
resolve scope
read/write compact D1 metadata
stream bytes to/from R2
call AI Search
call AI Gateway
start/resume Workflow
append/read Google Exchange records
return handles and receipts
```

Workers do not execute:

```text
native executable or dynamic library
child process / shell / Git process
local filesystem authority
PDF/OCR/layout engine
embedded vector or search database
model weights or tokenizer runtime
repository clone
whole corpus in memory
whole report in memory
unbounded graph traversal
long synchronous CPU loop
global mutable request state
```

### Internal release budgets

| Surface | Internal gate |
|---|---:|
| `eliotr-core` compressed Worker | ≤ 4 MiB |
| Worker startup | ≤ 400 ms |
| first-party peak heap target | ≤ 32 MiB |
| buffered R2 object | ≤ 8 MiB |
| ordinary JSON/MCP payload | ≤ 256 KiB |
| Workflow step result | ≤ 64 KiB, handles only |
| DO persisted live state | ≤ 256 KiB |
| PWA initial JS | ≤ 600 KiB gzip |

These are stricter than platform ceilings. `wrangler deploy --dry-run --minify` and generated binding types are release evidence.

## 1.5. Google Drive is transport, not authority

| State | Authority |
|---|---|
| ChatGPT request row | external contribution candidate |
| Drive result document | human-readable delivery copy |
| Drive editor revision | transport observation |
| Frozen request/result bytes | R2 |
| Request/job/receipt state | D1 |
| Wiki/artifact head | D1 + immutable R2 revision |
| Retrieval projection | D1 Search / AI Search |

Drive can be disconnected without losing admitted sources, investigations, Wiki or artifacts.

## 1.6. D1 concurrency model for swarm

D1 remains read-heavy with short append/CAS writes:

```text
many indexed reads
short job/receipt appends
expected-revision heads
no model call inside transaction
no agent SQL access
```

Rules:

1. Ingestion and projection mutations enter through Queue/outbox consumers.
2. Investigation branches append events and update one expected-revision head only at checkpoints.
3. Search text remains isolated in `eliotr-search`.
4. Hot metrics go to Analytics Engine, not one contended row.
5. `overloaded`, conflict and retry outcomes are visible metrics.
6. Drive imports enter through one idempotent adapter/consumer.

Initial T6 profile:

```text
20 concurrent read agents
5 interactive Research sessions
10 queued ingestion/projection jobs
2 concurrent long Research Workflows
```

## 1.7. Cloudflare product-use matrix

| Product | ERC use | Decision |
|---|---|---|
| Workers + Static Assets | API, PWA, routing, adapters | required |
| D1 | canonical compact metadata and FTS safety projection | required |
| R2 | evidence, normalized artifacts, Wiki, reports | required |
| AI Search | managed hybrid/literal retrieval | required |
| Workers AI | embeddings, rerank, conversion, economy transforms | required |
| AI Gateway | BYOK, model routes, budgets, fallbacks | required |
| Workflows | DEEP/AUDIT/REPORT/reindex/exhaustive | required |
| Durable Objects / Agents SDK | live session coordination only | required |
| Queues | ingestion/projection/outbox delivery | required |
| Access | owner/service authentication | required |
| Analytics Engine | compact application metrics | required |
| Browser Rendering | dynamic web capture fallback | optional |
| R2 Data Catalog / SQL | large tabular corpora | optional |
| Vectorize | duplicates AI Search vector plane | not used |
| Containers | heavy parsing stays local | not used |
| Hyperdrive/PostgreSQL | D1 sufficient for measured workload | not used initially |
| Agent Memory | ERC is not Memory OS | not used |

“Use Cloudflare fully” means using appropriate managed primitives, not enabling every product without a need.

# 2. Data ownership

## ERC24-INV-OWN-001 — one owner per state family

| State | Authority | Rebuildable |
|---|---|---:|
| ERC-retained original/imported bytes | R2 Evidence within one complete residency domain | no, except governed erasure |
| Source identity and revisions for ERC-owned namespaces | D1 Core | no |
| Normalized artifact | R2 Evidence + D1 manifest | revisionally; erasable through closure |
| Projects and memberships | D1 Core | no |
| EvidenceHandle mapping | D1 Core + R2 manifest | no; terminal tombstone remains after erasure |
| Investigation | D1 Core + R2 checkpoints | no |
| Wiki and artifacts | R2 Work + D1 heads | no; dependent blocks may be redacted/revalidated |
| Jobs, attempts, outbox, receipts | D1 Core | no |
| ErasureCase and PurgeLedgerEntry | D1 Core | no |
| D1 FTS | D1 Search | yes |
| AI Search | managed projection | yes |
| Queue messages | Queue | yes |
| Live WebSocket/session state | Durable Object | yes |
| Google OAuth refresh token | encrypted D1 record + Cloudflare-held KEK | reauthorization |
| Drive change cursor/generation | D1 Core | replay/rotation |
| Drive Exchange rows | external transport copy | imported/frozen into R2+D1 |
| OAuth grants | OAuth storage | by reconnecting |
| Application metrics | Analytics Engine + bounded D1 health snapshots | aggregatable |
| Local analyzer cache | qualified external preprocessing | yes; outside ERC |

State required to reconstruct evidence, Wiki, Investigation, erasure history, or artifacts cannot exist only in AI Search, Queue, a Durable Object, plugin snapshot, telemetry, or local cache.

## ERC29-INV-OWN-002 — one authoritative mutable source owner per namespace

```yaml
SourceNamespaceOwnership:
  source_namespace_id:
  owner_system_id:
  owner_incarnation_ref:
  ownership_record_revision:
  source_owner_generation:
  source_admission_policy_revision:
  status: ACTIVE | CUTOVER_PREPARED | FENCED | RETIRED
  cutover_receipt_ref: optional
```

`source_owner_generation` is an opaque canonical token bound to namespace, owner system, owner incarnation, ownership-record revision, and status. It changes on fence, activation, retirement, incarnation replacement, or cutover; source-admission policy revision remains a separate axis. Federated providers supply their own opaque generation under the same change semantics.

ERC is the sole mutable owner of identity and revision history for namespaces it admits directly. A local Search provider, repository host, or another federation may remain the owner of its namespace while ERC stores immutable federated references. An immutable import creates a separate ERC-owned import namespace linked to the exact origin owner/revision; it does not mutate or replace the origin namespace. An ownership transfer requires identity mapping, source/view fencing, compatibility verification, old-owner fencing, new-owner activation, and a receipt. Two systems may not mutate one source lineage concurrently.

The cross-provider cutover receipt has one exact wire shape:

```yaml
protocol: source.owner-cutover.v1

cutover:
  cutover_id:
  source_namespace_id:
  identity_mapping_digest:
  prepared_at:
  effective_at:

old_owner:
  owner_system_id:
  source_owner_generation_before_fence:
  fence_revision:
  final_source_view_ref:
  final_revision_set_digest:
  terminal_status: FENCED | RETIRED

new_owner:
  owner_system_id:
  source_owner_generation_after_activation:
  activation_revision:
  admitted_revision_set_digest:
  status: ACTIVE

validation:
  compatibility_receipt_refs: []
  integrity_receipt_refs: []
  unresolved_sources_and_reasons: []

authorization:
  old_owner_authorization_ref:
  new_owner_authorization_ref:
  issued_at:
```

Canonical `source.owner-cutover.v1` body SHA-256: `b659806e37a4bc60ea67b4416e35212f559213bbadb28618b7edcee686b9277e`. The digest is computed over the UTF-8 body inside the fence, excluding fence lines and the final line feed. ERC accepts a receipt only when both owners authorize the same namespace and identity mapping, the old generation is already fenced, the new ERC generation is active, final/admitted revision-set digests match, and every unresolved source is explicit. Failure before activation creates no second active owner; abort or resume requires a new state-machine receipt. Unknown load-bearing fields or a mismatched generation, view, owner, or revision-set digest fail closed.

An ERC-local `EvidenceHandle` is a provider handle, not a client's canonical evidence object. A consuming client imports it under its own governance and may retain only the exact admitted revision/excerpt and lineage.

## ERC24-INV-OWN-002 — AI Search is not the evidence authority

```text
AI Search hit
  locator candidate

D1 FTS hit
  locator candidate

EvidenceHandle resolved against pinned R2 revision
  evidence
```

Deleting AI Search entirely does not destroy a source, Wiki, or report.

## ERC25-INV-OWN-003 — immutable does not mean legally undeletable

Normal mutation does not rewrite or delete a canonical object. The sole exception is the standalone `erc.privacy.erasure.v1` process. The optional ELIOT adapter maps this contract losslessly to the ELIOT erasure profile; ERC core does not import ELIOT security crates.

```text
ordinary mutation
  immutable + new revision

privacy erasure
  exact-fence governed purge
  + non-revealing PurgeLedgerEntry
  + terminal EvidenceHandle state
```

Steward, ResearchAgent, Wiki publisher, and the ordinary owner API receive no hard-delete capability. Only `ErasureCoordinator`, operating through the local `ErasureBackend` port and exact `PurgeLocation` closure, owns it.

## ERC29-INV-OWN-004 — content-addressing is scoped by complete residency identity

**Legacy disposition:** `ERC25-INV-OWN-004` is expanded, not discarded. Erasure and retention remain load-bearing; scope, access, confidentiality, and encryption-key domains are added to prevent unsafe co-residency.

A global `sha256/<digest>` key is unsafe. Identical bytes may belong to different scopes, principals, confidentiality classes, encryption-key lineages, retention rules, or erasure closures.

Canonical durable object identity is:

```text
ObjectResidencyKey =
  scope_domain_id +
  access_domain_id +
  confidentiality_domain_id +
  encryption_key_domain_id +
  retention_domain_id +
  erasure_domain_id +
  versioned_content_digest
```

In v29 the versioned content digest is SHA-256 and its algorithm identifier is part of the key serialization. Equal bytes may deduplicate only when **every** domain above is equivalent. Byte equality never permits cross-domain physical co-residency, ciphertext reuse, encryption-key reuse, or coupled retention/erasure. Moving content between domains is an explicit copy or re-encryption transition with a receipt and a disposition for the old copy; metadata relabeling is insufficient.

# 3. Global sources, projects, and scopes

## ERC24-DEC-005 — Source is global

Wrong:

```text
source belongs to exactly one project
src/<project>/<source>/<revision>
```

Correct (logical schema sketch, not executable migration SQL):

```text
source(
  source_id PRIMARY KEY,
  source_namespace_id,
  source_owner_system_id,
  source_owner_generation,
  ownership_mode,
  kind,
  origin_uri,
  title,
  default_storage_policy,
  default_residency_profile_id,
  source_class,
  license_policy,
  default_retention_policy_id,
  head_rev,  -- mutable only for ERC-owned lineage; imported/federated refs are immutable
  created_at
);

source_revision(
  rev_id PRIMARY KEY,
  source_id,
  source_owner_generation,
  content_sha256,
  object_residency_key,
  original_r2_key,  -- optional for federated reference
  normalized_artifact_id,
  captured_at,
  parser_profile,
  quality_state,
  purge_state
);

project(
  project_id PRIMARY KEY,
  title,
  default_disclosure,
  retention_policy,
  created_at
);

project_source_membership(
  project_id,
  source_id,
  role,
  valid_from,
  valid_to,
  PRIMARY KEY(project_id, source_id, valid_from)
);
```

One immutable source may participate simultaneously in:

```text
project("agent-platform")
project("research-methods")
GLOBAL_LIBRARY
temporary investigation
comparison workspace
```

without copying original bytes when the complete residency identity is equivalent. Otherwise ERC creates a separately governed copy or retains only a federated reference.

## ERC24-DEC-006 — Project is an analytical overlay

A Project contains:

```text
source memberships
project-local source roles
instructions for research
default source policy
default model/depth profile
Wiki branches
Atlas revisions
Investigations
artifacts
retention and disclosure overrides
```

A Project is not:

```text
a separate R2 corpus
a separate D1 database
a mandatory AI Search instance
a physical originals folder
```

## Scope algebra

```text
project("agent-platform")

project("agent-platform") UNION project("research-methods")

project("agent-platform")
  INTERSECT source_class("paper")

GLOBAL_LIBRARY
  EXCEPT project("archive")

selected_sources(...)
  UNION tag("retrieval")
```

Before retrieval or research, the expression resolves into an immutable:

```yaml
ScopeSnapshot:
  snapshot_id_and_revision:
  resolved_scope_expression:
  participant_scope_and_project_generations:
  member_source_revision_refs:
  source_owner_generations:
  policy_authority_and_disclosure_closure:
  purge_ledger_revision:
  client_fence_ref: optional
  digest_created_at_and_expiry:
```

All model calls, artifacts, and citations bind to the snapshot digest. A purge or newly applicable deny invalidates the dependent snapshot immediately. A purged member revision is excluded on refresh and cannot re-enter through an older index, cache, summary, or imported bundle. The snapshot records an existing policy/source closure; it does not mint source admissibility or client authority.

## R2 canonical layout

### `eliotr-evidence`

```text
objects/<residency-key-digest>/<prefix>/<content-digest>

manifests/source/<source_namespace_id>/<source_id>/<revision_id>.json
normalized/<residency-key-digest>/<artifact_id>/<revision_id>/full.md
normalized/<residency-key-digest>/<artifact_id>/<revision_id>/structure.json
normalized/<residency-key-digest>/<artifact_id>/<revision_id>/mappings.json
normalized/<residency-key-digest>/<artifact_id>/<revision_id>/tables/
normalized/<residency-key-digest>/<artifact_id>/<revision_id>/pages/
captures/web/<residency-key-digest>/<source_id>/<revision_id>/
captures/repository/<residency-key-digest>/<source_id>/<revision_id>/
exports/conversation/<residency-key-digest>/<source_id>/<revision_id>/
tombstones/<purge_id>.json
```

Rules:

```text
residency key with erasable policy
  application-immutable, no incompatible Bucket Lock;
  dedicated ErasureCoordinator may physically delete.

residency key with bounded-retention policy
  Bucket Lock only when the declared lawful/business minimum retention
  explicitly permits that exact lock interval.

residency key under legal hold
  locked until a separately governed hold release.
```

Bucket Lock is never enabled broadly over the whole Evidence bucket. A source with `legal_delete_required=true` cannot be admitted into a prefix whose active lock may outlive the deletion deadline. A retention conflict produces `PURGE_BLOCKED`, not a false completion receipt.

### `eliotr-work`

```text
staging/<operation_id>/<attempt_id>/
projection/<generation>/<instance>/<project>/<item>.md
investigation/<id>/<revision>/
artifact/<id>/<revision>/sections/
artifact/<id>/<revision>/manifest.json
wiki/<page_id>/<revision>.md
wiki/<page_id>/<revision>.json
draft/<project>/<draft_id>/<revision>.md
backup/<backup_epoch>/
quarantine/
purge-work/<purge_id>/
```

Work objects inherit storage, client-disclosure, inference-disclosure, retention and erasure closure from all source dependencies. A public/exportable derivative is not declassified merely because it is a summary.

# 4. Source admission and normalization

## ERC24-DEC-007 — every ingress path passes through staging

Staging applies to all paths:

```text
PWA upload
remote URL import
typed client export
ChatGPT Scribe draft
web capture
Workflow-generated report
manual high-fidelity bundle
qualified local analyzer output
repository snapshot
```

Common protocol:

```text
resolve scope/access/confidentiality/encryption-key/retention/erasure domains
→ stage
→ hash
→ readback
→ media/schema/quality validation
→ D1 revision transaction
→ conditional promotion
→ outbox
→ projection updates
```

A staging object is not evidence.

## 4.1. Fast cloud path — Day 0

```text
source upload
→ SHA-256
→ immutable original in the selected R2 Evidence domain
→ Workers AI toMarkdown
→ qualification
→ deterministic StructuralProjector
→ normalized artifact revision
→ D1 exact/FTS projection
→ AI Search Items uploadAndPoll
→ readiness receipt
```

`toMarkdown` is used for supported PDF, Office, HTML/XML, CSV, ODF, Numbers, and image inputs. A successful parser call does not imply a high-quality result.

## 4.2. Qualification gate

Validate:

```text
extraction coverage
empty or truncated pages
reading order
heading continuity
tables and cell mapping
OCR confidence
replacement or corrupt characters
duplicate pages
soft-404/WAF/login stubs
identity/title/authors
source mapping completeness
parser warnings
```

Readiness is not reducible to one `READY` state.

```text
captured
normalized
structure_qualified
exact_ready
lexical_ready
semantic_ready
sourcecard_ready
atlas_included
distillates_ready
wiki_published
```

Each channel has:

```text
not_requested
queued
running
ready
degraded
failed
stale
redacted
```

## 4.2.1. Source admission decision

A locator or identifier proposed by a model, user, connector, or client first becomes an ERC-local no-effect candidate, not a source:

```yaml
SourceAcquisitionCandidate:
  candidate_id_and_revision:
  observed_locator_identifier_or_upload_ref:
  proposer_principal_and_run_ref:
  allowed_reference_manifest_ref: optional
  proposed_source_class_purpose_and_scope:
  untrusted_title_metadata_and_claims:
  staging_object_and_policy_refs: optional
  state: OBSERVED | RESOLVING | CAPTURED | REJECTED | EXPIRED
  effect_ceiling: NO_EFFECT
  created_at_and_expiry:
  capture_or_rejection_receipt_ref: optional
```

Only a captured candidate that passes the ordinary staging, integrity, policy, residency, qualification, and admission path may produce an admitted `SourceRevision`. A candidate cannot enter retrieval, model context, Wiki, publication, or federation output.

```yaml
SourceAdmissionDecision:
  source_namespace_id:
  owner_system_id:
  source_owner_generation:
  source_revision_ref:
  origin_authentication_receipt_ref:
  source_class_and_assurance_ceiling:
  instruction_taint_and_allowed_effects:
  complete_object_residency_key_digest:
  allowed_use_disclosure_license_and_expiry:
  decision: ADMITTED | QUARANTINED | REJECTED
  reason_codes: []
  decision_receipt_ref:
```

A parser, model, connector, or provider name never grants assurance. Admission validates origin, integrity, source class, executable/instruction risk, residency, disclosure, license, and intended use. Unknown load-bearing fields fail closed. Quarantined material may be inspected through a bounded no-effect path but cannot enter retrieval, model context, Wiki, publication, or federation output.

## 4.2.2. Currentness and upstream source views

```yaml
SourceCurrentness:
  source_revision_ref:
  owner_system_id:
  source_owner_generation:
  source_view_ref:
  workspace_view_revision_ref: optional
  observation_freshness: current_confirmed | observed_with_age | gap_detected | unknown
  observed_at_expiry_and_gap_refs:
```

A web capture or imported snapshot is exact historical evidence, not automatically current. A current-state, completeness, or absence claim requires `current_confirmed` for every load-bearing source class. For a federated reference, ERC verifies the upstream owner generation and exact revision/view before citation; a stale generation, observation gap, unavailable owner, or failed digest check yields `STALE_SOURCE_OR_INDEX`, `SOURCE_UNAVAILABLE`, or narrower coverage. ERC never substitutes convenient current bytes for the admitted revision.

## 4.3. High-fidelity preprocessing is an external provider boundary

ERC does not run Xberg, Docling, native OCR/layout engines, repository analyzers, or heavy tabular transformation inside Workers.

```text
QUALIFIED EXTERNAL PREPROCESSOR
  ELIOT Search export adapter, OCR/layout pipeline, repository analyzer,
  document converter, or owner-operated ETL
        │
        ▼
  versioned NormalizedBundle
        │ authenticated HTTPS / multipart upload
        ▼
ERC
  validate → snapshot → index → investigate → publish
```

Cloudflare still handles formats for which its managed path is sufficiently good:

```text
source accepted by Cloudflare
→ R2 staging
→ managed conversion
→ qualification
→ normalized artifact revision
```

Both paths converge on one contract. ERC does not infer analyzer assurance from a product name; every bundle states its exact producer generation, capabilities, coordinate maps, loss map, and limitations.

An unsaved editor buffer is never an implicit ERC source. It may enter ERC only through an explicit immutable snapshot export with authenticated origin, source-view revision, disclosure/retention/erasure policy, and admission receipt. ERC does not maintain a hidden provider cache or background stream of unsaved bytes.

## 4.4. `NormalizedBundle` contract

Minimum upload:

```text
<bundle>/
  content.md
  manifest.json
  hashes.sha256
```

Extended upload:

```text
<bundle>/
  content.md
  manifest.json
  structure.json
  mappings.json
  tables.json
  assets/
  hashes.sha256
```

Manifest:

```yaml
protocol: eliotr.normalized.v1

origin:
  owner_system_id:
  source_namespace_id:
  source_owner_generation:
  source_revision_ref:
  source_view_ref: exact_upstream_view_descriptor
  workspace_view_revision_ref: optional
  ownership_mode: federated_reference | immutable_import | ownership_cutover
  ownership_cutover_receipt_ref: required_for_ownership_cutover | absent_otherwise

source:
  logical_id:
  original_name:
  original_sha256:
  origin_location_class: local_only | cloud | external
  mime_type:

residency_and_disclosure:
  scope_domain_id:
  access_domain_id:
  confidentiality_domain_id:
  encryption_key_domain_id:
  retention_domain_id:
  erasure_domain_id:
  disclosure_ceiling:
  allowed_use:
  expiry:

normalization:
  analyzer:
  analyzer_version:
  profile:
  config_hash:
  created_at:

content:
  markdown: content.md
  markdown_sha256:
  structure: optional
  mappings: optional
  tables: optional
  coordinate_map_digest: optional
  loss_map_digest: optional

capabilities:
  text_ranges: boolean
  pages: boolean
  bounding_boxes: boolean
  tables: boolean
  figures: boolean

quality:
  state: high_fidelity | standard | degraded
  assurance_ceiling:
  warnings: []

export:
  purpose:
  receipt_ref:
```

Canonical `eliotr.normalized.v1` manifest-body SHA-256 (UTF-8; code fences and the final line feed excluded): `3a5f9fd2b254eebe574b2c4a28f9804df0da9df359e59ceee125fa7da90fef22`.

If mappings are absent, ERC can cite line/character/byte ranges in normalized Markdown but must not invent PDF pages, bounding boxes, or table-cell provenance. `ownership_cutover` is accepted only after the separate fenced owner-transfer protocol has completed. The exact receipt MUST bind the old owner generation and source/view fence, the identity mapping, and the new ERC owner generation and activation; the manifest field records that transition but cannot authorize or perform it. The receipt field MUST be absent in every other ownership mode.

## 4.5. Upload bridge is deliberately small

A qualified preprocessor, ELIOT Search export adapter, agent, or owner may call:

```text
POST /api/v1/ingest/bundles/prepare
→ dedup result + upload session

multipart upload directly to R2 staging

POST /api/v1/ingest/bundles/commit
→ BundleAdmissionReceipt
```

Optional helper:

```text
eliotr-sync.exe push <bundle>
```

The helper performs only:

```text
manifest validation
hashing
server residency-aware dedup probe
multipart upload/resume
commit receipt readback
status
```

It does not:

```text
run Xberg
spawn agents
open an inbound port
maintain a local database
poll Cloudflare continuously
own a job scheduler
```

No Tunnel, WSS lease protocol or Windows service is a baseline ERC requirement. If a future local subsystem wants cloud-issued work, that transport belongs to the external client/provider infrastructure and remains outside ERC's cloud runtime.

Local-state invariant:

> No canonical ERC state may exist only on the local disk. Local originals and analyzer outputs may remain local when policy requires it; the admitted normalized revision and its capabilities/limitations are explicit in ERC.

## 4.6. Web acquisition

The AI Search website crawler is used only for domains onboarded into the same Cloudflare account: our site, our documentation, and controlled domains.

Arbitrary web research:

```text
provider-native web search
→ CandidateSource
→ authority/dedup screening
→ static HTTP capture
→ Browser Rendering only when rendering required
→ immutable R2 snapshot
→ SourceRevision
→ parse and qualification
→ AI Search Items
```

A search result or model citation without a captured snapshot is not evidence.

## 4.7. Code profile

Code truth:

```text
Git repository + commit SHA
```

Initial cloud profile:

```text
repository manifest
commit-pinned file snapshots
exact path/file search
README/ADR/docs
code EvidenceHandles
```

Optional specialist bridge:

```text
Sourcegraph
or
Zoekt + SCIP / LSP
```

Generic document embeddings do not replace definitions/references.

## 4.8. Conversation and agent-trace profile

Chat is normalized as events, not as one Markdown file:

```text
conversation
→ thread/reply graph
→ message revisions
→ tool calls/results
→ attachments
→ episode
```

Episode:

```text
problem
→ hypothesis
→ attempt
→ result/failure
→ diagnosis
→ correction
→ decision
→ later regression
```

Raw events remain exactly searchable. EpisodeCard is the compact derived unit.

## 4.9. Structured data profile

CSV/JSONL/Parquet/SQL exports are not sent wholesale to a model.

Optional path:

```text
local schema/profile/Parquet conversion
→ R2
→ R2 Data Catalog / R2 SQL when needed
→ aggregates, selected rows and exact handles
→ model
```

This profile is enabled after real tabular corpora appear.

## 4.10. Bounded data movement and memory contract

No endpoint turns R2 into an in-memory file server.

```text
ordinary JSON request body              ≤ 256 KiB
Drive contribution target               ≤ 64 KiB
Drive contribution hard limit           ≤ 128 KiB
MCP/semantic API response                ≤ 512 KiB
DO callable/WebSocket message            ≤ 64 KiB
persisted DO live state                  ≤ 256 KiB
Workflow step return                     ≤ 64 KiB, handles only
D1 ordinary text/JSON column             ≤ 64 KiB
AI Search projection item target         16–64 KiB
AI Search application hard item max      256 KiB
ArtifactSection target                   ≤ 1 MiB
buffered R2 data in Worker               ≤ 8 MiB
```

Anything larger is represented by an R2 handle, range/cursor, manifest and hash.

### Upload

```text
ordinary file
→ streamed request body
→ R2 binding put(stream)

large file
→ multipart session
→ bounded parts
→ final manifest/readback
```

Base64 file upload in JSON is prohibited.

### Exhaustive scans

`ExactScanPlan` partitions a frozen scope:

```yaml
ExactScanShard:
  source_revision_ids: []
  section_object_refs: []
  target_uncompressed_bytes: <= 2 MiB
  hard_uncompressed_bytes: <= 8 MiB only after T6 proof
  max_sections: 128
```

Each step materializes partial matches to R2; the final step merges compact manifests. No Worker loads the corpus.

# 5. Document Intelligence

## ERC24-DEC-008 — seven representation levels

```text
D0 EVIDENCE
   immutable original bytes and capture receipt

D1 NORMALIZED
   full readable text/Markdown, pages, tables and mappings

D2 STRUCTURE / ANCHORS
   hierarchy, IDs, dates, versions, symbols, figures, citations

D3 RETRIEVAL
   exact, FTS/BM25, semantic hybrid, literal/trigram

D4 NAVIGATION
   SourceCard, DocumentMap, ArgumentMap, ProjectAtlas

D5 EVIDENCE ATOMS
   typed source-local propositions with exact spans

D6 INVESTIGATION VIEWS
   hypotheses, comparisons, chronology, conflicts, gaps

D7 PUBLICATIONS
   ResearchArtifacts, reports and Wiki pages
```

D4–D7 are derived. They do not replace D0–D2.

## 5.1. SourceCard

One inexpensive structured pass per source revision:

```yaml
SourceCard:
  source_revision_id:
  title:
  authors: []
  date:
  language:
  source_kind:
  document_role:
  authority_hint:
  abstract:
  main_topics: []
  controlled_vocabulary: []
  outline: []
  important_sections: []
  likely_uses: []
  quality_status:
  generator_generation:
```

SourceCard is navigation, not evidence.

## 5.2. DocumentMap

```yaml
DocumentMapRevision:
  document_revision_id:
  section_hierarchy:
  page_ranges:
  figures:
  tables:
  named_entities:
  dates_and_versions:
  external_citations:
  key_terms:
  high_information_sections:
  unresolved_structure:
  mappings_to_original:
  generator_generation:
```

An agent reads DocumentMap before opening dozens of sections.

## 5.3. ProjectAtlas

ProjectAtlas answers:

```text
which sources exist
which topics and subsystems are represented
which versions and periods are covered
which sources are central
which source families are independent
where parsing is degraded
where contradictions exist
which areas are barely researched
which reading routes are recommended
```

Construction:

```text
SourceCards
→ deterministic grouping
→ bounded model classification
→ hierarchical merge
→ AtlasRevision
```

An Atlas node expands into:

```text
Atlas node
→ SourceCard
→ DocumentMap
→ section
→ EvidenceHandle
→ immutable SourceRevision
```

### 5.3.1. ERC EvidenceHandle

```yaml
EvidenceHandle:
  handle_id_and_revision:
  source_namespace_id_and_source_owner_generation:
  source_revision_ref:
  scope_snapshot_ref:
  native_or_normalized_anchor:
  excerpt_digest_and_byte_length:
  coordinate_map_and_loss_map_refs:
  object_residency_key_digest:
  source_and_materializer_assurance_ceiling:
  terminal_state_and_invalidation_ref:
  created_at_and_expiry:
```

The handle is an ERC provider handle, not a client's canonical evidence object and not an access token. Resolution rechecks current authorization, owner generation, purge state, exact revision digest, coordinate map, and excerpt digest. A locator or index hit becomes evidence only after this readback succeeds.

## 5.4. ArgumentMap

For research, architecture, policy, and project documents:

```text
problem/question
→ assumptions
→ premises
→ evidence
→ intermediate conclusions
→ final claims
→ limitations
→ objections
→ alternatives
```

Edges are derived and carry exact source spans.

## 5.5. EvidenceAtom

```yaml
EvidenceAtom:
  atom_id:
  source_revision_id:
  atom_type:
    finding | decision | requirement | constraint |
    hypothesis | failed_approach | correction |
    benchmark | procedure | definition |
    causal_link | open_question
  subject_hint:
  predicate:
  object_value:
  polarity:
  modality:
  conditions:
  population_or_scope:
  valid_time:
  asserted_time:
  authority_hint:
  verbatim:
  evidence_handle:
  extractor_generation:
  validation:
```

An atom is admitted only when:

```text
the verbatim text resolves exactly
the span hash matches
the number appears in the supporting text
a recommendation was not converted into a decision
a hypothesis was not converted into an observed fact
the source revision belongs to the frozen scope
```

EvidenceAtoms are created selectively:

```text
core source
active Investigation
repeated retrieval target
comparison/audit/report
suspected contradiction
accepted artifact dependency
explicit owner request
```

Full LLM compilation of every paragraph at ingest is prohibited.

## 5.6. Scientific paper profile

```yaml
PaperProfile:
  research_question:
  study_type:
  population_or_dataset:
  sample_size:
  intervention_or_method:
  comparators:
  measured_constructs:
  primary_outcomes:
  effect_sizes:
  uncertainty:
  limitations:
  funding_and_conflicts:
  replication_status:
  cited_prior_work:
```

Preserve the distinction between:

```text
what the authors observed
what the authors inferred
what the authors recommend
what a later review claims
```

## 5.7. Project-document profile

```text
Goals
Constraints
Requirements
Assumptions
ArchitectureClaims
Decisions
OpenQuestions
ImplementationStatements
RiskStatements
RejectedApproaches
TestClaims
ExternalDependencies
```

Until an Investigation begins, these objects remain source-local.

---

# 6. Retrieval plane

## ERC24-DEC-009 — AI Search is the primary relevance engine, not the only retrieval path

Cloudflare AI Search covers:

```text
managed storage/index
vector retrieval
BM25 keyword retrieval
hybrid RRF/max fusion
Porter or trigram tokenizer
metadata filters
path/folder filtering
query embeddings
reranking
cross-instance search
Items API
context expansion 0–3
```

Architecture-shaping limits:

```text
maximum 50 results per query
maximum 4 MB per item
5 custom metadata fields per instance
one keyword tokenizer per instance
embedding model fixed at instance creation
```

> AI Search finds relevant material. It does not prove completeness and is not an exact evidence store.

## 6.1. D1 Search — narrow safety projection

`eliotr-search` contains only rebuildable projections:

```text
section_fts
sourcecard_fts
wiki_fts
artifact_fts
episode_fts
projection_watermark
literal gram table when required
```

D1 Search is required for:

```text
exact phrase
lexical fallback
known-term search
candidate narrowing
complete-scope cursor
operation when AI Search is unavailable
```

If the deployed D1 build does not support the required FTS tokenizer, partial-literal n-grams are built in a normal StructuralProjector table; full regex runs over normalized artifacts in R2.

## 6.2. AI Search instances

### `eliotr-private-prose`

```text
vector            true
keyword           true
fusion            rrf
keyword tokenizer porter
embedding         @cf/qwen/qwen3-embedding-0.6b
query rewriting   off by default
reranking         per request
```

### `eliotr-private-literal`

```text
vector            false
keyword           true
keyword tokenizer trigram
query rewriting   off
reranking         off
```

### `eliotr-wiki-artifact`

Hybrid retrieval over:

```text
published Wiki
accepted ResearchArtifacts
Atlas and durable navigation views
```

Results are derived research, not external evidence.

### `eliotr-captured-web`

Indexes only captured SourceRevisions.

### `eliotr-exportable` — optional derived projection

Physically contains only:

```text
exportable_redacted
public
```

The Google Drive Exchange never queries AI Search directly on behalf of ChatGPT. ERC applies scope/disclosure policy first, then writes only bounded Catalog/Result material. This instance is introduced only if a separate physical export boundary produces measured value.

## 6.3. Custom metadata budget

Built-in `folder`, `filename` and timestamp are not duplicated.

Private prose example:

```text
disclosure
status
source_class
authority
lang
```

Project is encoded by folder/key and rechecked in D1. Revision is item key + D1 manifest. Different instances may use different five-field schemas.

## 6.4. Projection item

We do not write a semantic chunker. A small `StructuralProjector` creates stable section-level units:

```yaml
ProjectionItem:
  item_key:
  canonical_section_id:
  source_revision_id:
  project_membership:
  heading_path:
  document_context_header:
  section_text:
  normalized_offset_map:
  content_hash:
  instruction_taint:
  projection_generation:
```

AI Search performs internal chunking, embeddings, BM25, fusion and reranking within the controlled section.

Projection item is retained in R2 Work and uploaded through Items API for immediate indexing and complete rebuildability.

## 6.4.1. Capacity and folder-based project projection

```text
projection/<generation>/<instance>/<project>/<item>.md
```

Pre-retrieval folder filtering is useful, but Source in N projects creates N copies of each projection section.

```text
hybrid instance       500,000 items
vector-only instance  1,000,000 items

items = Σ(section revisions × indexed project memberships)
```

At 40 sections/revision and average membership 2:

```text
500,000 / (40 × 2) ≈ 6,250 revisions per hybrid instance
```

Therefore:

- capacity is planned in items, not documents;
- item count and growth are observed continuously;
- temporary research collections use ScopeExpression, not new memberships;
- sharding creates another same-profile instance in one namespace;
- ChatGPT-exportable duplication is accepted only for physical disclosure isolation.

## 6.4.2. Embedding generation migration

Embedding model cannot be changed on an existing AI Search instance. Any change is a full new generation and full reindex.

```yaml
EmbeddingGeneration:
  generation_id:
  model_id:
  dimensions:
  index_profile:
  structural_projector_generation:
  item_count:
  estimated_input_tokens:
  quoted_neurons:
  quoted_usd:
  estimated_duration_from_measured_throughput:
  instance_ids: []
  state: PLANNED | BUILDING | SHADOW | ACTIVE | ROLLBACK | RETIRED
  golden_set_result:
  created_at:
```

Protocol:

```text
count canonical projection items and tokens
→ reserve cost and capacity
→ create new AI Search instance(s)
→ upload complete new generation
→ keep current generation A serving all production queries
→ run index completeness/readback checks
→ replay retrieval Golden Corpus against B
→ optional bounded shadow traffic, rank-only comparison
→ D1 expected-head switch A → B
→ retain A for rollback window
→ retire only after rollback horizon
```

Rules:

```text
A and B vector scores are never mixed directly
partial B is never exposed as complete
migration may be cancelled without harming A
switch requires item-count, retrieval-quality, latency and cost receipts
```

For large corpora, migration quote is mandatory before creation. The system reports both nominal model cost and expected overage after the daily free neuron allowance.

## 6.5. Retrieval lanes

```text
IDENT       D1 direct ID/hash/DOI/path/version
EXACT       D1 candidates + exact R2 scan
LEX         D1 FTS5 and AI Search keyword
SEM         AI Search vector/hybrid
LITERAL     AI Search trigram + exact fallback
SOURCECARD  document routing
ATLAS       project orientation
ATOM        typed EvidenceAtoms
ARGUMENT    source argument structure
WIKI        reviewed Research Wiki
ARTIFACT    accepted ResearchArtifacts
STRUCTURE   neighbors/parent/page/table
CODE        optional commit/symbol bridge
WEB         captured web evidence
EXHAUSTIVE  complete-scope D1/R2 Workflow
VERIFY      exact EvidenceHandle resolution
```

## 6.6. Query products

```text
FAST SEARCH       direct/exact/lexical, no reasoning model
LOCATE            hybrid/literal/diversity/context expansion
ORIENT            Atlas + SourceCards + Wiki + coverage
RESEARCH          Investigation + branches + counter-search
EXHAUSTIVE JOB    all matches/high-recall/server aggregation
VERIFY EXACT      pinned source revision and exact region
MATERIALIZE       block-versioned durable output
```

## 6.7. Query pipeline

Before the first generation token:

```text
preserve raw query and literals
→ freeze ScopeSnapshot
→ classify product and required coverage
→ direct probes
→ exact/lexical candidates
→ semantic/literal lanes when useful
→ weighted rank fusion
→ deduplicate by canonical section
→ source-family diversity
→ D1 policy/scope/purge recheck
→ conditional rerank
→ context expansion / structural expansion
→ exact EvidenceHandle resolution
→ EvidencePack
→ model call
```

Before citation or support, ERC reopens the exact admitted `SourceRevision` under the frozen `ScopeSnapshot`, verifies content digest and byte length, resolves the native/normalized anchor through the recorded coordinate map, and verifies the selected excerpt digest. AI Search or D1 text is a locator/preview, never citation authority. Missing revision, mapping, owner generation, residency authorization, or digest yields a narrower result or typed gap; current convenient bytes are never substituted for an earlier revision.

### 6.7.1. AI Search `context_expansion`

Use the managed surrounding-chunk feature instead of always issuing another search/read request:

```text
IDENT / EXACT / LITERAL             0
FAST SEARCH                         0–1
LOCATE / ordinary ASK               1
COMPARE / causal / chronology       2
DEEP branch discovery               2
3                                   only with explicit EvidencePack budget
```

`context_expansion` is not evidence and not a replacement for DocumentMap parent expansion. Returned neighboring chunks still resolve through the canonical section and exact handles. It is disabled when expansion risks crossing a disclosure or source boundary.

## 6.8. Reranking

Enabled only for vague/noisy/cross-source/citation-pass queries. Disabled for direct handles, exact identifiers, exact quotes, known sources and exhaustive scans.

`@cf/baai/bge-reranker-base` accepts 512 tokens per query-context pair. A section is usually longer.

```text
rerank score = relevance signal for supplied window
rerank score ≠ coverage judgment
```

Input is `document_context_header` plus the most relevant bounded excerpt, not blindly only the first 512 tokens. The excerpt is selected deterministically from lexical/semantic matching spans. Rerank never removes a section from EXHAUSTIVE and cannot invalidate an already resolved EvidenceHandle.

## 6.9. Query rewriting

Off by default. QueryPlanner may create visible subqueries, but raw query, literals and negative conditions remain preserved and all decomposition appears in TRACE.

## 6.10. Exhaustive operations

AI Search top-k never proves absence.

```text
D1 candidate cursor
→ admissible R2 normalized manifest
→ batched exact scan
→ count/group/dedup
→ result artifact
→ coverage denominator
```

Only `NO_MATCH_IN_COMPLETE_SCOPE` permits a scoped absence claim.

## 6.11. Relation graph

No graph database in v1. D1 relation ledger stores deterministic and derived edges with precision class:

```text
source_native
deterministic
parser_derived
model_candidate
human_reviewed
```

EdgeQuake/GraphRAG is added only after measured gain on global/multi-hop questions.

## 6.12. Retrieval trace

```yaml
RetrievalTrace:
  raw_query:
  scope_snapshot:
  query_product:
  lanes_used:
  lanes_skipped:
  exact_probes:
  index_generations:
  embedding_generation:
  context_expansion:
  candidates_by_lane:
  fusion:
  rerank:
  expansions:
  represented_sources:
  omitted_sources:
  stale_or_degraded_channels:
  budget:
  evidence_pack_ref:
```

# 7. Controlled Research

## ERC29-DEC-010 — Investigation is the central durable unit

**Legacy disposition:** `ERC24-DEC-010` is retained and expanded with explicit revision, protocol, lane, coverage, freeze, audit, debt, and reopen contracts.

```yaml
Investigation:
  investigation_id_and_revision:
  goal_and_intended_decision_or_artifact:
  interpretations: []
  scope_snapshot_ref:
  inquiry_protocol_ref:
  evidence_grade:
  lane_registration_refs: []
  source_portfolio_ref:
  coverage_denominator_ref:
  obligations: []
  hypotheses: []
  branches: []
  evidence_ledger:
  counterevidence_ledger:
  contradictions: []
  unknowns: []
  research_debts: []
  evidence_freeze_ref:
  claim_audit_ref:
  artifacts: []
  model_profile:
  execution_product:
  budget_and_stop_rule:
  terminal_disposition:
  reopen_conditions: []
  parent_investigation:
```

Chat is an interface to an Investigation. The Investigation survives model changes, compaction, PWA restart, provider replacement, and handoff to another agent. It is ERC-local state; it does not become a client's task graph or canonical decision.

## 7.1. Evidence Grade

Evidence Grade states required rigor, not model size, product label, or observed success:

```text
E0 ORIENTING
  bounded answer or orientation; no coverage claim; unsuitable for a material decision;

E1 GROUNDED
  each material statement resolves to an exact ERC EvidenceHandle;
  observation, interpretation, and assumption are separated;

E2 CORROBORATED
  independent source families or observation routes;
  rivals/counterevidence represented; coverage denominator declared;

E3 SCIENCE GRADE
  E2 plus declared confirmatory/exploratory lane,
  frozen protocol/evaluator where confirmatory,
  evidence freeze before synthesis, claim-level audit, and explicit research debts.
```

Grade may be raised prospectively. Evidence already exposed retains its original grade and lane. Raising a claim to confirmatory E3 requires fresh held-out, independent, preregistered, replicated, formally proved, or otherwise sufficient evidence. Lowering the declared grade for an unchanged claim is a versioned supersession with an explicit reason, not a silent adjustment. A later reader cannot upgrade or downgrade a claim merely by quoting it. Evidence Grade records required rigor; observed execution status, fidelity, independence, attribution, and result quality remain separate axes and cannot be inferred from it.

## 7.2. InquiryProtocolProfile

```yaml
InquiryProtocolProfile:
  profile_id_and_revision:
  question_and_intended_decision_or_artifact:
  protocol:
    lookup | evidence_review | causal_diagnosis | formal_proof |
    program_synthesis | architecture_decision | algorithm_search |
    empirical_discovery | theory_development | decision_support
  evidence_grade: E0 | E1 | E2 | E3
  lane: confirmatory | exploratory | mixed_with_declared_split
  source_mode: corpus_only | corpus_plus_web | web_discovery
  truth_surfaces_and_admissible_provider_classes: []
  source_policy:
    primary_required:
    peer_reviewed_preferred:
    authority_classes: []
    excluded_classes: []
  coverage_goal: exploratory | representative | high_recall | exhaustive
  hypothesis_policy:
    alternatives_required:
    counter_search_required:
    falsification_required:
  independence_and_blinding_policy:
  chronology_policy:
  fidelity_ceiling:
  model_profile:
  budget_deadline_and_stop_rule:
  output_contract_and_reopen_conditions:
```

Protocol selection follows question structure, risk, truth surface, verifier strength, sequential dependencies, branch independence, and budget—not the label “deep research.” A protocol change is versioned; in a confirmatory lane, an unregistered change makes subsequent analysis exploratory until a new registration is frozen before new outcome exposure.

## 7.3. Confirmatory and exploratory lanes

```yaml
LaneRegistration:
  registration_id_and_revision:
  contract_protocol_hypothesis_and_evaluator_digests:
  primary_outcome_and_decision_rule:
  exclusions_and_quality_controls:
  blinded_fields:
  allowed_deviations:
  registered_before_outcome_exposure:
  registered_at_and_scope_snapshot_ref:
```

A confirmatory lane may not change its primary metric, exclusion rule, proposition, evaluator, or failure reporting after outcome exposure except through a declared deviation. Compliant negative results are valid. Exploratory evidence may generate or tune hypotheses but cannot confirm them on the same exposure. A mixed lane freezes an explicit partition; evidence may not silently cross into the confirmatory evaluator.

## 7.4. Inquiry obligations and acceptance certificates

```yaml
InquiryObligation:
  obligation_id_and_parent_question:
  goal_and_protocol_ref:
  dependencies_and_assumptions:
  acceptance_certificate_kind:
    exact_source_identity_and_passage | immutable_inputs_and_raw_measurements |
    protocol_compliance_qc_and_raw_data | reproducible_build_and_contract_tests |
    kernel_checked_proof | client_accepted_evidence_revision
  information_boundary:
  responsible_role_and_verifier:
  budget_and_stop_condition:
  status: STUB | READY | RUNNING | BLOCKED | SUBMITTED | ACCEPTED | REJECTED | WAIVED
```

A worker may submit evidence; only the named verifier may issue the certificate. A summary, score, model agreement, or completed Workflow step is not an acceptance certificate.

## 7.5. SourcePortfolio and coverage denominator

```yaml
SourcePortfolio:
  portfolio_id_and_revision:
  project_sources: []
  primary_research: []
  reviews_and_meta_analyses: []
  specifications_and_official_docs: []
  operational_evidence: []
  independent_implementations: []
  critical_or_negative_sources: []
  community_experience: []
  missing_source_classes: []
  independence_profile:

CoverageDenominator:
  denominator_id_and_revision:
  frozen_scope_snapshot_ref:
  eligible_source_revision_refs: []
  required_source_classes_and_question_branches: []
  acquisition_methods_and_provider_generations: []
  excluded_sources_and_reasons: []
  completeness_test_and_expiry:
```

Ten pages from one vendor do not count as ten independent sources. A coverage or absence claim requires a frozen, inspectable denominator; an exhausted top-k retrieval or stopped agent is not completeness.

## 7.6. HypothesisCard

```yaml
HypothesisCard:
  hypothesis_id_and_revision:
  statement:
  origin_and_lane:
  scope:
  predictions: []
  falsifiers: []
  supporting_evidence: []
  counterevidence: []
  alternatives: []
  discriminating_questions: []
  status: unexamined | plausible | supported | contested | falsified | inconclusive
  calibrated_support:
  last_evaluated_at:
```

## 7.7. Research Workflow and execution envelope

Recommended idempotent checkpoints:

```text
FREEZE_PROTOCOL_AND_SCOPE
ORIENT
INTERPRET
COMPILE_OBLIGATIONS
PLAN
RETRIEVE_BRANCHES
ACQUIRE_AND_CAPTURE
READ_AND_EXTRACT
ANALYZE_BRANCHES
COUNTER_SEARCH
RECONCILE
FREEZE_EVIDENCE
SYNTHESIZE
VERIFY
AUDIT_CLAIMS
RESOLVE_CITATIONS
CALCULATE_COVERAGE
MATERIALIZE
```

An implementation may merge adjacent inexpensive stages. Each expensive model call has a durable checkpoint. A Workflow returns handles, not long text; large sections and intermediates are written to R2 immediately.

### 7.7.1. ResearchSession Durable Object

Routing key:

```text
principal_id + investigation_or_chat_id
```

There is no global Research DO. It owns only connected clients, stream cursor, pending approval IDs, and compact presentation state. D1/R2 own transcript, Investigation, ledgers, model receipts, artifacts, and terminal disposition.

Rules:

```text
persist before notifying clients
hibernate WebSockets when idle
no full source text in DO state
no model output retained only in memory
no cross-project global coordinator
```

### 7.7.2. ResearchWorkflow

One Workflow instance owns one durable operation: research run, audit, report, exhaustive scan, reindex, or backup/restore verification. Each stage checks cancellation and budget, reads bounded handles, performs at most one expensive model call, writes large output immediately, and returns a compact idempotent receipt.

Default fan-out:

```text
independent branches  2
normal maximum        4
nested fan-out        0
```

## 7.8. Research branches

```text
SUPPORT
COUNTER
ALTERNATIVE
CHRONOLOGY
IMPLEMENTATION
LITERATURE
SOURCE_AUDIT
```

A branch receives a clean prompt and bounded EvidencePack, not the entire lead conversation. Branch count does not establish evidence independence; lineage, source family, capture path, evaluator, provider, harness, and conceptual frame remain visible.

## 7.9. Reference firewall, evidence freeze, and claim audit

Before a model/agent call, ERC compiles an `AllowedReferenceManifest` from the exact ScopeSnapshot, provider permissions, disclosure policy, and task purpose:

```yaml
AllowedReferenceManifest:
  manifest_id_and_revision:
  scope_snapshot_ref:
  allowed_source_revision_and_evidence_handle_refs: []
  allowed_tool_definition_and_verifier_refs: []
  permitted_anchor_and_precision_ceilings: []
  provider_and_policy_generations: []
  stale_or_revoked_entries: []
  permitted_acquisition_or_expansion_routes: []
  disclosure_allowed_use_and_expiry:
  manifest_digest_and_client_fence:
```

A model may quote, summarize, or select only listed entries. A newly mentioned URL or identifier is an untrusted `SourceAcquisitionCandidate` until captured, versioned, admitted, and added to a later manifest; model prose cannot mint a valid source, citation, line range, or support relation.

Unsupported precision is typed rather than left as an unstructured caveat:

```yaml
UnsupportedPrecisionItem:
  asserted_reference_or_coordinate:
  highest_supported_precision:
  source_and_coverage_basis:
  risk_of_false_precision:
  required_probe_or_narrower_wording:
```

Synthesis begins only after an `EvidenceFreeze` records:

```yaml
EvidenceFreeze:
  freeze_id_and_revision:
  client_fence_or_scope_snapshot_ref:
  coverage_denominator_ref:
  contract_protocol_and_lane_digests:
  included_evidence_handles_and_digests: []
  excluded_evidence_and_reasons: []
  unresolved_contradictions: []
  open_research_debt_refs: []
  provider_model_prompt_and_tool_generations:
  frozen_at:
```

New material discovered after the freeze cannot be inserted into the current synthesis silently. The Investigation records a reopen reason, creates a new freeze revision, reruns affected coverage/contradiction checks, and audits claims against that new revision.

Every material output then receives claim-level audit:

```yaml
ClaimAuditItem:
  claim_id_and_text_digest:
  claim_kind: observation | interpretation | assumption | recommendation
  exact_support_handles: []
  counterevidence_handles: []
  verification:
    reference_verification:
    value_or_measurement_verification:
    specification_compliance:
    method_artifact_alignment:
  support_sufficiency:
    source_satisfies_requirement:
    supplied_excerpt_supports_requirement:
  independence_and_fidelity:
  evidence_grade_and_lane:
  coverage_limitations:
  unsupported_precision: [UnsupportedPrecisionItem]
  disposition: SUPPORTED | PARTIALLY_SUPPORTED | UNSUPPORTED | CONTRADICTED | NOT_VERIFIABLE_IN_SCOPE
```

Retrieval quality and citation quality are separate. A source may genuinely contain the required evidence while the supplied excerpt is insufficient for a careful reader to verify the claim. Fabrication, meaning-shifting paraphrase, stitching across sections, cropping away a hedge or negation, presenting a search snippet as a source quote, or citing text absent from the admitted revision fails excerpt support even when retrieval found the right document.

A precise number, quotation, causal statement, absence claim, or universal statement cannot exceed the precision and coverage of its evidence. Unsupported precision is removed, narrowed, or marked unresolved—not repaired by fluent prose.

## 7.10. Research debts

```text
epistemic       load-bearing assumption unverified;
verification    candidate lacks a sufficient verifier;
replication     no independent failure domain;
coverage        material branch or source class unclosed;
contradiction   conflict unresolved and unscoped;
fidelity        evaluator poorly represents the target;
provenance      raw artifact or lineage missing;
authority       client decision/waiver not supplied.
```

```yaml
ResearchDebt:
  debt_id_and_revision:
  kind: epistemic | verification | replication | coverage | contradiction | fidelity | provenance | authority
  blocked_claim_artifact_or_obligation_refs: []
  basis_and_evidence_refs: []
  owner:
  blocking_effect:
  next_probe:
  review_condition:
  expiry:
  status: OPEN | RESOLVED | WAIVED | SUPERSEDED
  resolution_or_waiver_receipt_ref: optional
```

Each debt has an owner, blocking effect, next probe, review condition, and expiry. A report carrying open debts states them and cannot silently claim completeness or confirmation. Waiver changes release authority only; it does not convert missing evidence into support.

## 7.11. Terminal dispositions and reopen

`CompletionDisposition` is a closed wire enum with exactly these values:

```text
CompletionDisposition =
  ANSWERED_WITH_SUPPORTED_RESULT
  NO_MATCH_IN_COMPLETE_SCOPE
  NO_NEW_USEFUL_EVIDENCE
  SOURCE_UNAVAILABLE
  STALE_SOURCE_OR_INDEX
  POLICY_OR_DISCLOSURE_DENIED
  INCOMPLETE_COVERAGE
  INCONCLUSIVE
  CANCELLED
```

Only `ANSWERED_WITH_SUPPORTED_RESULT` and a properly scoped `NO_MATCH_IN_COMPLETE_SCOPE` close an inquiry. Every other disposition preserves a next probe, narrower claim, explicit unknown, or reopen condition. Internal states such as `BUDGET_EXHAUSTED_PARTIAL`, `FAILED`, and `PURGE_BLOCKED` map to the less assertive wire disposition; they never create a more confident tenth value.

## 7.12. Research products

### `ASK`

Grounded iterative answer with exact support, derived inferences, unresolved hypotheses, coverage, and next questions.

### `BRIEF`

Key findings and numbers with conditions, source positions, disagreements, limitations, unknowns, and exact evidence.

### `COMPARE`

Dimension-based comparison of documents, systems, methods, models, architectures, or versions.

### `HYPOTHESIS_REVIEW`

Hypothesis register, predictions, support, counterevidence, alternatives, discriminating checks, and scoped status.

### `FACT_CHECK`

Every claim is `supported`, `partially_supported`, `unsupported`, `contradicted`, or `not_verifiable_in_scope`.

### `PROJECT_VS_LITERATURE_AUDIT`

Project claims and assumptions are mapped to evidence, literature/standards/operational evidence, counter-search, gaps, alternatives, severity, and exact evidence.

### `DEEP_RESEARCH`

An E2/E3 Investigation with explicit protocol, branches, controlled acquisition, counter-search, evidence freeze, claim audit, research debts, and CoverageReceipt. “Deep” is an execution product, not an evidence grade by itself.

### `REPORT`

A block-versioned artifact created by Artifact Compiler.

# 8. Model plane

## ERC29-DEC-011 — model capability, execution product, and Evidence Grade are separate controls

**Legacy disposition:** `ERC24-DEC-011` is retained and expanded. Intelligence tier and research depth remain independent; Evidence Grade is added as a third orthogonal control.

### Intelligence

```text
ECONOMY
BALANCED
STRONG
FRONTIER
AUDIT
CUSTOM
```

### Execution product

```text
LOOKUP
ANSWER
ANALYZE
DEEP
AUDIT
REPORT
EXHAUSTIVE
```

Model capability and execution product are orthogonal to each other and to Evidence Grade. A frontier model does not create E2/E3 evidence; a DEEP or REPORT run may still close as incomplete or inconclusive.

## 8.1. Two AI Gateways

### `eliotr-retrieval`

Used only by AI Search internal model calls.

```text
cache OFF
rate limiting OFF
embedding-model substitution prohibited
analytics enabled
```

### `eliotr-reasoning`

Used by ResearchAgent and Workflows.

```text
BYOK keys
Dynamic Routes
Spend Limits
rate limits
provider/model fallback
DLP and guardrails
minimal logs
safe revision-keyed cache
```

The policies are incompatible and cannot share one gateway.

## 8.2. Model routes

Application code references only routes:

```text
dynamic/eliotr-economy
dynamic/eliotr-balanced
dynamic/eliotr-strong
dynamic/eliotr-frontier
dynamic/eliotr-audit-writer
dynamic/eliotr-audit-verifier
dynamic/eliotr-vision
dynamic/eliotr-extract
dynamic/eliotr-report-section
dynamic/eliotr-report-integrator
```

`RouteFingerprint` records provider, exact model ID, route version, prompt/schema generation, parameters and pricing snapshot.

## 8.3. Embedding and reranker baseline

```text
embedding
  @cf/qwen/qwen3-embedding-0.6b
  direct Workers AI model context: 8192 tokens
  current AI Search supported-input envelope: 4096 tokens
  effective input cap and output shape/dimensions recorded by the instance-generation capability fixture

rerank
  @cf/baai/bge-reranker-base
  top candidate subset only
  input/window limits recorded by the generation capability fixture
```

BGE-M3 remains a shadow candidate. No model is promoted from catalogue metadata alone: the exact AI Search compatibility, output shape, quality, latency, and cost are captured by the generation capability fixture. Model replacement follows §6.4.2 and always creates a new instance generation.

## 8.4. BYOK

Provider keys live in AI Gateway / Secrets Store.

```text
Worker receives gateway authorization only
browser receives no provider key
agent receives no provider key
D1/R2 contain no provider key
```

With two providers:

```text
synthesis    Provider A
verification Provider B
fallback     Workers AI
```

With one provider:

```text
synthesis    selected BYOK model
verification different model/prompt + deterministic checks
fallback     Workers AI
```

## 8.5. Generation change gate

Any change to:

```text
model
route
prompt
output schema
retrieval policy
parser profile
embedding generation
```

produces a new immutable generation and runs the relevant Golden Corpus suites from §19 before active promotion. Silent replacement is prohibited.

# 9. Artifact Compiler and Research Wiki

## 9.1. Artifact is not one model response

```yaml
ArtifactSpec:
  kind:
    research_report | technical_audit | literature_review |
    architecture_report | hypothesis_dossier |
    comparison_report | wiki_generation
  title:
  scope_snapshot:
  research_protocol:
  audience:
  language:
  section_contracts:
  citation_policy:
  verification_policy:
  include_counterevidence:
  include_methodology:
  length_policy:
  export_formats:
  budget:
```

Workflow:

```text
freeze dependencies
→ outline
→ section contracts
→ EvidencePack per section
→ independent drafts
→ difficult-section escalation
→ terminology/source reconciliation
→ cross-section consistency
→ citation resolution
→ verification
→ coverage
→ deterministic assembly
→ ArtifactRevision
```

## 9.2. Copy-on-write section tree

```text
ArtifactRevision N
  Section A reused
  Section B replaced
  Section C reused
  Section D added
```

Internal state:

```text
Artifact
ArtifactRevision
ArtifactSection
ArtifactDependencyManifest
SectionEvidenceLedger
SectionVerificationReceipt
```

`report.md` is an export, not the only canonical representation.

## 9.3. Evidence labels

Every material statement is classified:

```text
SOURCE_SUPPORTED
DERIVED_INFERENCE
HYPOTHESIS
CONTESTED
UNRESOLVED
EDITORIAL_RECOMMENDATION
REDACTED_DEPENDENCY
```

A model cannot mint citation IDs. Every citation resolves through EvidenceLedger.

## 9.4. Research Wiki

Page types:

```text
Project
Topic
Source
Method
Hypothesis
Comparison
Audit
Contradiction
Timeline
Report
FailedPath
OpenQuestion
Glossary
```

Each revision includes scope, statement labels, evidence map, counterpositions, coverage, limitations, dependencies, generator generation, reviewer, status and supersedes.

## 9.5. Proposal and publication

```text
research.wiki.propose
→ draft revision
→ deterministic checks
→ optional verifier
→ policy/owner commit
→ publish
```

Publication:

```text
PUT immutable R2 revision
→ readback/hash verification
→ D1 expected-head CAS + outbox
→ projection update
→ optional derived _head.json export
```

D1 head is authority. There is no cross-service D1↔R2 transaction.

## 9.6. Draft Inbox without owner bottleneck

Draft promotion is risk-tiered.

```text
D0 MECHANICAL
  formatting, exact metadata, citation repair, duplicate removal
  auto-promote after deterministic checks

D1 LOW-RISK ADDITIVE
  fully cited source summary, glossary/source page, no current-state override
  auto-promote only under explicit project policy
  + exact handles + no conflicts + cheap independent verifier

D2 ANALYTICAL
  new comparison, hypothesis, causal interpretation, audit finding
  verifier then owner/policy committer

D3 AUTHORITY-SENSITIVE
  policy, permissions, deletion, active decision, legal/medical/financial claim
  owner or designated authority only
```

```yaml
AutoPromotionPolicy:
  project_id:
  allowed_draft_classes: []
  required_statement_labels: [SOURCE_SUPPORTED]
  require_exact_handles: true
  forbid_conflict: true
  forbid_current_state_override: true
  verifier_route:
  max_risk_level: D1
  policy_revision:
```

ChatGPT Scribe and PWA imports use the same policy. Auto-promotion creates a normal receipt and can never bypass erasure, disclosure or expected-head checks.

# 10. Research Steward

## 10.1. Deterministic contour

```text
verify R2 hashes
retry failed conversions
check qualification
validate EvidenceHandles
compare D1/AI Search watermarks
find missing/duplicate projection items
mark stale Wiki/artifact sections
rebuild D1 Search/AI Search
check Queue/DLQ/outbox
verify BackupEpoch and PurgeLedger revision
track model-route health
track costs/quotas
emit SLO metrics
```

## 10.2. Semantic contour

Runs only on triggers:

```text
retrieval miss
owner feedback
source revision
accepted DEEP/REPORT
core source
suspected contradiction
stale Wiki page
```

May propose aliases, QueryHints, EvidenceAtoms, map/Atlas refreshes, conflict candidates, research gaps and section revalidation.

May not:

```text
write client canonical memory or knowledge
claim client task or completion authority
change permissions
hard-delete evidence
execute privacy erasure
run unbounded model loops
publish high-impact conclusions without policy
```

## 10.3. Erasure is not Steward maintenance

Only dedicated `ErasureCoordinator` may invoke `erc.privacy.erasure.v1`. Steward may detect an overdue erasure case or stale projection after purge, but it cannot decide or execute deletion.

## 10.4. Retrieval learning

```text
missed relevant source
→ RetrievalFeedback
→ inspect trace
→ QueryHint / metadata / router rule
→ replay Golden Corpus and affected queries
→ publish retrieval-policy generation
```

This improves information access, not global beliefs.

# 11. Federation API and optional ELIOT compatibility profile

## ERC29-DEC-012 — ERC owns a generic federation contract

**Legacy disposition:** `ERC24-DEC-012` is superseded. A fixed dependency on another repository's Rust DTOs is replaced by ERC-owned wire schemas; compatibility is provided by optional generated adapters.

ERC core exposes versioned HTTPS JSON over Cloudflare Access or another qualified service principal. It does not import a client repository, database driver, authority model, or internal DTO package.

```yaml
FederationRequest:
  exchange_id_protocol_bridge_and_idempotency:
  requester_principal_and_client_fence:
  question_scope_and_expected_decision_or_artifact:
  source_classes_and_coverage_goal:
  allowed_input_handles_and_export_manifest:
  privacy_disclosure_retention_license_and_residency:
  budget_deadline_stop_and_progress_contract:
  required_result_schema_citations_and_evidence_grade:

FederationEvidenceBundle:
  exchange_request_job_system_and_version:
  immutable_bundle_digest_and_origin_authentication:
  source_namespace_owner_generations:
  source_catalog_snapshots_and_exact_citations:
  claim_counterclaim_and_independence_matrix:
  bounded_excerpts_and_artifact_handles:
  coverage_unknowns_failed_acquisition_and_research_debts:
  completion_disposition_and_reopen_conditions:
  synthesis_candidate:
  disclosure_retention_expiry_and_invalidation:

FederationExportBundle:
  exchange_id_protocol_and_client_product_identity:
  artifact_or_source_handles_and_redactions:
  purpose_allowed_use_retention_and_return_channel:
  disclosure_decision_and_export_receipt:
```

Canonical transport properties:

```text
versioned HTTPS JSON
mutually authenticated service principal
idempotency key
client fence / ScopeSnapshot binding
cursor/range artifact reads
unknown load-bearing fields fail closed
large payloads returned by immutable handle, not one inline object
```

Authentication, endpoint reachability, or a successful login proves transport only. It proves neither source coverage, disclosure permission, provider capability, nor result quality. Each exchange binds the exact ERC deployment/bridge generation, principal, ScopeSnapshot/client fence, disclosure policy, residency/retention contract, and dynamic capability receipt.

```yaml
FederationJobStatus:
  exchange_id_and_idempotency_key:
  job_id_and_attempt:
  transport_state: ACCEPTED | RUNNING | PARTIAL | BLOCKED | CANCELLED | COMPLETED | FAILED
  completion_disposition: CompletionDisposition | null  # exact nine-value set in §7.11
  progress_cursor_and_completed_obligations:
  partial_bundle_refs: []
  coverage_and_open_research_debts:
  cancellation_and_terminal_receipt_ref:
```

Federation jobs are asynchronous, durable, cancellable, and replayed by idempotency identity. Transport state and research completion disposition are orthogonal: `COMPLETED` means the job produced its terminal receipt, not that the inquiry was answered. A timeout or disconnect does not prove failure and never authorizes duplicate work or a stronger completion disposition.

## 11.1. Execution choices

```text
research.pack
  ERC collects and audits evidence; the client performs its own synthesis.

research.run / audit / report
  ERC performs governed reasoning and returns an artifact candidate.
```

This prevents paying twice and lets the client choose where interpretation occurs.

## 11.2. No reverse authority channel

ERC:

```text
does not request client agents unless a separate client-owned job contract explicitly does so;
does not mutate client canonical state;
does not receive client task, admission, policy, or finish authority;
does not share a database, canonical credentials, or provider secrets;
does not initiate bidirectional replication.
```

## 11.3. Large payloads and changes

Large results use a manifest, stable artifact handle, section/range API, hashes, and cursor. `research.changes(after_cursor, allowed_scopes)` is replay-authoritative; WSS notification may accelerate delivery but cannot replace cursor replay.

## 11.4. Optional ELIOT compatibility profile

The optional adapter is generated from the local federation schema and maps losslessly to the current ELIOT external-research boundary:

```text
FederationRequest          ↔ ResearchQueryRequest
SourceAcquisitionCandidate ↔ ObservationCandidate
allowed input/export set   ↔ AllowedReferenceManifest / ResearchExportBundle
FederationEvidenceBundle   ↔ ResearchEvidenceBundle
completion_disposition     ↔ CompletionDisposition
UnsupportedPrecisionItem   ↔ UnsupportedPrecisionItem
client fence               ↔ StateFence
```

Required compatibility rules:

```text
exchange_id and fence match;
budget and deadline are positive and bounded;
references stay inside the allowed manifest;
anchors resolve exactly to admitted source revisions;
synthesis remains candidate-only;
completion disposition is honest and never more assertive than ERC state;
transport `COMPLETED` never implies `ANSWERED_WITH_SUPPORTED_RESULT`;
unknown security/scope/budget fields fail closed;
ELIOT stores governed imports, not ERC database credentials or mutable source history;
ERC never becomes ELIOT's internal Researcher plane.
```

The ELIOT-side composition root belongs to the ELIOT repository. ERC contains only a leaf adapter/schema package and imports no ELIOT D1/R2/Drive or canonical-storage types.

# 12. Human and agent interfaces

## 12.1. PWA

NotebookLM-like three-panel layout:

```text
┌──────────────┬────────────────────────────────┬──────────────────┐
│ PROJECTS     │ INVESTIGATION / CHAT / REPORT  │ EVIDENCE         │
│ sources      │ question graph                 │ exact page/range │
│ readiness    │ hypotheses                     │ figure/table     │
│ Wiki         │ answer / analysis              │ hash/provenance  │
│ models       │ coverage / unknowns            │ neighboring text │
└──────────────┴────────────────────────────────┴──────────────────┘
```

Screens:

```text
Projects
Sources
Corpus Lens
Research Chat
Investigations
Hypotheses
Compare
Audit
Research Wiki
Reports
Evidence Viewer
Jobs
Models and Budget
System Health
Draft Inbox
```

## 12.2. Private semantic API

Keep the normal agent surface small:

```text
research.catalog
research.orient
research.query
research.open
research.verify
research.run
research.artifact
research.wiki.propose
research.trace
research.changes
```

The agent never chooses D1, R2, AI Search, FTS or provider directly.

## 12.3. ChatGPT Web: Google Drive app as a qualified Day-0 transport

Day-0 selects the OpenAI-built Google Drive app rather than making a custom MCP a launch dependency. Selection is provisional until the exact account/action scopes and append/readback/reconnect path pass the live gate.

```text
ChatGPT Web
→ Google Drive app
→ dedicated exchange Google account
→ fixed ERC Exchange Spreadsheet
→ DriveExchangeAdapter in eliotr-core
→ D1/R2/Research Workflow
```

This satisfies the one-app rule:

```text
one app
one Google OAuth connection in ChatGPT
one fixed spreadsheet
one request protocol
one Draft Inbox
```

ChatGPT does not discover ERC through Drive search. The exact Sheet URL/ID is pinned in the user's ChatGPT Project instructions and shown in the ERC PWA. The app is explicitly selected/@mentioned in an interactive conversation when needed.

### Dedicated exchange Google account

Production connects ChatGPT to a separate free Google account used only for ERC exchange, for example:

```text
eliot.research.exchange@...
```

It contains no unrelated personal Drive corpus. When Google Drive sync is enabled, the connection can expose the connected Drive corpus to ChatGPT; even without treating sync as a correctness dependency, actions operate under the granted Google scopes. The dedicated account limits that exposure. ERC's own OAuth client still uses narrow `drive.file`.

Google Cloud billing/Vertex may remain under the main billing account; the exchange identity does not need to own billing.

## 12.4. Exchange assets

ERC provisions one folder and one native Sheet:

```text
Eliot Research Exchange/
├── ERC Exchange                Google Sheet
└── Results/                    generated delivery Docs
```

Tabs with stable numeric `sheetId` values:

```text
SYSTEM
  protocol, exact sheet IDs, connector health, limits

CATALOG
  project IDs, operations, models/depth, recent handles

REQUESTS
  raw append-only request rows

PAYLOAD_PARTS
  raw append-only body chunks

RECEIPTS
  append-only admission/execution/failure receipts

RESULTS
  append-only result/artifact references

DASHBOARD
  optional human-readable formulas/views; never authority
```

ChatGPT writes only `REQUESTS` and `PAYLOAD_PARTS`. ERC writes `SYSTEM`, `CATALOG`, `RECEIPTS`, `RESULTS`. Raw tabs are not sorted/edited for presentation.

D1 stores an `ExchangeGeneration`:

```yaml
exchange_generation_id:
spreadsheet_id:
folder_id:
system_sheet_id:
catalog_sheet_id:
requests_sheet_id:
payload_parts_sheet_id:
receipts_sheet_id:
results_sheet_id:
protocol_version:
status: active | draining | retired
created_at:
```

A shadow Sheet must pass append/import/readback fixtures before generation switch.

## 12.5. One ChatGPT write = one atomic Sheets batch

The connected Google Drive surface exposes raw Sheets batch updates. ChatGPT submits one `spreadsheets.batchUpdate` with `appendCells` for the request and all body parts.

```json
{
  "requests": [
    {
      "appendCells": {
        "sheetId": 1001,
        "rows": [
          {
            "values": [
              {"userEnteredValue": {"stringValue": "eliotr.drive.exchange.v1"}},
              {"userEnteredValue": {"stringValue": "req-20260827-001"}},
              {"userEnteredValue": {"stringValue": "req-20260827-001"}},
              {"userEnteredValue": {"stringValue": "chatgpt-web"}},
              {"userEnteredValue": {"stringValue": "eliot-research"}},
              {"userEnteredValue": {"stringValue": "audit"}},
              {"userEnteredValue": {"stringValue": "strong"}},
              {"userEnteredValue": {"stringValue": "project(\"eliot-research\")"}},
              {"userEnteredValue": {"stringValue": "chunked_utf8"}},
              {"userEnteredValue": {"stringValue": ""}},
              {"userEnteredValue": {"stringValue": "payload-20260827-001"}},
              {"userEnteredValue": {"numberValue": 1}},
              {"userEnteredValue": {"stringValue": "{\"max_usd\":0.25}"}},
              {"userEnteredValue": {"stringValue": ""}},
              {"userEnteredValue": {"stringValue": "[]"}},
              {"userEnteredValue": {"stringValue": "2026-08-27T12:00:00Z"}}
            ]
          }
        ],
        "fields": "userEnteredValue"
      }
    },
    {
      "appendCells": {
        "sheetId": 1002,
        "rows": [
          {
            "values": [
              {"userEnteredValue": {"stringValue": "payload-20260827-001"}},
              {"userEnteredValue": {"numberValue": 0}},
              {"userEnteredValue": {"numberValue": 1}},
              {"userEnteredValue": {"stringValue": "Audit the project against the selected research corpus."}},
              {"userEnteredValue": {"stringValue": "2026-08-27T12:00:00Z"}}
            ]
          }
        ],
        "fields": "userEnteredValue"
      }
    }
  ]
}
```

Sheets validates the complete batch before applying it. Either all request/payload rows append or none do.

### Request fields

```yaml
protocol: eliotr.drive.exchange.v1
request_id:
idempotency_key:
actor_claim: chatgpt-web
project_id:
operation:
  orient | locate | evidence_pack | answer |
  deep_research | audit | report |
  wiki_candidate | correction | source_candidate
intelligence:
  economy | balanced | strong | frontier | custom
scope_expression:
body_encoding: inline_json | chunked_utf8
inline_body:
payload_id:
part_count:
requested_budget:
base_revision:
evidence_handles: []
created_at:
```

Canonical `REQUESTS` columns:

```text
A protocol
B request_id
C idempotency_key
D actor_claim
E project_id
F operation
G intelligence
H scope_expression_json
I body_encoding
J inline_body
K payload_id
L part_count
M requested_budget_json
N base_revision
O evidence_handles_json
P created_at
```

`PAYLOAD_PARTS` columns:

```text
A payload_id
B part_index
C part_count
D utf8_text
E created_at
```

ERC, not ChatGPT, canonicalizes and computes envelope/payload/part SHA-256 after readback. Client timestamps and actor labels are informational.

Limits:

```text
≤ 30,000 characters per payload cell
target ≤ 64 KiB per contribution
hard ≤ 128 KiB per contribution
≤ 5 payload parts
larger input → direct ERC PWA/R2 upload
```

The limit is deliberately lower than Sheets API maxima to keep one ChatGPT action reliable. Drive is a control/exchange surface, not bulk ingest.

`request_id + idempotency_key` is unique in D1. Duplicate rows receive `DUPLICATE_IGNORED` and never create a second authoritative job.

`actor_claim` is untrusted metadata. Drive proves a Google-account write, not cryptographic ChatGPT authorship. This is sufficient because all Drive writes are candidate-only.

## 12.6. Read and conversational flow

Bootstrap in an interactive ChatGPT conversation:

```text
1. Explicitly select/@mention Google Drive if needed.
2. Open exact ERC Exchange Sheet URL.
3. Read SYSTEM and CATALOG.
4. Append one REQUESTS transaction.
5. Read RECEIPTS/RESULTS by request_id.
6. Open exact Result Doc URL or artifact handle.
```

Scheduled Tasks/background ChatGPT runs are not part of connector correctness: connected apps may be unavailable in scheduled execution. ERC background work starts only after the row is durably imported into D1.

States:

```text
SUBMITTED
→ IMPORTED
→ QUEUED
→ RUNNING
→ COMPLETE | PARTIAL | FAILED | REAUTH_REQUIRED
```

A ChatGPT submission is successful only after exact `request_id` readback from the Sheet. Natural-language “saved” is not a receipt. Completion is delivered only after matching `RESULTS` or terminal `RECEIPTS` readback.

## 12.7. DriveExchangeAdapter correctness

Day-0 uses cursor polling, not expiring push channels:

```text
create template
→ getStartPageToken before exposing Sheet
→ store cursor in D1
→ Cron every minute
→ changes.list until nextPageToken exhausted
→ reconcile exact Exchange file IDs
→ persist newStartPageToken only after all changes commit
```

The page token does not expire. Optional `changes.watch` is a latency hint only; notifications contain no changed content and channels expire.

For each changed Exchange Sheet:

```text
acquire D1 cursor lease
→ read from last grid extent
→ bounded scan of ID columns for prior rows
→ locate by request_id/payload_id, never permanent row number
→ verify protocol, part count, UTF-8 and byte budget
→ canonicalize cells and compute hashes
→ detect edit/reorder/delete of imported rows
→ freeze exact envelope in R2
→ insert generic ContributionIntent idempotently
→ enqueue job
→ append Receipt
→ persist cursor/grid extent only after readback
```

Modified historical content produces `TRANSPORT_TAMPERED`; the frozen R2 envelope remains authority. Daily bounded audit rechecks all IDs and hashes.

### D1 connector tables

```sql
CREATE TABLE google_connection (
  connection_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  google_subject TEXT NOT NULL,
  google_email TEXT NOT NULL,
  granted_scopes_json TEXT NOT NULL,
  refresh_token_ciphertext BLOB NOT NULL,
  refresh_token_nonce BLOB NOT NULL,
  token_key_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  last_success_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE drive_exchange_generation (
  generation_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  spreadsheet_id TEXT NOT NULL,
  sheet_ids_json TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);

CREATE TABLE drive_change_cursor (
  connection_id TEXT PRIMARY KEY,
  start_page_token TEXT NOT NULL,
  last_poll_at INTEGER,
  last_success_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER
);

CREATE TABLE drive_exchange_observation (
  generation_id TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  idempotency_key TEXT,
  observed_row INTEGER,
  drive_modified_time TEXT,
  actor_claim TEXT,
  frozen_r2_key TEXT,
  disposition TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY(generation_id, object_kind, object_id)
);

CREATE UNIQUE INDEX drive_request_idempotency
ON drive_exchange_observation(generation_id, idempotency_key)
WHERE object_kind = 'request' AND idempotency_key IS NOT NULL;
```

Drive-specific state stops at transport observation/freeze. Generic ContributionIntent/job/receipt tables remain canonical.

### `GoogleDrivePort`

```typescript
interface GoogleDrivePort {
  getStartPageToken(): Promise<string>;
  listChanges(pageToken: string): Promise<DriveChangePage>;
  readSheetRanges(spreadsheetId: string, ranges: string[]): Promise<SheetRange[]>;
  batchUpdateSheet(spreadsheetId: string, requests: unknown[]): Promise<WriteReceipt>;
  createResultDocument(input: ResultDocumentInput): Promise<DriveObjectRef>;
  exportDocument(fileId: string, mimeType: string): Promise<ReadableStream<Uint8Array>>;
  getFileMetadata(fileId: string): Promise<DriveFileMetadata>;
}
```

The adapter uses bounded REST `fetch`; no large Google SDK is bundled into the Worker.

## 12.8. Result publication

```text
ResearchArtifactRevision in R2
→ D1 terminal receipt
→ optional new Google Doc delivery copy
→ append RESULTS row with request_id/artifact_id/URLs/ERC hashes
→ read back row/metadata
```

A changed artifact creates a new Drive Doc/delivery revision. Drive revision history is diagnostic, not canonical evidence; bytes must be exported and frozen into R2 first.

## 12.9. Google OAuth contract

Use a dedicated Google Cloud project, user OAuth (not a service account for personal My Drive), and web-server authorization-code flow with `access_type=offline`.

Scopes:

```text
openid
email
https://www.googleapis.com/auth/drive.file
```

Broad `drive` and `drive.readonly` are prohibited. Publishing status must be `In production`; Testing refresh tokens expire after seven days for these scopes.

Token handling:

```text
client secret / token KEK   Cloudflare secret
refresh token               AES-GCM encrypted D1 record
access token                short-lived request cache
invalid_grant               REAUTH_REQUIRED
revocation                  stop Google path; preserve D1/R2
```

Connection admission verifies the authorized Google subject/email matches the configured dedicated exchange identity.

## 12.10. Failure model

| Failure | Required behavior |
|---|---|
| Drive app connected but search finds no files | exact Sheet URL/ID; no search dependency |
| tool unavailable/write blocked | no claim of submission until exact row readback |
| duplicate/retried action | D1 idempotency returns existing receipt |
| response lost after write | cursor/readback discovers exact row |
| poll fails | bounded backoff; cursor not advanced |
| webhook missed/expired | minute cursor still imports |
| OAuth revoked | `REAUTH_REQUIRED`; no destructive retry |
| row edited/reordered/deleted | ID/hash audit; `TRANSPORT_TAMPERED` |
| partial parts | `INCOMPLETE`; job not started |
| Result Doc unavailable | canonical R2 artifact still available |
| Google outage | PWA/direct API/agents continue |
| wrong project/scope | D1 policy rejects before job creation |

Operational reports show occasional connected-but-empty Drive/tool states, plan-dependent write availability and action dispatch regressions. Exact IDs, append-only rows, cursor replay and readback prevent UI failure from becoming canonical data loss.

## 12.11. Google Cloud boundary

### Permanent production use

One project:

```text
eliotr-google-prod
```

Contains only:

```text
Drive API
Docs API
Sheets API
OAuth client/consent
optional Vertex service account through Cloudflare AI Gateway
optional BigQuery billing-export dataset
```

Cloudflare remains sole backend for HTTP/PWA, metadata, storage, queues, workflows, retrieval, Wiki and Investigation.

Do not add:

```text
Cloud Run
Firestore
Pub/Sub / Cloud Tasks
Cloud Storage
Google Workflows
Vertex AI Search / Agent Search production index
```

### Vertex provider

```text
ERC → Cloudflare AI Gateway → Vertex AI
```

The service account receives only required inference roles. Google credentials remain in AI Gateway/secret boundary. Gemini Developer API Free Tier is allowed only for public/non-sensitive evaluation under current data-use terms; private documents use paid Vertex/BYOK or another approved provider.

### Promotional credit

The `$1,000 GenAI App Builder` credit is experiment-only. Exact `Scope` and `Credit ID` must be verified.

Temporary project:

```text
eliotr-promo-scope-test-20260827
```

Allowed use:

```text
one Ranking API attribution test
reranker/hard-negative benchmark after confirmed attribution
Layout/OCR benchmark if covered
delete persistent resources before expiration
```

No production component depends on this credit.

## 12.12. Future native Eliot Research app

A reviewed native app may later replace Drive for lower-latency calls. It is a replacement, never a second simultaneous ChatGPT integration:

```text
CHATGPT_TRANSPORT = google_drive_exchange
or
CHATGPT_TRANSPORT = native_eliotr_app
```

Day-0 and first production release use `google_drive_exchange`.

# 13. Disclosure, injection safety and privacy erasure

## 13.1. Four independent policy axes

```text
StoragePolicy
  ORIGINAL_CLOUD
  NORMALIZED_CLOUD_ONLY
  METADATA_ONLY
  LOCAL_FEDERATED
  REDACTED_CLOUD_COPY

InferenceDisclosurePolicy
  workers_ai_allowed
  approved_byok_providers[]
  local_model_allowed
  web_search_allowed
  vision_allowed
  maximum_disclosure_class

ClientDisclosurePolicy
  owner_pwa
  named_api_client
  trusted_agent
  chatgpt_drive_exchange
  public_demo

RetentionAndLicensePolicy
  retention_until
  legal_delete_required
  legal_hold_ref
  redistribution_allowed
  model_processing_allowed
  citation_excerpt_allowed
  derivative_publication_allowed
```

Permission to view in PWA does not imply permission to disclose to ChatGPT or an external model.

## 13.2. Enforcement order

```text
authenticate principal
→ resolve ScopeExpression
→ freeze ScopeSnapshot
→ apply current PurgeLedger revision
→ security read permission
→ task/source policy
→ client disclosure
→ inference-provider disclosure
→ retrieval
→ post-retrieval recheck
→ output minimization
```

## 13.3. Prompt-injection boundary is executable, not prose

ERC defines local security contracts with semantics compatible with the optional ELIOT adapter:

```text
SourceAssurance
InstructionTaint
EffectCeiling
TransformationLineage
SelectionIntegrityReceipt
DeclassificationReceipt
DisclosureDependencyClosure
```

These types are owned and versioned by ERC. An optional adapter may map them losslessly to client equivalents, but no external security crate is a core build or runtime dependency.

Every source and projection item carries:

```text
instruction_taint:
  CLEARED | DATA_ONLY | UNTRUSTED | COMMAND_LIKE

allowed_effects:
  READ_ONLY | CANDIDATE_ONLY | NO_EXTERNAL_EFFECT
```

### Context compilation

Source text enters the model only inside a structured untrusted-data envelope:

```yaml
EvidenceContextBlock:
  evidence_handle:
  source_revision_id:
  instruction_taint:
  allowed_effects:
  quoted_content:
```

Rules:

```text
source content never joins system/developer/tool instruction fields
quoted instructions cannot request tools, secrets, policy changes or write actions
research generation receives read-only retrieval tools only
side-effect-capable tools are absent, not merely discouraged
untrusted text cannot expand scope or disclosure
summarization preserves taint unless a DeclassificationReceipt exists
```

### Selection integrity

Every membership-changing transformation—rerank, prune, summary, context compile, export—emits or contributes to `SelectionIntegrityReceipt`. It records input candidates, admitted/rejected candidates and whether untrusted structure changed membership.

### Output gate

Before publication:

```text
validate structured output schema
→ resolve every citation
→ reject policy/tool instructions derived only from source content
→ reject unsupported authority elevation
→ classify statements
→ apply effect ceiling
```

Detection models are advisory. The security boundary is tool absence, typed envelopes, taint lineage, effect ceiling and publication admission.

## 13.4. Google Drive Exchange capability ceiling

ChatGPT receives only the permissions granted to the qualified Google Drive app and the exact actions enabled for the connected account/session. It receives no Cloudflare, D1, R2, AI Search, BYOK, Queue or Workflow credential. If the required write action is unavailable, the ChatGPT path is read-only/degraded and Draft Inbox contribution is disabled rather than emulated through prose.

The exchange account contains only bounded catalog, requests, receipts, result references and policy-approved excerpts. Private corpus text is not exported by default.

Incoming rows are:

```text
instruction_taint = UNTRUSTED
allowed_effects = CANDIDATE_ONLY
```

They cannot publish active Wiki, change ACL/policy, perform erasure or start unquoted premium work.

## 13.5. Secrets

```text
provider keys                  AI Gateway Secrets Store
Google OAuth client secret     Cloudflare secret
Drive token-encryption key     Cloudflare secret
encrypted refresh token        D1
browser / ChatGPT              no infrastructure credentials
agents                         no D1/R2/Google credentials
```

## 13.6. Google authorization lifecycle

```text
connect in ERC PWA
→ Google authorization-code flow with offline access
→ verify scopes and dedicated exchange identity
→ encrypt refresh token
→ provision exact folder/Sheet IDs
→ create changes cursor
→ live read/write fixture
```

Connector states:

```text
DISCONNECTED
AUTHORIZING
ACTIVE
DEGRADED
REAUTH_REQUIRED
REVOKED
```

The Google connector may be degraded while ERC remains ready.

## 13.7. Privacy Erasure contract

ERC owns the self-contained wire/domain contract `erc.privacy.erasure.v1`:

```text
ErasureRequest
ErasureBackend
ErasureReceipt
PurgeLedgerEntry
PurgeLocation
PurgeState
```

The optional ELIOT adapter maps these types to the compatible ELIOT erasure profile. ERC core neither imports ELIOT crates nor creates a second deletion path inside a client system.

### Purge closure

ERC `PurgeLocation` values cover:

```text
CanonicalPayload
Projection
Index
Blob
OperationalRecovery
ProviderCopy
BackupRestorePath
RouteContinuation
```

### Lifecycle

```text
REQUESTED
→ QUARANTINE_AND_REVOKE
→ ENUMERATE_DEPENDENCY_CLOSURE
→ CHECK_RETENTION_AND_HOLDS
→ PURGE_EACH_LOCATION
→ VERIFY_ABSENCE_OR_BLOCK
→ APPEND_PURGE_LEDGER
→ INVALIDATE_DEPENDENTS
→ COMPLETE | BLOCKED
```

Immediately after request admission, affected content is excluded from new client/model routes while the physical purge proceeds.

### Exact completion

Success requires exact requested-location equality, matching the local `erc.privacy.erasure.v1` contract. A subset cannot produce `PURGED`.

### Retention conflict

If a Bucket Lock or legal hold prevents deletion:

```text
PurgeState = BLOCKED
blocked_location and policy/hold ref recorded
content remains unavailable for ordinary use where legally permitted
no success receipt is issued
owner sees next review/expiry date
```

### EvidenceHandle terminal states

```text
LIVE
STALE
COLD_RESTORABLE
REDACTED
RETENTION_BLOCKED
BROKEN_INTEGRITY
```

`REDACTED` returns no deleted content and only a non-revealing tombstone/purge reference. It is not `BROKEN_INTEGRITY` and cannot be silently substituted by a derived copy.

### Dependent artifacts

```text
purged evidence
→ dependent Wiki/artifact blocks become REDACTED_DEPENDENCY or PENDING_REVALIDATION
→ public/exportable projections deleted or rebuilt
→ active claims lose support unless another live evidence handle remains
```

### `REDACTED_CLOUD_COPY`

A redacted derivative may survive erasure only when it has a valid `DeclassificationReceipt` proving the exact transformation:

```text
exact input hash
exact output hash
removed/generalized privacy domains
preserved domains
verifier/property
residual limitations
```

The redaction transform is versioned and repeatable. A model summary or manually edited copy is not automatically declassified. Without a valid receipt, the derivative remains inside the purge dependency closure and is deleted with the original.

### Backup and restore

Purge ledger is part of every BackupEpoch. Restore applies the latest purge ledger before read traffic or projection rebuild. Old backup media expires or is physically purged according to `BackupRestorePath`; it can never resurrect current data.

## 13.8. Bucket Lock policy

Bucket Lock applies only to prefixes whose policy permits minimum retention. Strictest overlapping rule wins, so broad root-level locks are prohibited.

```text
<residency-key> with erasable policy     no Bucket Lock
<residency-key> with retained policy     bounded lock matching declared retention
<residency-key> under legal hold         lock until separately governed hold release
```

Before admission, system proves that `retention_until`, lock rule and `legal_delete_required` are compatible. Otherwise upload is rejected or routed to an erasable domain.

# 14. Cost architecture

## 14.1. Budget denominators

Percentages never apply to an unnamed budget.

```yaml
BudgetPools:
  monthly_platform_usd:
  monthly_workers_ai_usd:
  monthly_byok_usd:
  monthly_total_usd:
  project_overrides: {}
  reset_at:
```

Default governor acts against both the affected pool and total budget.

## 14.2. Current platform floor

Verified against official documentation on 2026-08-28:

```text
Workers Paid minimum                 $5/month
Worker requests included             10M/month
Worker CPU included                  30M CPU-ms/month
D1 included                          25B rows read, 50M rows written, 5 GB
R2 free tier                         10 GB-month, 1M Class A, 10M Class B
Workflows steps included             500,000/month
AI Search orchestration              free during open beta
Workers AI                           10,000 neurons/day free, then usage billing
Analytics Engine                     currently not billed; published future allowance applies
```

Frontier BYOK is billed by the provider. No unlimited frontier research is promised for $5.

## 14.3. Cost classes

```text
L0 EXACT             no model
L1 KEYWORD           D1 FTS / AI Search keyword
L2 HYBRID            query embedding + hybrid retrieval
L3 RERANK            top subset
L4 ECONOMY ANSWER    Workers AI generation
L5 STRONG/FRONTIER   BYOK
L6 AUDIT/REPORT      branches + verifier + artifact compiler
```

## 14.4. BudgetReservation

Before DEEP/AUDIT/REPORT, full reindex or bulk distillation:

```yaml
CostQuote:
  operation_kind:
  estimated_model_calls:
  estimated_input_tokens:
  estimated_output_tokens:
  estimated_embedding_tokens:
  quoted_neurons:
  selected_routes:
  platform_usd:
  workers_ai_usd:
  byok_usd:
  max_total_usd:
  workflow_steps:
  expected_sources:
  expected_sections:
  confidence:
```

D1 reserves approved budget and settles actual ModelCallReceipts.

## 14.5. Concrete corpus arithmetic

Illustrative, not a promise:

```text
1,000 documents
× 20,000 normalized tokens average
= 20M source tokens

+20% heading/context/overlap projection overhead
= 24M embedding input tokens
```

Qwen3 Embedding 0.6B rate verified on 2026-08-28:

```text
24M × $0.012/M                     = $0.288 nominal
24M × 1,075 neurons/M              = 25,800 neurons
one-day overage after 10k free     = 15,800 neurons
15.8 × $0.011                      ≈ $0.174 charged if all in one UTC day
spread over 3 free-allocation days ≈ $0 embedding charge
```

If 20% of corpus is physically duplicated into ChatGPT-exportable index:

```text
4.8M extra embedding tokens
≈ 5,160 neurons
≈ $0.058 nominal
```

Typical retrieval day:

```text
100 query embeddings × 100 tokens  = 10,000 tokens ≈ 10.75 neurons
20 reranked queries × 20 candidates × 400 tokens
                                    = 160,000 tokens ≈ $0.00048 nominal
```

The dominant variable cost is not retrieval; it is BYOK synthesis, audits and reports. Those require per-run quote.

## 14.6. Budget Governor

For each pool and total:

```text
70%  warn; reduce speculative maintenance
80%  stop optional background distillation
90%  Economy default; no automatic frontier escalation
95%  explicit confirmation for DEEP/AUDIT/REPORT/reindex
100% block premium calls unless owner raises the budget
```

Still available:

```text
capture
exact
lexical
semantic while platform/Workers AI allowance permits
open
quote
trace
existing Atlas/Wiki/artifacts
evidence pack
```

## 14.7. Google Drive Exchange budget

```yaml
DriveExchangeBudget:
  poll_interval_seconds: 60
  max_requests_per_minute: 20
  max_writes_per_minute: 10
  target_contribution_bytes: 65536
  hard_contribution_bytes: 131072
  max_payload_parts: 5
  max_result_docs_per_day: 100
```

The minute `changes.list` poll is about 43,200 lightweight checks per 30-day month, far below Workers and Google API allowances. The adapter still uses bounded backoff.

## 14.8. Cost risks

```text
AI Search leaves open beta
full embedding migration
unnecessary full reindex
unbounded swarm/model fan-out
Browser Rendering instead of static capture
full-corpus distillation after prompt change
Vertex route without quote
promo resources left alive
```

## 14.9. Google cost boundary

Permanent Google-side runtime cost should normally be near zero:

```text
Drive/Docs/Sheets API        low-volume standard API usage
OAuth project                no server
BigQuery billing export      optional/free-scale analytics
Vertex inference             variable BYOK/provider billing
```

The recurring `$10` credit is a safety buffer. The expiring `$1,000` promotion is excluded from production assumptions.

# 15. Reliability, observability and operations

## 15.1. Every mutation has an operational contract

```text
Intent
→ Attempt
→ Receipt
→ Readback
→ Reconciliation
```

Timeout is not proof of failure.

## 15.2. D1 write discipline

- model calls never occur inside D1 transactions;
- proposals/receipts are append-heavy;
- active heads use expected-revision CAS;
- canonical mutation + outbox are one D1 transaction;
- Queue is accelerated delivery; outbox sweeper is durable intent;
- agents receive no direct SQL.

## 15.3. R2 publication

R2 is strongly consistent but concurrent writes to one key are last-writer-wins. Canonical keys are immutable within their complete residency identity.

```text
new content → new key
```

Existing identical object is success; differing content at same canonical key is integrity failure. Privacy Erasure uses the dedicated exception in §13.7.

## 15.4. Readiness and freshness

Every answer reports eligible/represented revisions, stale/degraded channels, unsearched regions, high-fidelity state, purge/redaction effects and budget stops.

## 15.5. CoverageReceipt

```yaml
CoverageReceipt:
  requested_scope_and_frozen_scope_snapshot_ref:
  coverage_denominator_ref:
  denominator_kind: complete_scope | sampled_with_method | unknown
  eligible_sources:
  represented_sources:
  cited_sources:
  omitted_sources_and_reasons:
  unknown_coverage_and_reason:
  source_families_and_independence_profile:
  lanes_used_stale_and_skipped:
  failed_acquisition_and_provider_degradation:
  parser_degradation:
  redacted_dependencies:
  counter_search_status:
  budget_limitations:
  terminal_disposition: CompletionDisposition
```

Only `denominator_kind = complete_scope` can support a scoped absence disposition. A top-k result, exhausted model, completed Workflow, sampled denominator, or unknown denominator cannot be relabeled as complete coverage.

## 15.6. Observability contract

Production emits three complementary surfaces:

```text
Workers Logs/Traces
  request and binding failures, sampled success traces

Analytics Engine
  compact application metrics with high-cardinality dimensions

D1 health_snapshot / incident
  current actionable state, not raw telemetry archive
```

### Required dimensions

```text
operation_kind
query_product
project_id_hash
route_generation
embedding_generation
index_generation
workflow_stage
result_disposition
error_class
```

No source text, prompt body, private path or evidence excerpt enters metrics.

### Required metrics

```text
requests, errors, CPU and duration
p50/p95/p99 by semantic operation
D1 query/write latency
AI Search latency/error/no-hit rate
projection and outbox lag
Queue depth/retries/DLQ
Workflow stage duration/retry/failure
R2 staging age and orphan bytes
citation-resolution failures
exact and semantic golden-set regressions
source readiness distribution
coverage and redaction counts
model tokens, neurons and provider cost
embedding-generation build progress
ErasureCase age/state/blocked locations
Google Drive Exchange quota, OAuth and disclosure denials
local-node availability when Track H enabled
```

### Sampling

```text
errors, security/erasure, DEEP/AUDIT/REPORT  100%
ordinary FAST success                       5–10%
raw model/source content                    never by default
```

Workers Logs have short retention; durable performance/cost summaries live in Analytics Engine and D1 snapshots.

## 15.7. SLO and alert thresholds

Initial thresholds, replaced only by measured profiles:

```text
Worker error rate >1% for 10 min                    alert
hybrid locate p95 >2.5 s for 30 min                 warn
exact handle read p95 >800 ms for 30 min            warn
outbox oldest unsent >5 min                         alert
DLQ message count >0                                alert
projection lag >15 min for active sources           warn
citation resolution <100% in accepted output        block publish
Golden Corpus forbidden collapse >0                 block generation promotion
ErasureCase overdue or blocked without review date  alert
monthly budget pool ≥70/80/90/95/100%               governor actions
R2 staging object older than retention window       alert/cleanup
```

PWA always displays health. Owner notification sink is configurable. Cloudflare native billing/platform notifications are enabled; application SLO evaluator may send email/webhook through an explicitly configured sink. Lack of a sink does not hide health from PWA.

## 15.8. Performance targets

```text
catalog/orient cached p95       < 500 ms excluding client network
exact handle read p95           < 800 ms
hybrid locate p95               < 2.5 s
interactive first token         < 4 s after retrieval
Deep/Audit/Report               asynchronous
```

Targets are emitted per route/index generation and become acceptance budgets after live baseline.

# 16. Backup, restore, erasure and exit

## ERC24-DEC-013 — D1 Time Travel is not the only backup

```text
D1 Time Travel
  operational recovery in same account

BackupEpoch
  portable application backup

Offsite copy
  independent failure domain
```

## 16.1. BackupEpoch

```text
schema and migration ledger
D1 Core JSONL
project/source/membership manifests
EvidenceHandle registry
R2 object manifest
Wiki/artifact/investigation heads
research artifact manifests
model/prompt/route generations
AI Search configurations
PurgeLedger revision and entries since prior epoch
hashes and audit sample
```

D1 Search, AI Search, Queue and live DO are rebuilt.

## 16.2. Offsite

At least one independent encrypted copy:

```text
OneDrive mirror
second object provider
second Cloudflare account with independent credentials
```

Offsite copy must support deletion journal and retention expiry. A backup that cannot respect `BackupRestorePath` purge obligations is not an admissible destination for erasable data.

## 16.3. Erasure-aware restore order

```text
create clean staging account
→ restore D1 Core in isolated mode
→ restore PurgeLedger and current policy before payload exposure
→ enumerate restored objects against purge ledger
→ delete/quarantine purged objects and derived copies
→ restore/verify remaining R2 Evidence and Work
→ verify heads and migrations
→ rebuild D1 Search
→ recreate AI Search instances
→ upload only non-purged projection items
→ rebuild Atlas/Wiki derived views
→ sample LIVE and REDACTED EvidenceHandles
→ run exact/high-recall/erasure acceptance queries
→ declare ready
```

Restore never resurrects purged influence or content as current.

## 16.4. Backup deletion policy

```text
new purge
→ append purge ledger
→ mark all backup epochs requiring replay
→ physically delete mutable offsite copies where required
→ expire immutable backups on bounded schedule
→ create sanitized replacement epoch when policy requires
```

If a locked backup cannot be deleted before a legal deadline, the storage policy was invalid; system reports `PURGE_BLOCKED` and does not claim completion.

## 16.5. Exit from Cloudflare

Portable export contains R2 objects, D1 JSONL, schemas/migrations, EvidenceHandles including tombstones, project/scope manifests, Wiki/reports, model/prompt generations, purge ledger and projection source items. Internal vector indexes are rebuildable.

# 17. Implementation shape

## 17.1. Cloud source topology — one active bundle

```text
/apps/eliotr-core
/apps/eliotr-pwa

/packages/contracts
/packages/domain
/packages/policy
/packages/platform-cloudflare
/packages/retrieval
/packages/research
/packages/interfaces
/packages/google-drive-exchange
  protocol schemas
  Sheet template/provisioner
  append serializer
  changes cursor/reconciler
  OAuth token vault
  R2 freeze/readback
  tamper/generation audit
/packages/testkit
```

Source packages compile to one `eliotr-core` Worker plus static PWA assets. A package is not a service.

## 17.2. Production dependency policy

Allowed by default:

```text
agents
@modelcontextprotocol/sdk
zod or one equivalent validator
hono optional
```

Development only:

```text
typescript
wrangler
@cloudflare/workers-types
@cloudflare/vitest-pool-workers
eslint
```

Forbidden in production Worker bundles:

```text
LangChain / LlamaIndex orchestration stacks
provider-specific SDK collections
Prisma/server database engines
PDF/OCR/native packages
Git clone libraries
embedded vector/search databases
headless browser packages
child-process/filesystem packages
runtime-loaded plugins
large Google SDK
```

Cloudflare resources use bindings. Google and model providers use small typed fetch-based ports.

## 17.3. Build and packaging proof

CI runs:

```text
pnpm install --frozen-lockfile
contracts:check
lint
typecheck
T0–T3 tests
wrangler types --check
wrangler deploy --dry-run --minify
bundle/startup/forbidden-import checks
Workers integration tests
PWA bundle budgets
```

No deployment is accepted merely because TypeScript compiles.

## 17.4. D1 migration policy

```text
add table/column/index
→ deploy compatible code
→ bounded backfill Workflow
→ switch schema generation
→ observe
→ remove old path only later
```

Core D1 is not disposable. D1 Search can be rebuilt. No destructive migration occurs in the same release as the new reader/writer.

## 17.5. External normalized-bundle bridge

ERC owns only `eliotr.normalized.v1` and the upload API. Xberg, Docling, OCR, and code analyzers remain in qualified external preprocessing providers.

An optional `eliotr-sync.exe` is an uploader, not a Research daemon.

## 17.6. External-client adapters

Core ERC owns the generic federation API. Optional client adapters live in isolated packages, consume generated schemas only, and import no D1/R2/Drive implementation types. The ELIOT-side composition root remains in the ELIOT repository.

## 17.7. Cloudflare-fit invariant

A first-party feature is accepted only when it is bounded Worker logic, a managed binding call, a DO coordination atom, a Workflow over handles, a D1/R2 operation or an optional local capability.

If it requires native process, persistent filesystem, corpus in memory, unbounded CPU or an embedded index, it does not belong in the Worker.

---

# 18. Implementation by vertical slices

The sequence delivers a working user loop before advanced research machinery.

## Slice 0 — platform skeleton and Drive exchange proof

```text
generated `eliotr.normalized.v1`, `source.owner-cutover.v1`, and generic federation schema fixtures
SourceNamespaceOwnership/ObjectResidencyKey contract fixtures
D1 Core/Search migrations
R2 Evidence/Work with complete residency domains
Cloudflare core Worker + PWA skeleton
two AI Gateways
Access
dedicated exchange Google account
Google OAuth drive.file + offline access
OAuth publishing status Production
Exchange Sheet template + fixed sheet IDs
exact Google Drive account/action capability qualified
real atomic append/readback/reconnect fixture
D1 cursor/idempotency/receipt schema
observability/cost skeleton
```

Slice 0 is incomplete until the actual Drive app writes one disposable request and reads the resulting receipt.

## Slice 1 — evidence-grade retrieval and intelligent chat

```text
SourceAcquisitionCandidate/SourceAdmissionDecision/SourceRevision lifecycle
one-owner namespace state machine
federated reference / immutable import / fenced ownership-cutover paths
many-to-many projects
toMarkdown + qualification
exact `eliotr.normalized.v1` ingest with admission receipt and exact `source.owner-cutover.v1` validation
explicit unsaved-snapshot admission; no hidden/background unsaved ingest
StructuralProjector
EvidenceHandle
D1 FTS
AI Search prose/literal
BYOK ResearchSession
PWA chat/evidence drawer
Drive cursor poll
REQUESTS → D1/R2 → RECEIPTS round trip
```

## Slice 2 — minimum Wiki and typed federation API

```text
minimal WikiPageRevision
statement labels/evidence map
private semantic API
generic federation backend/client fence
exact ELIOT compatibility-field mapping, transport/completion-state separation, and less-assertive disposition mapping
ResearchEvidenceBundle + ranged reads
Drive CATALOG/RESULTS publication
Draft Inbox and D0/D1 admission
```

## Slice 3 — Corpus Lens

```text
SourceCard
DocumentMap
ProjectAtlas
orientation UI/API
multi-project scopes
readiness/coverage
```

## Slice 4 — Controlled Investigation

```text
Investigation
InquiryProtocolProfile
QuestionGraph
HypothesisCard
SourcePortfolio
branches
ResearchWorkflow
CoverageReceipt
```

## Slice 5 — distillation, audits and Artifact Compiler

```text
EvidenceAtoms
ArgumentMap
paper/project profiles
COMPARE
HYPOTHESIS_REVIEW
FACT_CHECK
PROJECT_VS_LITERATURE_AUDIT
section-based Artifact Compiler
full Wiki dependencies/staleness
Drive result delivery copies
```

## Slice 6 — hardening and optional native replacement

```text
Drive failure/quota tests
push notifications as advisory optimization
OAuth reconnect/revocation
Vertex route conformance
optional native Eliot Research app pilot
```

Native app is enabled only as a replacement transport after it passes the same gates.

## Slice 7 — specialist profiles

```text
code intelligence
scholarly metadata
conversation episodes
structured data/R2 SQL
optional graph benchmark
```

# 19. Evaluation, acceptance and live conformance

## 19.1. Test ladder

```text
T0  pure contract/schema/unit
    IDs, complete residency key, source-owner/cutover state machine,
    exact `source.owner-cutover.v1` body hash and bilateral-authorization rules,
    Evidence Grade transition/supersession, policy, erasure closure, cost arithmetic

T1  recorded deterministic fixtures
    exact `eliotr.normalized.v1` Search↔Research round trip, exact cutover receipt,
    owner/generation/view/revision-set mismatch rejection, parser bundle,
    acquisition-candidate effect ceiling, EvidenceHandle, R2 promotion,
    federation DTO and disposition mapping

T2  retrieval Golden Corpus
    exact, phrase, literal, semantic, multi-project, exhaustive

T3  semantic Nuance Golden Corpus
    modality, conditions, authority, chronology, dissent, negative results

T4  vertical Cloudflare + Google Drive integration
    Drive app → atomic Sheet append → cursor import → D1/R2
    → Research/PWA/Wiki → Result Doc/RESULTS row → exact readback

T5  failure, security and erasure injection
    stale generations, dual-writer/cutover failure, cross-domain dedup/key reuse,
    hidden unsaved-content persistence, prompt injection, lost ACK, blocked lock, restore purge

T6  live workload profile
    p95, cost, index throughput, 5/20/50 agent readers, real corpus quality
```

A local package change runs only affected levels; model/prompt/parser/retrieval generation promotion always runs T2–T3 and relevant T4/T5 fixtures.

## 19.2. Versioned Golden Corpus

Golden set is built from real project documents, papers, chats and code, not toy prose.

```yaml
GoldenCase:
  case_id:
  source_revision_ids: []
  scope_expression:
  question:
  expected_product:
  required_atoms: []
  forbidden_collapses: []
  required_evidence_handles: []
  acceptable_unknowns: []
  coverage_requirement:
  adjudication_notes:
```

Mandatory case families:

```text
recommendation vs decision
hypothesis vs observed result
plan vs implemented state
current vs superseded statement
failed approach / negative result
number with unit and conditions
source contains evidence but supplied excerpt is insufficient
stitched/cropped/snippet text presented as exact support
same claim under different population/version
apparent contradiction explained by scope
real contradiction with counterevidence
complete-scope absence vs incomplete search
source prompt injection
purged/redacted evidence dependency
```

## 19.3. Research quality gates

```text
forbidden collapse count                              0
recommendation → decision                             0
hypothesis → observation                              0
critical condition/scope loss                         0
current/superseded confusion                          0
counterevidence omitted from AUDIT                    0
accepted citation resolution                          100%
number absent from cited span                         0
source/excerpt support sufficiency conflated             0
stitched/cropped/search-snippet text accepted as quote    0
supported result without CoverageReceipt              0
CoverageReceipt without denominator kind/snapshot binding  0
NO_MATCH_IN_COMPLETE_SCOPE on sampled/unknown denominator   0
post-freeze evidence used without freeze reopen/revision  0
grade lowered without versioned supersession/receipt    0
observed status/fidelity inferred from Evidence Grade   0
unadmitted acquisition candidate enters retrieval/context/Wiki  0
unsupported precision lacks typed item and next probe      0
uncaptured web result used as evidence                 0
```

Each result stores model, route, prompt, parser, retrieval and embedding generations. Regression blocks active promotion; it does not merely create a warning.

## 19.4. Retrieval gates

```text
exact pinned-handle reproducibility                   100%
exact phrase recall in complete scope                 100%
all-occurrences uses complete-scope lane              100%
semantic Recall@20 on labelled relevant sections      project threshold, initially ≥0.90
source-family diversity regression                    0 unapproved
AI Search no-hit treated as absence                   0
```

## 19.5. Projects and disclosure

```text
one source in multiple projects                       supported
canonical object duplication due only to membership  0 within the same complete residency identity
cross-domain physical co-residency/deduplication       0
cross-domain ciphertext or encryption-key reuse         0
UNION/INTERSECT/EXCEPT deterministic                  100%
cross-project/client/provider disclosure leakage     0
cutover accepted without exact bilateral receipt         0
cutover owner/generation/view/revision-set mismatch       0
ChatGPT private-index hit                              0
```

## 19.6. Wiki, Draft Inbox and artifacts

```text
active Wiki update without CAS                       0
D2/D3 draft auto-promotion                            0
D0/D1 promotion without exact handles/policy receipt 0
one-section edit forces full report regeneration     0
purged evidence remains active support                0
```

## 19.7. Google Drive ChatGPT exchange gates

```text
more than one ChatGPT write app in normal path             0
Drive search/sync used as correctness dependency           0
write touches existing request row                         0
request accepted without protocol/readback                 0
duplicate request creates authoritative duplicate          0
cursor advanced before full reconciliation                 0
missing payload part starts job                            0
Drive revision used as canonical evidence                  0
actor_claim treated as cryptographic ChatGPT identity      0
scheduled ChatGPT task required for correctness             0
Google outage disables PWA/direct/agent API                  0
Testing-mode token accepted for production                  0
broad drive/drive.readonly scope requested                 0
ChatGPT connected to unrelated personal Drive corpus        0
wrong exchange identity accepted                            0
Sheet schema changed in place                               0

current-account tool inventory                              OBSERVED
disposable interactive append + exact readback              LIVE GATE
batch request/payload atomicity                              PASS
valid Google RowData JSON fixture                           PASS
fixed sheet-ID/schema generation fixture                    PASS
duplicate/idempotency fixture                               PASS
cursor replay after missed poll                             PASS
OAuth restart/refresh/revoke fixture                        PASS
historical-row tamper detection                             PASS
R2 freeze before admission                                  PASS
Result Doc/RESULTS readback                                 PASS
ChatGPT reconnect and exact-ID access                       LIVE GATE
```

## 19.8. Prompt injection

```text
source instruction changes system/tool policy         0
untrusted content triggers side-effect tool            0
summary clears taint without DeclassificationReceipt  0
Drive contribution crosses CANDIDATE_ONLY ceiling     0
selection membership changes without receipt           0
```

## 19.9. Erasure

```text
purge subset reported complete                         0
locked object reported purged                          0
REDACTED handle returns deleted text                    0
restore resurrects purged content/influence             0
provider/index/backup location omitted from closure     0
PurgeLedger non-revealing receipt                       100%
```

## 19.10. Embedding migration

```text
production downtime during shadow build                0
partial generation exposed as complete                  0
mixed raw vector scores across generations              0
switch without T2 result/item-count receipt              0
rollback from active B to retained A                     PASS
```

## 19.11. Federation

```text
Research-initiated client canonical mutation            0
bundle without client fence or ScopeSnapshot              0
reference outside AllowedReferenceManifest                0
unlisted tool/verifier invoked by model/agent               0
stale/revoked manifest entry used                            0
synthesis_is_candidate=false                              0
Search↔Research `eliotr.normalized.v1` schema drift        0
ownership-cutover mode without valid separate receipt     0
concurrent source-lineage mutation by old/new owners       0
completion disposition stronger than internal terminal state  0
transport COMPLETED treated as answered/support                 0
schema mismatch or unknown load-bearing field accepted     0
```

## 19.12. Recovery and observability

```text
AI Search/D1 Search loss causes knowledge loss          0
Queue/DO loss causes durable job loss                    0
offsite BackupEpoch clean-account restore               PASS
required metric missing for accepted generation         0
critical SLO breach invisible in PWA                     0
```

## 19.13. Live gates not yet complete

```text
actual AI Search latency and index throughput
first-month Cloudflare bill
D1 contention under representative swarm
Qwen3 quality on RU/EN/code Golden Corpus
cloud conversion vs local analyzer quality
Normalized Bundle multipart/resume under representative payloads
Google OAuth Production consent/token persistence
dedicated exchange account + interactive Drive append/readback/reconnect
one-minute cursor processing latency
Google API quota/outage behavior
Vertex route/provider billing
full privacy erasure across provider/offsite paths
```

## 19.14. Mechanical specification checks

```text
Google Sheets appendCells fixture parses as JSON             PASS
valid RowData shape                                           PASS
Drive connector D1 SQL executes under SQLite                 PASS
duplicate request idempotency rejected                       PASS
exact Search↔Research normalized-schema block parity          PASS
source-owner/residency/unsaved negative cases present         PASS
Markdown code fences balanced                                PASS
duplicate normative IDs                                      0
duplicate headings                                            0
obsolete connector-zoo runtime dependencies                   0
historical 2026-08-27 account tool inventory                  OBSERVED / NOT CONFORMANCE
actual Drive mutation against production account             NOT EXECUTED
```

These checks prove schema coherence, not the Slice 0 live round trip.

# 20. Normative decisions

Earlier IDs remain traceable. Decisions whose intent was preserved are marked `EXPANDED`; decisions that encoded invalid repository coupling are marked `SUPERSEDED`. New alignment decisions use ERC29 IDs.

| Legacy ID | Disposition | Current contract |
|---|---|---|
| `ERC24-DEC-002` | `SUPERSEDED` | `ERC29-DEC-002`; external product, never an internal Researcher module |
| `ERC24-DEC-010` | `EXPANDED` | `ERC29-DEC-010`; Investigation remains the durable unit |
| `ERC24-DEC-011` | `EXPANDED` | `ERC29-DEC-011`; model capability, execution product, and Evidence Grade are orthogonal |
| `ERC24-DEC-012` | `SUPERSEDED` | `ERC29-DEC-012`; ERC-owned generic federation schema plus optional adapters |
| `ERC25-INV-OWN-004` | `EXPANDED` | `ERC29-INV-OWN-004` and `ERC29-DATA-001/002`; complete residency identity |

| ID | Decision |
|---|---|
| `ERC24-PROD-001` | ERC is Research-grade Library/Lens/Wiki/Research, not Memory OS. |
| `ERC24-PROD-002` | Orientation, Precision and Materialization are independent products. |
| `ERC24-BOUND-001` | Consuming clients own interpretation, task authority, canonical admission, and completion. |
| `ERC24-BOUND-002` | ERC returns evidence or synthesis-as-candidate only. |
| `ERC24-DATA-001` | For ERC-owned/import namespaces, R2 owns retained bytes and D1 owns ERC identity/heads; federated references preserve the external owner. |
| `ERC24-DATA-002` | AI Search and D1 Search are rebuildable projections. |
| `ERC24-DATA-003` | Source is global; projects are many-to-many overlays. |
| `ERC24-DATA-004` | Any ingress passes staging, readback and promotion. |
| `ERC24-DATA-005` | Capacity is planned in projection items. |
| `ERC24-DATA-006` | Project membership has index cost; temporary scopes do not create membership. |
| `ERC24-PARSE-001` | toMarkdown is immediate fast parser behind qualification. |
| `ERC24-PARSE-002` | Heavy analyzers belong to qualified external preprocessing; ERC consumes a versioned Normalized Bundle. |
| `ERC24-PARSE-003` | Readiness is channel-specific. |
| `ERC24-RET-001` | AI Search is primary relevance engine, not exhaustive proof. |
| `ERC24-RET-002` | D1 FTS/R2 scan preserve exact and complete-scope operations. |
| `ERC24-RET-003` | Prose and literal retrieval use separate tokenizer profiles. |
| `ERC24-RET-004` | Query rewriting is off by default; literals are preserved. |
| `ERC24-RET-005` | Every material result resolves to an EvidenceHandle. |
| `ERC24-RET-006` | Rerank reorders candidates and never judges coverage. |
| `ERC24-NAV-001` | SourceCard, DocumentMap and ProjectAtlas are first-class navigation. |
| `ERC24-DIST-001` | Distillation is reversible and usage-triggered. |
| `ERC24-DIST-002` | EvidenceAtoms require deterministic span/modality/number checks. |
| `ERC24-INV-001` | Investigation is the durable unit of controlled research. |
| `ERC24-INV-002` | The `DEEP_RESEARCH` execution product requires a protocol, source portfolio, controlled branches, counter-search, evidence freeze, claim audit, and honest coverage. |
| `ERC24-INV-003` | Every run returns typed disposition and CoverageReceipt. |
| `ERC24-ART-001` | Reports are sectioned, copy-on-write artifacts. |
| `ERC24-WIKI-001` | Wiki is evidence-linked research publication, not Eliot memory. |
| `ERC24-WIKI-002` | Agents propose; policy-authorized committer publishes with CAS. |
| `ERC24-MODEL-001` | Intelligence and depth are independent controls. |
| `ERC24-MODEL-002` | Provider keys live in AI Gateway BYOK/Secrets Store. |
| `ERC24-MODEL-003` | Retrieval and reasoning use separate AI Gateways. |
| `ERC24-COST-001` | Budget exhaustion degrades intelligence, not evidence access. |
| `ERC24-OPS-001` | Queue accelerates delivery; D1 outbox is durable intent. |
| `ERC24-OPS-002` | DO owns live state, not the only research copy. |
| `ERC24-OPS-003` | Long operations use Intent/Attempt/Receipt/Readback/Reconciliation. |
| `ERC24-SEC-001` | ChatGPT uses physically exportable projections; when the qualified Drive action surface is available, its only ERC write capability is Draft Inbox contribution through a typed facade. Otherwise the path is read-only/degraded. |
| `ERC24-SEC-002` | Storage, inference, client disclosure and retention are independent. |
| `ERC24-FED-001` | ERC exposes a generic federation contract; ELIOT compatibility is an optional leaf adapter. |
| `ERC24-FED-002` | ERC never mutates client canonical state or acquires client task/admission authority. |
| `ERC24-INV-FED-003` | Wire disposition is mapped toward the less assertive value. |
| `ERC24-LOCAL-001` | ERC has no mandatory local daemon; external preprocessing uploads through a bounded ingest API. |
| `ERC24-BACKUP-001` | BackupEpoch has an independent offsite copy. |
| `ERC24-API-001` | Clients receive a small semantic API, not Cloudflare primitives. |
| `ERC24-EVAL-001` | Nuance, modality, scope, dissent and exact evidence are hard gates. |
| `ERC25-ERASE-001` | ERC implements self-contained `erc.privacy.erasure.v1`; Steward cannot delete. |
| `ERC25-ERASE-002` | Erasable data is never placed under incompatible Bucket Lock. |
| `ERC25-ERASE-003` | REDACTED is a terminal handle state; restore applies purge ledger first. |
| `ERC25-DATA-001` | Content-addressing is scoped by complete residency/security/lifecycle identity. |
| `ERC25-DELIVERY-001` | Minimal Wiki/Google Drive Exchange/agent loop ships before advanced Investigation/Artifact Compiler. |
| `ERC25-XBERG-001` | Day-0 accepts high-fidelity bundles from qualified external preprocessors without owning analyzer runtime. |
| `ERC25-EVAL-001` | T0–T6 and a versioned real-document Golden Corpus are mandatory. |
| `ERC25-MIG-001` | Embedding model change is a full shadow generation/reindex with no downtime. |
| `ERC25-INJECT-001` | Source taint, effect ceilings and selection lineage are enforced mechanically. |
| `ERC25-RET-001` | AI Search context_expansion is used by query-product policy, not ignored. |
| `ERC25-OBS-001` | Every accepted generation emits required quality, latency, cost and health metrics. |
| `ERC25-COST-001` | Governor percentages name explicit budget pools and every heavy run is quoted. |
| `ERC25-DRAFT-001` | Low-risk fully cited drafts may auto-promote only under explicit policy and receipt. |
| `ERC28-CHATGPT-001` | Day-0 selects the OpenAI-built Google Drive app, but production use requires exact account/action/write-readback qualification; a custom MCP is not a launch dependency. |
| `ERC28-CHATGPT-002` | ChatGPT uses one fixed Exchange Spreadsheet and exact IDs; Drive search is optional UX only. |
| `ERC28-CHATGPT-003` | One contribution is one atomic append-only Sheets batch. |
| `ERC28-CHATGPT-004` | Exact request/result readback, not model prose, is the transport receipt. |
| `ERC28-CHATGPT-005` | Drive proves a Google-account write, not cryptographic ChatGPT authorship. |
| `ERC28-CHATGPT-006` | Interactive ChatGPT Web is supported; Scheduled Tasks are not connector correctness. |
| `ERC28-GOOGLE-001` | ERC OAuth uses narrow `drive.file`, offline access and Production publishing status. |
| `ERC28-GOOGLE-002` | Cursor polling is correctness; Drive push notification is advisory only. |
| `ERC28-GOOGLE-003` | Exchange rows are identified by IDs/hashes, never permanent row numbers. |
| `ERC28-GOOGLE-004` | Drive-specific state ends at transport observation; generic D1 intent/job/receipt is canonical. |
| `ERC28-GOOGLE-005` | Google APIs use a small fetch-based port; no large SDK is bundled into Workers. |
| `ERC28-GOOGLE-006` | ChatGPT connects to a dedicated exchange account, not unrelated personal Drive. |
| `ERC28-GOOGLE-007` | Cloudflare remains sole backend; Google Cloud is API/model acceleration only. |
| `ERC28-GOOGLE-008` | Vertex is a replaceable AI Gateway route, not a knowledge/retrieval owner. |
| `ERC28-GOOGLE-009` | The $1,000 promotion is experiment-only and creates no production dependency. |
| `ERC28-GOOGLE-010` | A native Eliot app may replace, but never run alongside, Drive transport. |
| `ERC26-PARSE-001` | Xberg, OCR, Docling, and code analyzers are outside ERC; `eliotr.normalized.v1` is the cloud ingest boundary. |
| `ERC29-BOUND-001` | ERC is an external research federation, never a client-internal Researcher plane or Memory OS. |
| `ERC29-BOUND-002` | Core ERC builds and deploys without ELIOT crates; optional adapters consume generated schemas only. |
| `ERC29-OWN-001` | Every admitted source namespace has one authoritative mutable source owner and a fenced cutover path. |
| `ERC29-OWN-002` | Every ownership transfer uses exact `source.owner-cutover.v1`; a flag or unilateral receipt cannot activate the new owner. |
| `ERC29-DATA-001` | `ObjectResidencyKey` binds scope, access, confidentiality, encryption-key, retention, erasure, and content digest. |
| `ERC29-DATA-002` | Equal bytes never authorize cross-domain co-residency, ciphertext/key reuse, or coupled lifecycle. |
| `ERC29-INGEST-001` | Unsaved or ephemeral client content enters ERC only as an explicit immutable snapshot with admission and policy receipts. |
| `ERC29-RESEARCH-001` | Evidence Grade, lane, protocol, evidence freeze, claim audit, coverage denominator, and research debts remain explicit and orthogonal. |
| `ERC29-FED-001` | Federation results are evidence/synthesis candidates; no reverse authority or direct database channel exists. |
| `ERC29-FED-002` | Federation transport state and research completion disposition are orthogonal; transport completion never proves an answered inquiry. |

# 21. Platform fact snapshot verified against official documentation (2026-08-28)

## AI Search

```text
Workers Paid instances/account        5,000
namespaces/account                     100
files/instance                         1M vector-only; 500K hybrid
max item size                          4 MB
max results/request                    50
custom metadata fields                5/instance
instances/cross-instance query         10
context_expansion                      0–3 surrounding chunks
queries/month on Paid                  unlimited
open-beta orchestration                free; models billed separately
```

One instance supports one keyword tokenizer:

```text
porter  natural language
trigram code/identifiers/partial strings
```

Embedding model is chosen at instance creation and cannot be changed afterward. Migration means creating a new instance and reindexing all items.

## Supported embedding baseline

```text
Qwen3 Embedding 0.6B
model ID          @cf/qwen/qwen3-embedding-0.6b
direct model context             8192 tokens
current AI Search input envelope 4096 tokens
effective cap/output shape       capability-probed per instance generation
price             $0.012 / M input tokens
neurons           1075 / M input tokens
```

BGE reranker:

```text
model ID          @cf/baai/bge-reranker-base
price             $0.0031 / M input tokens
input/window      capability-probed per generation
```

## R2

```text
free storage       10 GB-month
free Class A       1M/month
free Class B       10M/month
egress             free
```

R2 is strongly consistent. Bucket Locks prevent deletion and overwrite for their covered prefix/period and take precedence over lifecycle deletion. Therefore they cannot be applied to erasable domains whose deletion deadline may precede lock expiry.

## Workers Paid

```text
minimum            $5/month
requests included  10M/month
CPU included       30M CPU-ms/month
```

## D1 Paid

```text
database max       10 GB
account max         1 TB
Time Travel         30 days
rows read           25B/month included
rows written        50M/month included
storage             5 GB included
```

## Workflows Paid

```text
steps included      500,000/month
additional          $0.80 / 100,000
storage included    1 GB-month
```

Stage count is optimized for retry isolation and research semantics, not artificially minimized.

## Observability

Workers provides built-in logs, traces and runtime metrics. Analytics Engine supports non-blocking custom data points and SQL queries; pricing is currently not enforced, with published future allowances of 10M writes and 1M read queries on Paid.

## ChatGPT Web and Google Drive actions

Official product state checked on 2026-08-28:

```text
Google Drive app unifies Drive/Docs/Sheets/Slides actions
Google Drive live access and administrator-managed sync are distinct; availability depends on plan/workspace and personal sync is not assumed
actual actions depend on plan, workspace/admin settings, Google scopes, account, and session
custom MCP on Pro remains read/fetch only
Deep Research custom apps remain read/fetch only
```

The 2026-08-27 account tool inventory is retained only as historical operational evidence, not conformance. Because connected-app availability and action dispatch can vary, ERC uses exact IDs, append-only transactions, cursor replay, immutable import, and exact readback; launch still requires the disposable live gate.

## Google Workspace API facts used by ERC

```text
drive.file supports per-file create/read/write and changes.list
changes page tokens do not expire
changes.watch max lifetime one week and requires renewal
push notifications contain no changed content
Sheets batchUpdate is atomic
Sheets recommends payloads around/below 2 MB
Sheets quotas: 300 requests/min/project, 60/min/user/project
Docs batchUpdate supports requiredRevisionId
Google editor revision lists may be incomplete/merged
OAuth Testing refresh tokens expire after seven days
```

## Google Cloud boundary

```text
permanent:
  Drive/Docs/Sheets APIs
  optional Vertex provider
  optional billing export

not production dependencies:
  Cloud Run
  Firestore
  Pub/Sub
  Cloud Storage
  Vertex/Agent Search index
```

# 22. Primary source registry

## Internal project sources

- `ELIOT_CHATGPT_WEB_PLUGIN_AUDIT_2026-08-14_V2.md` — historical 1,624-app/416-description screen, availability taxonomy, candidate shortlist and manual pilot protocol; research proposal, not automatic architecture authority.
- ELIOT English final Architecture/Implementation pair dated 2026-08-28 — compatibility evidence for the optional adapter only; hashes are recorded in frontmatter.
- ERC-local generated schemas — `erc.privacy.erasure.v1`, generic federation DTOs, `CompletionDisposition`, source/residency contracts.
- Optional ELIOT adapter fixtures — lossless mapping to the external research-federation boundary; not a core runtime dependency.
- Current GitHub v24.1 predecessor, blob `da1eb64a03c73f0bd631a959a5113ab3be00c5c6`.

## Cloudflare primary documentation

- AI Search limits/pricing  
  https://developers.cloudflare.com/ai-search/platform/limits-pricing/
- AI Search Workers binding / `context_expansion`  
  https://developers.cloudflare.com/ai-search/api/search/workers-binding/
- AI Search keyword tokenizers  
  https://developers.cloudflare.com/ai-search/configuration/indexing/keyword-search/
- AI Search models, current supported-input envelope, and immutable embedding selection  
  https://developers.cloudflare.com/ai-search/configuration/models/  
  https://developers.cloudflare.com/ai-search/configuration/indexing/vector-search/  
  https://developers.cloudflare.com/changelog/post/2026-04-09-new-workers-ai-models/
- AI Search Items API  
  https://developers.cloudflare.com/ai-search/api/items/workers-binding/
- AI Search website source  
  https://developers.cloudflare.com/ai-search/configuration/data-source/website/
- AI Search gateway warnings  
  https://developers.cloudflare.com/ai-search/configuration/models/ai-gateway/
- Workers AI pricing and Qwen3 Embedding  
  https://developers.cloudflare.com/workers-ai/platform/pricing/  
  https://developers.cloudflare.com/workers-ai/models/qwen3-embedding-0.6b/
- R2 bucket locks, lifecycle and delete  
  https://developers.cloudflare.com/r2/buckets/bucket-locks/  
  https://developers.cloudflare.com/r2/buckets/object-lifecycles/  
  https://developers.cloudflare.com/r2/objects/delete-objects/
- Workers observability and Analytics Engine  
  https://developers.cloudflare.com/workers/observability/  
  https://developers.cloudflare.com/workers/observability/metrics-and-analytics/  
  https://developers.cloudflare.com/analytics/analytics-engine/pricing/
- D1 pricing/limits  
  https://developers.cloudflare.com/d1/platform/pricing/  
  https://developers.cloudflare.com/d1/platform/limits/
- Workers and Workflows pricing  
  https://developers.cloudflare.com/workers/platform/pricing/  
  https://developers.cloudflare.com/workflows/reference/pricing/
- AI Gateway BYOK, Dynamic Routing and Spend Limits  
  https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/  
  https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/  
  https://developers.cloudflare.com/ai-gateway/features/spend-limits/
- Service Bindings and Durable Object WebSockets  
  https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/  
  https://developers.cloudflare.com/durable-objects/best-practices/websockets/

## OpenAI / ChatGPT Google Drive app

- Google Drive app and setup — current live-access, action, and administrator-managed sync boundary  
  https://help.openai.com/en/articles/10929079-google-drive-app-and-setup-in-chatgpt
- Google Drive app with sync — retained plan-specific/self-service reference; current behavior must be reconciled with the general setup page  
  https://help.openai.com/en/articles/10948259-google-drive-synced-connectors-self-service-setup/
- Google app data controls/action scopes  
  https://help.openai.com/en/articles/10408842
- ChatGPT release notes — Drive unification/actions  
  https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- Custom MCP Developer Mode plan boundary  
  https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-apps-in-chatgpt-beta

## Google Workspace / Cloud primary documentation

- Drive API scopes / `drive.file`  
  https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- OAuth token lifetime / Testing seven-day rule  
  https://developers.google.com/identity/protocols/oauth2
- OAuth personal-use/verification exceptions  
  https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
- Drive changes cursor / push  
  https://developers.google.com/workspace/drive/api/guides/manage-changes  
  https://developers.google.com/workspace/drive/api/guides/push
- Drive revisions  
  https://developers.google.com/workspace/drive/api/guides/manage-revisions  
  https://developers.google.com/workspace/drive/api/guides/change-overview
- Sheets atomic batch update and quotas  
  https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate  
  https://developers.google.com/workspace/sheets/api/limits
- Docs batchUpdate/writeControl  
  https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate
- Cloudflare AI Gateway Vertex provider  
  https://developers.cloudflare.com/ai-gateway/usage/providers/vertex/

## Operational user-report evidence — non-normative

- connected app but no callable tools/files  
  https://community.openai.com/t/googledrive-connector-is-connected-but-chatgpt-does-not-see-anyfiles/1375549
- custom apps/connectors disappearing from settings/chat  
  https://community.openai.com/t/all-custom-connectors-disappeared-from-the-apps-connectors-menu/1365178
- Google Drive linked but no files/tools visible  
  https://community.openai.com/t/googledrive-connector-is-connected-but-chatgpt-does-not-see-anyfiles/1375549
- custom action approval/dispatch regression; authorized Drive/Sheets action used as workaround  
  https://community.openai.com/t/custom-gpt-actions-not-working-anymore/1389203
- connected apps may be unavailable to Scheduled Tasks  
  https://community.openai.com/t/why-cant-scheduled-tasks-in-chatgpt-use-my-connectors-or-apps/1390430

## OpenAI primary documentation

- ChatGPT Developer Mode and MCP plan constraints  
  https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-apps-in-chatgpt-beta


# 23. External-repository alignment receipt

## 23.1. Legacy named-contract disposition

| Legacy name | Disposition | Current owner/contract |
|---|---|---|
| `ResearchProtocol` | renamed and expanded | `InquiryProtocolProfile` |
| fixed Rust `ResearchExchange` dependency | superseded | ERC-owned `FederationRequest`, `FederationEvidenceBundle`, and `FederationExportBundle`; optional adapters map them |
| `GovernedExchange` backend coupling | generalized | generic federation backend plus client fence/`ScopeSnapshot` |
| `ContributionEnvelope` as a cross-system write object | decomposed | one atomic Sheets batch, ERC `ContributionIntent`, immutable readback, and receipts |
| `DeepResearch` as a separate owner | rejected | `DEEP_RESEARCH` is an execution product governed by Evidence Grade and inquiry protocol |

## 23.2. Alignment status

```yaml
alignment_date: 2026-08-28
standalone_core: true
internal_researcher_plane: false
optional_eliot_adapter: true
source_namespace_single_owner: enforced
complete_object_residency_key: enforced
cross_domain_dedup_or_key_reuse: prohibited
unsaved_implicit_ingest: prohibited
evidence_grade_and_lane_discipline: explicit
evidence_freeze_and_claim_audit: explicit
research_debts_and_honest_closure: explicit
normalized_bundle_wire_schema: exact_with_search
ownership_cutover_requires_separate_receipt: true
platform_facts_checked: 2026-08-28
historical_account_observation_is_conformance: false
```

This receipt states documentary alignment only. It does not prove Cloudflare deployment, Google Drive round-trip, runtime security, performance, migration, or product acceptance.
