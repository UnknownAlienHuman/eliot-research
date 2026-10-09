# Owner feature parity inventory — legacy PWA to React workspace

**Date:** 2026-10-08
**Baseline:** `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`
**Review pass:** 3 — progressive Research, no-registration rollback and first-paint browser privacy
**Owners:** ER-47 presentation, ER-48 browser client, existing backend packets for authority
**Status:** static inventory from current shell/composition; runtime parity tests are PENDING

A prettier shell is not an acceptable migration if working capabilities disappear or technical controls are
moved into the primary workflow without product rationale. Conversely, a legacy panel does not deserve a
React clone merely because its mount point exists. This inventory assigns each current capability one of:

```text
PRIMARY       visible product workflow
CONTEXTUAL    appears only when relevant
ADVANCED      explicit disclosure/settings/diagnostic route
LEGACY-ONLY   retained until cutover but not copied as a product pattern
DEFERRED      no truthful supported operation yet
```

Every migrated capability names its destination, owner-client family, server authority, slice and negative
acceptance. Final parity is behavioral, not selector/markup parity.

## 1. Top-level destinations

| Destination | Product purpose | Current legacy source | React result |
|---|---|---|---|
| Sources | projects, source selection/import/reading/versions/readiness | `sources-view`, Library, Lens, import/project/erasure details | route-first source workspace with contextual reader and bounded advanced actions |
| Research | ask, scope, progress, report, citations, explicit search/scans | `research-view`, research run, retrieval, exhaustive workflow, changes | question-first workflow; search/scans become advanced tools, evidence contextual |
| Studio | saved reports, Wiki drafts/pages, implemented artifact operations | current `wiki-view` plus report history/actions inside Research | unified saved-work destination without fake generators |
| Connections | server/session/grants/model/transport/client diagnostics | `connections-card` and health strip | independent facts and corrective actions; diagnostics progressively disclosed |

`Context/Evidence` is a pane/drawer, not a fifth destination. Corpus Lens is a Sources capability, not an
additional product name.

## 2. Global shell and session

| Capability | Current implementation | Disposition | Target owner | Mandatory acceptance |
|---|---|---|---|---|
| Brand/home | topbar link | PRIMARY | ER-47 | route does not clear current project/scope unexpectedly |
| Destination navigation | hash/buttons with manual view switching | PRIMARY | ER-47 | URL, Back/Forward, reload and narrow-screen behavior |
| Theme | localStorage + prepaint script | PRIMARY preference | ER-47/UI | system/light/dark, no content persistence, no flash, safe CSP |
| Health summary | global strip + Connections detail | CONTEXTUAL global; details in Connections | ER-47/48 | ready/blocked/unreachable distinct; no duplicate warnings |
| Owner session | lifecycle + owner-session panel/global events | CONNECTIONS + central session controller | ER-48/47 | one authority epoch transition; late data removed; no global event in React |
| Offline/online | window events across panels | CONTEXTUAL app state | ER-47 | safe reads disabled/refreshed by policy; no automatic mutation retry |
| Deployment generation | app dataset/events | hidden client/session axis + stale banner | ER-48/47 | generation mismatch clears protected data and blocks late response |
| Service worker | root `/sw.js`, unconditional registration, cached `/` | LEGACY-ONLY then exact retirement; post-retirement rollback variant has no registration | U6/ADR-0017 | tombstone never calls `clients.claim()`; any controlled inbox stays fail-closed until exact unregister + controller-null reload; no accepted app re-registers `/sw.js` |
| Page lifecycle / bfcache | implicit browser behavior plus cleanup events | central masked lifecycle controller | ER-47/U6 | synchronous root guard hides protected tree before first restored paint; fresh verification precedes unmask |
| Appearance/menu | details-based menu | PRIMARY/ADVANCED | ER-47/UI | keyboard/focus/route behavior, no generic dumping ground |

## 3. Sources capabilities

### 3.1 Library and project scope

| Capability | Current module/host | Disposition | Slice | Negative acceptance |
|---|---|---|---|---|
| Authorized source page | Library panel | PRIMARY | U3 + ER-48 C2 | stale cursor/generation, denied source, late page response |
| Project filter | Library project filters | PRIMARY | U3 | project switch cannot preserve foreign source selection/results |
| Source selection for next work | Library → Lens/Retrieval callbacks | PRIMARY | U3 | selection differs from historical report scope; reload/currentness |
| Current source readiness | Library readiness | CONTEXTUAL | U3 | recorded state is not active readiness; head/generation change |
| Source revision history | revisions panel | ADVANCED contextual | U3 | immutable history, bounded pagination, foreign/revoked revision |
| Project create/edit/list | project panel | PRIMARY/ADVANCED | U3 | CAS conflict, uncertain mutation, shared source membership |
| Project/source counts | current bounded pages | contextual metadata | U3 | page count is not completeness |

