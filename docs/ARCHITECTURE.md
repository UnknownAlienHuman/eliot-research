# Eliot Research — Architecture

Status: **target architecture for the rebuild**, adopted 2026-10-21. It replaces every earlier architecture,
manifesto, ADR and audit document. Concrete files, schema, APIs and the build order are in
[IMPLEMENTATION.md](IMPLEMENTATION.md). Working rules for people and coding agents are in [AGENTS.md](../AGENTS.md).

## 1. What we are building

A NotebookLM-style research workspace in which **AI agents and one human owner work on the same material**.

- The owner and connected agents put sources into **notebooks**, ask questions, and get streamed answers whose
  citations open the exact passage of the source.
- Useful answers and research results are saved as **pages** (notes, reports, wiki). Knowledge accumulates:
  later questions, agents and deep research start from the wiki and source guides, then drill into passages.
- **Deep research** is an explicit, cancellable, budgeted background job that produces a cited report.
- External agents (Claude Code, Codex, Gemini CLI, ChatGPT, …) connect over **MCP**, use the same notebooks,
  take **tasks** from the owner and propose page changes that the owner reviews in the **Inbox**.

It is a single-owner product. It is not a multi-tenant platform, an enterprise knowledge system, an agent
governance framework or a general workflow engine.

### The core journeys

Every feature must make one of these faster or better. Anything else is out of scope until the owner adds it here.

1. **Collect** — add a file, URL or text to a notebook; within a minute it is readable, has a short guide and
   soon becomes searchable.
2. **Ask** — ask a question; the answer streams in seconds; each `[n]` citation opens the exact passage.
3. **Keep** — save an answer as a page, edit it, see its history; reopen everything later.
4. **Research** — start deep research on a question; watch progress; cancel or let it finish; get a cited report.
5. **Delegate** — an agent reads the notebook through MCP, works on a task, adds sources and proposes pages;
   the owner accepts, edits or rejects in the Inbox.

## 2. Principles

1. **Platform first.** Cloudflare, the Agents SDK and the AI SDK already provide storage, search, durable
   execution, streaming chat, MCP and auth. Use them directly. Write Eliot code only for Eliot's own behaviour.
2. **One way to do each thing.** One table per fact, one function per decision, one citation format, one
   page-history mechanism, one place where each rule lives.
3. **Small and readable.** Plain functions and SQL. No layers that only forward calls. An abstraction must
   remove duplication that already exists in at least three places.
4. **Replace, never accumulate.** No versioned handlers, compatibility readers, feature flags or second
   implementations. When a design changes, change the callers and delete the old code in the same change.
5. **Honest results.** Partial, failed, still-indexing and unavailable states are shown as such. A citation is
   real or it is dropped. Errors reach the user with a clear message; they are never swallowed or retried forever.
6. **Proportionate security.** Exactly the measures in §8. Nothing more without an explicit owner decision.
7. **Fast by construction.** Lists are one indexed D1 query. Answers stream. Expensive work runs only when
   the requested operation needs it.

## 3. Vocabulary

Use these words, in code and docs, with exactly these meanings. Do not invent synonyms.

| Term | Meaning |
|---|---|
| Owner | The one human user. Identified by Cloudflare Access email. |
| Agent | An external AI client that connects over MCP. Identified by its Access identity. |
| Actor | Who performed an action: the owner or a named agent. Stored on every write. |
| Notebook | A research container: sources, chats, pages, tasks, research runs. |
| Source | Imported material: the original file plus its extracted Markdown **text**. File and text never change once ready. |
| Source guide | Short generated summary and topics of one source. Navigation, never evidence. |
| Passage | A character range `[start, end)` of one source's text. |
| Citation | A link from a page or answer to one passage, written `[n]` in Markdown. |
| Chat | A conversation thread inside a notebook. An **answer** is an assistant message with citations. |
| Page | A saved Markdown document in a notebook. Kind: `note`, `report` or `wiki`. |
| Revision | One immutable version of a page. Status: `accepted`, `proposed` or `rejected`. |
| Proposal | A `proposed` revision waiting for the owner's decision. |
| Inbox | The owner's review queue: all proposals, across notebooks. |
| Research run | One explicit deep-research job. Produces a `report` page. |
| Task | A work item the owner gives to agents. |
| Event | One line in a notebook's activity feed. |

## 4. System shape

```text
 Browser (React app)                External agents (MCP clients)
     │ HTTPS + WebSocket                 │ MCP over streamable HTTP
     ▼                                   ▼
 ┌────────────────── Cloudflare Access (one application) ──────────────────┐
 │  owner: email login · agents: service tokens or Access managed OAuth     │
 └──────────────────────────────────┬───────────────────────────────────────┘
                                    ▼
                  Worker "eliot" — the only deployable
   /api/*  (Hono, JSON)    /agents/*  (ChatAgent, Durable Object)    /mcp  (createMcpHandler)
        └─────────────── the same service functions ───────────────┘          static assets
                                    │
   D1: metadata + pages      R2: original files + source text      AI Search: one index per notebook
   Workflows: ingest, research      AI Gateway → Workers AI / external models      Browser Run: URL capture
```

