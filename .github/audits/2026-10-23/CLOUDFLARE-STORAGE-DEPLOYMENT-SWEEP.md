# Cloudflare storage, secrets and deployment sweep

**Reviewed:** 2026-10-23. **Branch baseline:**
[`b6c8f650`](https://github.com/UnknownAlienHuman/eliot-research/tree/b6c8f65044476994681dd77065be8fc802a84a5f).

This continuation checks Cloudflare Secrets Store, product jurisdictions and Worker/Durable Object deployment semantics
against the selected Eliot shape. It records permissions and cutover rules that are easy to miss when reading only the
product overview. It is source review, not an account configuration, deploy, migration or residency certification.

## Findings

| # | Evidence and interpretation | Owning correction |
|---|---|---|
| 90 | Secrets Store remains open beta, account-level and globally stored across Cloudflare data centers. There is currently one store and up to 100 secrets per account. Secret scopes (`workers`, `ai-gateway`) and roles constrain use, but API tokens expose only Read or Edit. Critically, CI deploying a Worker with a Secrets Store binding needs **Account Secrets Store Edit**, which can create/edit/duplicate/delete account secrets as well as bind them. | Ordinary Worker CI must not receive Secrets Store Edit. Eliot uses AI Gateway BYOK associations provisioned through an owner/Secrets Store Deployer setup path; routine Worker deploys reference the Gateway, not an account-secret binding. Any Worker-only management secret is provisioned separately and is not mutated by build CI. D1 stores only secret/connection references and status. |
| 91 | D1, R2 and Durable Objects support jurisdiction constraints (`eu`, `us`, `fedramp`) that are selected at resource/namespace creation. D1/R2 jurisdiction cannot be changed in place; location hints are best effort, not residency guarantees. Workers can call jurisdictional storage from anywhere. Durable Object IDs may be logged outside the jurisdiction for billing/debugging. Secrets Store has no reviewed jurisdiction mode and is stored globally. AI Search, Gateway/model providers, logs, browser/conversion services and external tools have separate location/retention behavior. R2 Data Access Logs are available only for non-jurisdictional buckets. | Residency is a **whole-product profile**, not a D1/R2 checkbox. Stage 0/1 records the intended jurisdiction before creating production and preview D1/R2/DO resources and uses matching binding endpoints. Changing jurisdiction requires new resources plus export/import/verification/cutover. Do not claim EU/US/FedRAMP residency until every enabled search/model/log/browser/secret/provider path is covered. Do not promise R2 access logs for jurisdictional buckets. |
| 92 | Gradual Worker deployments can serve different requests and services with different versions. Each Durable Object is pinned to one Worker version for a deployment, but different objects can run old and new versions simultaneously. The observed traffic split may lag and differ from the configured split. | Until compatibility tests exist, Eliot uses an explicit full deployment for changes that affect chat/tool DO protocol or persisted state. A future gradual rollout requires backward/forward-compatible HTTP/RPC/state readers, version-attributed telemetry and tests where old/new Worker and DO versions call one another. A percentage is not proof that every object migrated. |
| 93 | Durable Object lifecycle changes in declarative `exports` are atomic: they cannot be uploaded as a normal version, cannot use gradual deployment, and rollback cannot cross the lifecycle change. `wrangler versions upload` fails; `wrangler deploy` applies the lifecycle operation. Cloudflare recommends deploying lifecycle changes independently. Storage backend cannot be changed in place. | Stage 0 creates the new classes in one explicit deployment. Every later rename/delete/transfer follows the documented multi-deploy tombstone pattern: first remove callers, verify no bindings depend on the old class, then perform one owner-approved atomic lifecycle deploy. Never combine lifecycle change, application behavior change and live-data cutover. Portable export remains required before destructive lifecycle changes. |
| 94 | A Worker bundle commonly contains both the caller and DO class, so rollout can reset each object once when its assigned version changes. New DO namespaces must use SQLite; PITR restores one object's storage within its native window but does not restore D1/R2 or reverse a class lifecycle operation. | Chat/tool DO code must tolerate eviction/reset and reconnect without buying new work. Product inventory and large bodies stay in D1/R2; DO PITR is emergency same-object recovery, not deployment rollback or workspace backup. Stage checks distinguish a reset/reconnect from Stop and from a new inference attempt. |

## Secrets and deployment decision

| Responsibility | Selected owner |
|---|---|
| Create/rotate/delete provider secrets | Human owner or dedicated Secrets Store administrator; never ordinary CI |
| Associate a key with AI Gateway | Explicit setup operation using Secrets Store Deployer/owner authority |
| Deploy routine Worker code | Worker-scoped Editor token with no secret-store or delete authority |
| Create production/preview storage jurisdiction | Explicit setup manifest before resource creation |
| Change jurisdiction | New resource + export/import/verification/cutover; no in-place mutation |
| Deploy ordinary code | Full deploy initially; gradual only after mixed-version contract tests exist |
| Create/rename/delete/transfer DO class | Separate owner-approved atomic `wrangler deploy`, with pre-removal of callers and portable export |
| Recover one DO's SQLite state | Native PITR when appropriate; never presented as whole-product rollback |

## Data-location matrix

The setup manifest records, at minimum:

```text
D1 jurisdiction
R2 jurisdiction and endpoint
Durable Object jurisdiction
AI Search availability/location claim: verified or none
Workers AI / AI Gateway / vendor route retention and location
Secrets Store global/beta status
Logs/traces/issues destination and retention
Browser Run / conversion / container location claim
Web Search provider and data handling
external MCP/tool provider policy
checked_at / evidence
```

A missing row is displayed as **not guaranteed**, not inferred from the account or another product. Preview resources use
the same declared profile or are explicitly labelled non-production and forbidden from receiving production data.

## Verification boundary

The Secrets Store access-control/integration docs, D1/R2/DO data-location docs, gradual-deployment docs and declarative
DO lifecycle constraints were inspected. No secret was created/rotated, no role/token was provisioned, no jurisdictional
resource was created, no mixed-version deployment was run and no PITR/rollback was exercised. These remain stage-owned
runtime checks.