React should not show source IDs/generations in every row. They remain under technical details.

### 3.2 Ingest and source ownership

| Capability | Current module/host | Disposition | Slice | Negative acceptance |
|---|---|---|---|---|
| Source namespace selection/bootstrap | source namespace panel | ADVANCED onboarding/settings; contextual when required | U3 | owner-session/generation mismatch; no implicit namespace |
| Raw file capture/upload | raw file panel | PRIMARY Add source flow | U3 | byte/type/size bounds, lost ACK, no filename identity |
| Normalized bundle/folder import | bundle import panel | ADVANCED Add source flow | U3 | exact manifest, partial upload, continuation/recovery, no duplicate reservation |
| Known operation recovery | import recovery | CONTEXTUAL error recovery | U3 | same operation/files/body; no fresh identity on uncertainty |
| Explicit Library handoff | upload result action | CONTEXTUAL success | U3 | receipt identity, no auto-select, hidden/paginated source guidance |
| Add source progress | multiple current technical stages | PRIMARY compact stage model | U3 | captured/admitted/index-ready/evidence-ready not collapsed |
| New source version | raw-file version view | CONTEXTUAL document action | U3 | new revision vs new source, expected head/currentness |

The Add source experience may unify raw and normalized inputs visually, but server operations and receipts stay
distinct.

### 3.3 Reading, navigation and erasure

| Capability | Current module/host | Disposition | Slice | Negative acceptance |
|---|---|---|---|---|
| Corpus Lens/orientation | orientation panel / `corpus-lens` | PRIMARY Sources capability | U3 | sampled/omitted sources, no fake completeness |
| Open exact document | document reader | PRIMARY | U3 | exact revision/bytes, unauthorized current head substitution |
| Structural expansion | navigation API | CONTEXTUAL reader/Lens | U3 | missing coordinate map, unauthorized neighbor, bounded traversal |
| Safe Markdown reading | reading worker/renderer | PRIMARY content renderer | ER-48 + UI | raw HTML/script/unsafe URL/AST overflow/timeouts |
| Delete/erase selected source | erasure panel | ADVANCED destructive action | U3 | confirmation, dependency/hold/partial closure, foreign target, no optimistic purge |
| Reading Back/focus | workspace chrome | PRIMARY interaction requirement | U3 | focus restoration and URL/history, no DOM reparenting |

## 4. Research capabilities

### 4.1 Ask/run/history

| Capability | Current module/host | Disposition | Slice | Negative acceptance |
|---|---|---|---|---|
| Research question | research run panel | PRIMARY | U4 | exact product/scope identity; blocked config creates zero run |
| Scope/project/source context | implicit selected callbacks + run contract | PRIMARY compact summary/control | U4 | historical artifact scope does not mutate with current checkboxes |
| Research configuration readiness | Connections panel + run availability | contextual precondition near composer; full detail Connections | U4/U5 | config present vs model available vs run readiness distinct |
| Start run | run panel | PRIMARY | U4 | one operation/idempotency identity; no automatic duplicate submit |
| Status/progress transport | polling/history/readback | PRIMARY transport-neutral progress reader; polling baseline, versioned events optional only when implemented | U4 + ER-48 C3-R | stopping a poll/stream is not cancellation; reconnect cannot create a run; duplicate/reordered/gapped/late events cannot invent completion |
| Recent/saved runs | history/recovery | Studio or Research history | U4/U5 | readback only; opening history never resubmits |
| Stop research | run controls | CONTEXTUAL running action | U4 | canonical server cancellation, uncertain outcome/readback |
| Recover research | run controls | ADVANCED/CONTEXTUAL | U4 | same run identity; no replacement execution |
| Public progress | technical statuses | PRIMARY public timeline of stages, allowed tool events, receipts and limitations | U4 | no hidden reasoning/raw prompts/provider payloads; WAITING/UNKNOWN/DEGRADED/FAILED distinct |

Progressive UI does not require a new transport. Polling remains valid while it is the implemented contract.
Any future SSE/stream/Agents channel accelerates one durable run and reconciles through authoritative status/
history/readback after gaps or reconnect; it is not a second completion or mutation authority.