- **One Worker** serves the React app, the JSON API, chat WebSockets and MCP. There are no other services.
- **The browser and agents use the same service functions.** HTTP routes and MCP tools are thin entry points:
  validate input, call one service function, return its result.
- **Durable Objects are used only for chat** (`ChatAgent`, one instance per chat). Everything else is D1/R2.
- **Workflows are used only for multi-step background jobs**: source ingest and deep research.

## 5. Components and their responsibilities

| Component | Cloudflare / library | Responsibility |
|---|---|---|
| Web app | React, Vite, TanStack Query, Tailwind, `@cloudflare/ai-chat/react` | Notebooks, sources, chat, pages, research, inbox, agents |
| API | Worker + Hono + zod | CRUD and commands for the web app |
| Chat | `AIChatAgent` from `@cloudflare/ai-chat` (Durable Object) | Message history, streaming, resume after reconnect |
| Answer engine | AI SDK (`streamText`/`generateText`) + `createAI` from `agents/models/ai-sdk` | Context selection, `search`/`read` tools, citations |
| MCP server | `createMcpHandler` from `agents/mcp/server` | Agent access to the same service functions |
| Ingest | Workflow `IngestWorkflow`, Workers AI `toMarkdown`, Browser Run | File/URL/text → Markdown text → guide → index |
| Search | AI Search, namespace binding, one instance per notebook | Hybrid search with reranking over source text |
| Deep research | Workflow `ResearchWorkflow` | Plan → investigate → write, with budgets and cancel |
| Storage | D1 (metadata, pages), R2 (files, text) | Durable product data |
| Models | AI Gateway (BYOK / unified billing), Workers AI | All model calls; spend analytics |
| Auth | Cloudflare Access + `jose` JWT check in the Worker | Owner and agent identity |

There is no Queue, KV, Vectorize-direct, Rust/Wasm, second Worker, custom index, custom OAuth server or
custom observability stack. Add one only when a journey cannot work without it, and record the decision here.

## 6. How the core behaviours work

### 6.1 Sources

1. Upload / URL / text arrives. The original bytes are stored once in R2 by SHA-256 (identical files share
   one object). A `source` row is created with status `processing` and an `IngestWorkflow` starts.
2. The workflow extracts Markdown text (plain text as is; PDF, Office and HTML via Workers AI `toMarkdown`;
   images via `toMarkdown`, which returns a generated description; URLs via `fetch`, or Browser Run when the
   page needs a browser), writes it to R2, marks the
   source `ready`, generates the source guide, uploads the text to the notebook's AI Search instance and waits
   until it is indexed.
3. A ready source's file and text never change, so citations never move. "Replace with new version" (upload a
   new file or refetch the URL) creates a **new source**; when it becomes ready the old one gets `replaced_by`.
   There is no automatic matching of "the same" document.
4. A source is readable and usable in direct context as soon as its text exists; search works after indexing.
   The UI shows both states.
5. Deleting a source deletes its text, its index item and (if no other source uses it) the original file.
   Citations to it render as "source deleted".

### 6.2 Answers and citations

- Context selection is deterministic and cheap:
  - selected sources (default: all ready sources; an explicit empty selection is an error, not "all");
  - if their total text fits the **direct budget** of the chosen model, the text is split into passages and
    given to the model directly;
  - otherwise the model gets the source guides and the wiki index plus three read-only tools:
    `search(query)` (AI Search over the selected sources), `read(source, range)` and `readPage(page)`;
    at most a few tool steps.
- Every passage shown to the model gets a label `[n]` for that answer. The model cites labels. On finish the
  server maps labels to passages and stores citations `{n, sourceId, start, end, quote}`; unknown labels are
  removed from the text. The model never writes source IDs or offsets.
- A citation proves *where* a statement came from, not that the statement is true. The UI does not call
  answers "verified"; it opens the passage so the owner can judge.
- Chat history is context for follow-ups, never evidence: earlier answers are sent without citation markers.
- Streaming is handled by `AIChatAgent`: closing the tab does not stop generation, reopening resumes it.

### 6.3 Pages, wiki and inbox

- A page has a current accepted revision and an immutable history. Saving creates a revision.
- Owner saves are `accepted` immediately, using an expected-current-revision check (conflict → the UI shows
  both versions).
- Agent saves are `proposed` by default (per-notebook setting may allow direct agent edits). Proposals appear in
  the Inbox; the owner accepts (becomes current), edits and accepts, or rejects. A proposal based on an older
  revision is shown as a diff against the current one and needs an explicit "accept anyway".
- Tasks are not in the Inbox; their result pages are reviewed like any other agent page.
- Wiki pages (`kind = wiki`) have a unique slug per notebook. The notebook's wiki index (titles + summaries)
  is computed from the table, not stored.
- When a model reads a page, the page's own citations are relabelled as passages, so knowledge reused from the
  wiki still cites the original sources. Pages are never treated as sources.

