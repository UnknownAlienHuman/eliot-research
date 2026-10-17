# ADR-0018: Owner-single, function-first deployment profile

- Status: accepted for this service on 2026-10-17. Runtime cutover is in progress; acceptance targets below remain unverified until measured.
- Date: 2026-10-17.
- Scope: access, read paths, interactive answers, model qualification and deployment behaviour for this
  service's single owner and the owner's own agents.
- Supersedes for this profile: the per-read enforcement order (ELIOT_RESEARCH §13.2) on owner read paths,
  E3 machinery on ordinary questions (§7.7–7.9), per-run model qualification pins (ADR-0010 execution checks),
  and generation-loss data clearing in the owner web (AGENTS "Owner web migration").

## Context

The owner's words on 2026-10-17:

> «Делайте гибко, функционально!!!!»
>
> «Зато вы додумались делать безопасно!!! Доступов нихуя нет, постоянно сервис нахуй падает,
> надо вручную перевыпускать токены, все работает как кусок говна. Но безопасно!!!»
>
> «Какие нахуй проверки прав. ВЫ ЗАЕБАЛИ СО СВОЕЙ БЕЗОПАСНОСТЬЮ!!!!»

Live measurements on `adb095a5`:

- **Reads:**
  - research history — 24.0 s;
  - project guide — 6.6 s, then 17.2 s;
  - Wiki proposals — 6–9 s;
  - opening a project — 19 API requests.
- **Answers:** an ordinary question takes 86–135 s with no streaming; the model accounts for 18–46 s of it.
- **Deploys and sessions:** every deploy broke open pages, and Access sessions last 24 h.

The architecture's own targets (§15.8) are:

- catalog/orient p95 < 500 ms;
- interactive first token < 4 s.

The cause is architectural:

- every read runs the multi-client enforcement order;
- every question runs the E3 investigation machinery.

The architecture was written for many clients and trust levels: ChatGPT through Drive, named API
clients, federation, public demo. The deployed product has one owner and the owner's agents behind
Cloudflare Access.

## Decision

Introduce deployment profile `OWNER_SINGLE` and select it for this service.

1. **Access.**
   - Cloudflare Access at the edge is the only gate: the owner, plus the owner's agents through MCP OAuth with
     refresh tokens or Access service tokens.
   - Session duration is 30 days.
   - Inside the Worker there is no per-read authorization, reauthorization, grant check or "reread and verify"
     for the owner and the owner's agents.
2. **Reads.**
   - Lists — research history, Studio, Inbox, project guide, sources — are one SQL query over summary rows
     written when the underlying work completes. Target: < 500 ms.
   - Exact byte, digest and currentness verification happens when a specific citation is opened, not when a
     list or draft is shown.
   - A failed read returns the last known value with a staleness note, not a 503.
3. **Ordinary questions (E0/E1).**
   - Context: the selected sources in full when they fit the model budget (e.g. `@cf/zai-org/glm-5.3-flash`,
     1,048,576 tokens); otherwise documents routed by their guides.
   - One model call, streamed.
   - Quotes are verified by exact match in normalized bytes, then minted as EvidenceHandles.
   - Semantic claim audit runs in the background and never lowers a claim on a format failure: that is
     "unverified", not "refuted".
   - At most 4–5 durable steps.
4. **Deep research (E2/E3)** keeps the current investigation workflow: asynchronous and started explicitly.
5. **Models.**
   - One live check when a provider or model is connected.
   - No per-run qualification pins, revocation lookups or proof expiry on the execution path.
   - Spend limits stay.
6. **Deploys.**
   - Read endpoints accept the previous deployment generation.
   - The web client renews its session and retries reads without losing the owner's draft.
   - Protected browser data is cleared on sign-out or a principal change, not on a deployment change.
7. **Kept unchanged.**
   - D1/R2 authority and AI Search as a projection.
   - Idempotent mutations without blind replay.
   - No model or HTTP calls inside D1 transactions.
   - One Worker.
   - Backup and erasure.
8. **Frozen.**
   - New protocols, error codes and tables are added only for owner-visible function.
   - Unused retrieval lanes (LITERAL, SOURCECARD, ATLAS, ATOM, ARGUMENT, STRUCTURE, WEB, VERIFY) and Google
     Drive Exchange leave the development path while the `gemini-mcp` transport profile is selected.

## Consequences

- AGENTS.md:
  - non-negotiable 3 applies to opening evidence, not to rendering lists or drafts;
  - non-negotiable 9 (fail closed on unknown fields) applies to mutations and evidence, while reads tolerate
    additive fields;
  - the owner-web rule on removing protected data after generation loss is narrowed as in Decision 6.
- Multi-client disclosure (Drive Exchange, named API clients, public demo) requires a different profile.
  Enabling one restores the full enforcement order for that client's requests only.
- **Acceptance**, measured on the arXiv comparison project against Gemini Notebook on C1–C4 and O1–O8:
  - lists < 500 ms;
  - first token < 4 s;
  - ordinary answer ≤ 30 s;
  - completeness at the NotebookLM level.