### 4.2 Search and exhaustive scan

| Capability | Current module/host | Disposition | Slice | Negative acceptance |
|---|---|---|---|---|
| Direct retrieval/search | retrieval panel | ADVANCED research tool or Sources precision search | U4 | sampled no-hit not absence; exact evidence after locators |
| Coverage/evidence counters | research context | CONTEXTUAL | U4 | selected/resolved/complete denominators distinct |
| Exhaustive workflow | exhaustive workflow panel | ADVANCED explicit full-scope action | U4 | complete receipt only; bounded poll/cancel; no top-k masquerade |
| Research changes/freshness | changes panel | CONTEXTUAL stale/dependency notification | U4/U5 | unrelated import does not invalidate report; purge/revoke differs from update |

Do not show “Search and full-source scans” as permanent technical machinery beside every simple question.
Surface them through an explicit advanced research/tool path when relevant.

### 4.3 Report, citations and exact evidence

| Capability | Current module/host | Disposition | Slice | Negative acceptance |
|---|---|---|---|---|
| Report metadata/sections | report renderer | PRIMARY | U4 | lazy bounded reads; section identity/currentness |
| Section open/read | section reader | PRIMARY progressive | U4 | 40 sections; one in-flight per tuple; late-response protection |
| Citation/source list | report actions | PRIMARY claim controls | U4 | citation bound to exact claim/section/artifact generation |
| Reauthorized evidence | reauthorization APIs + evidence rail | CONTEXTUAL Context pane | U4 | revoked/stale/foreign handle; original vs reauthorized identity |
| Exact excerpt/context | evidence rail/dialog | PRIMARY contextual | U4 | exact bytes/hash/coordinates; missing native map remains honest |
| Full Markdown export | download path | CONTEXTUAL report action | U4 | verify every manifest section/citation; viewport is not completeness |
| Accept/publish artifact | artifact product controls | ADVANCED authoritative action | U4/U5 | publication/audit/evidence availability distinct; exact readback |
| Revise/regenerate section | current product action | ADVANCED with honest label | U4/U5 | regenerate is not user edit; same mutation identity on retry |

Evidence inspection changes Context content, never the ownership/location of the source list.

## 5. Studio and Wiki

| Capability | Current module/host | Disposition | Slice | Negative acceptance |
|---|---|---|---|---|
| Wiki list/read | wiki panel | PRIMARY Studio | U5 | bounded page/generation; authorization/currentness |
| Wiki draft/edit | wiki edit form | PRIMARY only for implemented versioned command | U5 | expected head/COW/readback; no old audit inheritance |
| Create Wiki proposal from report | proposal API/action | CONTEXTUAL report/Studio action | U5 | source artifact/run identity; uncertain mutation reconciliation |
| Saved research reports | currently history inside Research | PRIMARY Studio library | U5 | server history/readback; no browser persistence |
| Artifact product actions | controls | CONTEXTUAL/ADVANCED | U5 | show only actual implemented operation and state |
| Briefing/Study Guide/FAQ/Audio generators | not implemented as truthful current operations | DEFERRED, not disabled cards | future packet | no fake availability |
| Rich editor | no complete free-form report command | DEFERRED | future command/packet | do not add Tiptap before backend semantics |

Studio is not a marketing grid of generators. Empty product families are absent, not permanently disabled.

## 6. Connections and administration

### 6.1 Server and owner

| Capability | Current module/host | Disposition | Slice | Negative acceptance |
|---|---|---|---|---|
| Worker/API readiness | health strip + server card | PRIMARY Connections + compact global degradation | U5 | HTTP response vs ready schema vs unavailable |
| Deployment/core/search generation | diagnostics | ADVANCED disclosure | U5 | unknown/mismatch not success |
| Owner session verification | owner-session panel/lifecycle | PRIMARY Connections/session | ER-48/U5 | expiry/resume races; one epoch transition |
| Access/privacy explanation | disclosure | ADVANCED | U5 | copy matches actual persistence/disclosure behavior |

### 6.2 Research model/provider

| Capability | Current module/host | Disposition | Slice | Negative acceptance |
|---|---|---|---|---|
| Research configuration | configuration panel | PRIMARY Connections | U5 | present/blocked/degraded axes, strict readback |
| Provider key/configuration | provider key panel | ADVANCED sensitive setup | U5 | never display key; uncertain mutation/readback; server-owned storage |
| Model use/qualification | model-use panel | ADVANCED diagnostic | U5 | configured is not qualified; no unnecessary paid check |
| Run availability summary | current callbacks to run | contextual composer precondition | U4/U5 | missing model does not imply server offline |

