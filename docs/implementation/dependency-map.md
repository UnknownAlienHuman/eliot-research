# Dependency and authority map

## Compile-time direction

```text
contracts ───────────────────────────────────────────────────────────┐
   │                                                                 │
   ▼                                                                 │
domain ──► policy ──► retrieval ──► research                        │
   │          │           │            │                              │
   └──────────┴───────────┴────────────┼── ports ◄── platform-cloudflare
                                       │
interfaces ◄───────────────────────────┤
google-drive-exchange ◄── contracts/domain/policy                    │
                                       ▼
                              apps/eliotr-core composition root

apps/eliotr-pwa ──► generated/contract DTOs + HTTPS owner API only
```

`platform-cloudflare` may implement application ports; domain packages never import it. `eliotr-core`
is the only place that binds concrete adapters to services.

## State authority

| State family | Authoritative owner | Rebuildable projection |
|---|---|---|
| ERC source identity/revisions | D1 Core | no |
| retained originals/normalized artifacts | R2 Evidence + D1 manifest | no, except governed erasure |
| projects/memberships/scope snapshots | D1 Core | no |
| evidence handle registry | D1 Core + immutable R2 manifest | no; tombstone remains |
| investigations/jobs/receipts/outbox | D1 Core + R2 checkpoints | no |
| Wiki/artifact heads | D1 Core | no |
| Wiki/artifact immutable bodies | R2 Work | no |
| exact/lexical safety projection | D1 Search | yes |
| hybrid/literal relevance projection | AI Search | yes |
| queued delivery | Queue/DLQ | yes; D1 outbox is intent |
| connected presentation state | ResearchSession DO | yes |
| Drive rows/docs | external transport copy | yes after R2 freeze + D1 admission |

## One-writer rules

- One mutable owner per source namespace; generation changes fence stale writers.
- D1 expected-revision CAS owns mutable heads.
- R2 canonical keys are immutable within a complete residency identity.
- Queue consumers never invent work; they deliver a persisted intent.
- A Workflow owns one durable operation, not a global scheduler.
- A DO owns one principal + investigation/chat live session, not durable research truth.