### 6.4 Deep research

Explicit button or MCP call only. One `ResearchWorkflow` instance per run:

1. **Plan** — one model call turns the question into a short list of sub-questions.
2. **Investigate** — one workflow step per sub-question: a model call with `search`/`read` tools and a step
   limit, returning findings with passages.
3. **Check** — one model call lists gaps; at most one extra round of sub-questions.
4. **Write** — one model call writes the report from the findings; it is saved as a `report` page.

Budgets (tokens, tool steps, wall time) are checked at the start of every Investigate step and before Check.
When a budget is exhausted or the owner cancels, the run skips to **Write** and produces an honest partial
report that states what was not covered; if nothing was found yet, the run ends `cancelled` without a report.
Progress is a short text in the run row; the UI polls it. No judge models, critic panels or agent swarms.

### 6.5 Agents and tasks

- Agents call MCP tools that wrap the same service functions as the web app. The tool set is small and
  designed for progressive disclosure: notebook overview (source guides, wiki index, open tasks) → pages and
  search → exact source passages.
- Agents may read everything, add sources, write pages (as proposals by default), start research and update
  their tasks. They cannot delete notebooks or sources.
- A task has a title, instructions, an optional assignee, a status (`open`, `in_progress`, `done`,
  `cancelled`) and an optional result page. Agents poll for tasks; there is no push, dispatch or negotiation
  protocol.
- Every write records its actor and adds an event, so the owner sees who did what.

## 7. Quality targets

Measured on the deployed app with realistic data (≈ 50 sources per notebook). Missing a target is a bug.

| Operation | Target |
|---|---|
| Any list or page open | ≤ 2 API requests, p95 < 300 ms server time |
| Notebook open (sources + pages + chats) | ≤ 3 API requests total |
| Answer first token | < 3 s (direct context) / < 6 s (with search) |
| Typical answer complete | < 30 s |
| Source text ready (10 MB PDF) | < 60 s; searchable a few minutes later |
| Deep research | Minutes, owner-set budget; progress visible within 10 s of start |
| Initial JS bundle | < 400 KB gzip |

## 8. Security model (closed list)

1. **Cloudflare Access protects the whole hostname**: owner by email policy; agents by service tokens (headless)
   or Access managed OAuth (interactive MCP clients).
2. **The Worker verifies the Access JWT on every API, chat and MCP request** (`Cf-Access-Jwt-Assertion`: signature via cached
   JWKS, audience, issuer, expiry) and maps it to an actor. Unknown identity → 403. That is the only
   authorization check; there are no per-object permissions.
3. **Secrets** live in Worker secrets or AI Gateway (BYOK). Never in D1, R2, logs or the browser.
4. **Untrusted content stays data.** Markdown is rendered without raw HTML. Source text is delimited in prompts.
   Models inside Eliot have only read tools; every write is done by host code.
5. **Agent page edits are proposals** unless the owner enables direct edits for a notebook.
6. **No cross-site forgery:** every mutation must carry `Content-Type: application/json` or, for file
   uploads, the header `X-Eliot-Upload: 1`. Both force a CORS preflight, which the Worker never approves.
7. **Local development only:** when `ENVIRONMENT=development` and the request comes to `localhost`, the
   `DEV_ACTOR` variable stands in for Access. Production never sets either.

Not required, and not to be built without an owner decision: per-object ACLs, grants, re-authorization on reads,
content hash chains, signatures, receipts, custom encryption, custom OAuth, rate limiting, audit ledgers.
Backups are D1 Time Travel (30 days) plus the notebook export.

## 9. Scope

**Version 1:** journeys 1–5; files (PDF with a text layer, DOCX, XLSX, ODS/ODT, HTML, Markdown, text, CSV, images),
URLs and pasted text; chat with citations; pages with history; wiki; inbox; deep research over notebook
sources; MCP; tasks; activity feed; notebook export as a Markdown ZIP; UI in English and Russian.

**Later, when the owner asks:** Studio presets (briefing, FAQ, timeline, study guide), web discovery in deep
research, wiki maintenance from new sources, audio overview, YouTube transcripts, OCR for scanned PDFs,
cross-notebook search, sharing.

**Never (by decision):** multi-tenancy, enterprise ACLs, federation, Google Drive exchange, custom search
indexes or index generations, model qualification ceremonies, claim-audit judges, backup/restore subsystems,
Rust ports of TypeScript logic, compatibility with the legacy codebase.

## 10. The legacy codebase

The previous implementation (≈ 280k lines of TypeScript in 3 apps and 41 packages, 152 D1 migrations,
226 tables and 713 triggers in the production database, 133 HTTP routes) is frozen at git tag `legacy-final`
and removed from `main` in Phase 0. Production holds 8 projects, 15 sources and a few dozen report/wiki
revisions; they are imported once (IMPLEMENTATION.md, Phase 6). Legacy code is read only when IMPLEMENTATION.md names a specific file as a donor.