### 6.3 Google/workspace and agents

| Capability | Current module/host | Disposition | Slice | Negative acceptance |
|---|---|---|---|---|
| Selected Google transport | health + Google card | PRIMARY Connections fact | U5 | drive-exchange/gemini-mcp/disabled/unknown distinct |
| Drive OAuth begin/status | Google OAuth panel only for selected profile | ADVANCED setup | U5 | unselected flow absent; no token in URL/storage/log |
| Project/client grants | client grant panel | ADVANCED Agent access | U5 | exact grantee/revision/scope; revoke confirmation; uncertain mutation |
| MCP client challenge/observation | MCP diagnostic panel | ADVANCED diagnostic | U5 | historical observed call not current presence/model/execution |
| Independent client command | grant diagnostic instructions | ADVANCED | U5 | service credentials stay outside browser; result not server authority |
| Active agent/run | no generic endpoint proving presence | UNKNOWN unless exact observation exists | U5 | no fabricated green Connected badge |

Connections does not become a general Cloudflare dashboard. It shows facts required to make the owner product
usable and routes deep platform operations to existing runbooks/tools.

## 7. Features outside the visible shell

The migration must preserve or deliberately relocate:

- historical service-worker/manifest behavior: retired through ADR-0017 and never restored by post-cutover
  rollback;
- retirement-safe legacy rollback: accepted legacy behavior with root SW registration removed/disabled;
- standalone `/agent-inbox/`: separately built/routed, exact browser-local retirement helper, not a React
  destination and unusable while a controller remains;
- synchronous non-private root privacy mask for pagehide/bfcache first-paint safety;
- keyboard/focus/Back behavior in browser fixtures;
- private-state clearing on offline/auth/generation/page disposal;
- health/currentness event semantics, replaced by explicit session/query controllers;
- build/deployment diagnostic metadata, not primary UI copy;
- raw accessibility labels/relationships represented behaviorally in React tests.

## 8. Visibility rules

A capability is visible as an available action only when:

1. the server exposes an implemented versioned operation;
2. the current owner/session/project has authority;
3. required configuration/readiness is known;
4. the client can represent/reconcile the result safely;
5. the UI has complete loading/error/unknown/negative states;
6. the action has the named browser/authority tests.

A declared architecture feature, enum value, disabled legacy button or draft PR is not enough.

## 9. Migration evidence per capability

Each row receives a migration record:

```text
legacy module/host
server endpoint/contract and owner
ER-48 client method/decoder
ER-47 route/component/pattern
accepted behavior tests retained
new component/flow/visual tests
security/currentness/replay negatives
status: legacy-only / fixture / client-connected / staging-qualified / accepted / removed
```

No row is closed by component existence alone. No legacy file is deleted until all exported/consumed behavior
has a disposition.

## 10. Canonical parity journeys

### Sources journey

```text
owner/session ready
→ choose/create project
→ add raw or normalized source
→ reconcile uncertain upload if needed
→ open Library row
→ inspect readiness/revision
→ read exact document
→ use Lens/navigation
→ ask Research with explicit scope
```

### Research journey

```text
question + product/scope
→ accepted run identity
→ progressive public stages/tool events via polling or an accepted versioned channel
→ authoritative readback after gap/reconnect
→ report metadata
→ lazy section read
→ citation/claim selection
→ exact reauthorized evidence
→ complete export or Studio handoff
```

### Connections recovery journey

```text
workspace blocked/degraded
→ identify exact independent failed fact
→ execute safe corrective action
→ authoritative readback
→ protected views refresh under new epoch/generation
→ no stale private result returns
```

### Destructive/currentness journey

```text
open historical report/source
→ source update/revoke/purge/owner generation change
→ preserve lawful history but clear unavailable protected bytes
→ show exact freshness/authorization state
→ no automatic rerun, republish or false acceptance
```

## 11. U3/U4/U5 exit condition

A slice exits only when every applicable capability row is either:

- migrated and accepted;
- intentionally advanced/relocated with equivalent discoverability;
- explicitly deferred because no truthful backend operation exists;
- obsolete presentation-only behavior with a documented replacement/removal.

“Not copied” without a disposition is a migration defect.
