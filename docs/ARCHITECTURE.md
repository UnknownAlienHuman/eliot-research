# Eliot Research — Architecture

What the product is, what the owner can rely on, and the boundaries every implementation keeps. It does not claim
anything is implemented. [MAP](MAP.md) orders the work into contours, [IMPLEMENTATION](IMPLEMENTATION.md) holds the
technical contracts, [DONORS](DONORS.md) names what to reuse.

## Mission

Eliot is a NotebookLM-style research workspace for one human owner and the agents the owner connects. It turns a
changing library of papers, reports, web pages and working documents into inspectable, cited knowledge without making
the owner administer a platform.

> **collect → read → understand → ask → compare → save → revise**

The ordinary path stays ordinary: a question over selected documents gets a fast streamed answer whose every claim
opens the exact passage it came from. Long work — whole-corpus comparison, deep research with the web — is an explicit
job with progress and a Stop button, never hidden extra work in a chat message. Everything that can happen
automatically does: upload means pick the files; conversion, reading and distillation follow without further steps.

## Design principles

1. **Understand documents, do not just chunk them.** Models are cheap or free. Each source is read once by a large model
   that produces a guide, claim cards with exact quotes, a digest and a glossary. Answers, comparisons and agents build
   on that layer and drop to exact source passages for evidence. Embeddings and chunk search are a routing aid for large
   scopes, not the core.
2. **Read whole documents when they fit.** When the selected sources fit the model's context, the model reads them in
   full. Search is for scopes that do not fit.
3. **One toolset for every agent.** Eliot's chat, background jobs and external agents (Claude Code, Codex over MCP) use
   the same small set of tools — list, outline, read, search, find claims, propose page. No transport-specific stacks.
4. **Code decides scope, labels, budgets and permissions; models decide content.** Citations are labels that code maps
   to exact byte ranges; quotes are verified by code against the retained text.
5. **Build by contours.** Each contour is a usable end-to-end capability with an acceptance run on fixed material
   (`eval/`). Nothing is built for a later contour in advance, and nothing waits for the whole product to exist.
6. **Use Cloudflare and maintained libraries directly.** Copy a donor's mechanism, not its platform.

## Product model

A **project** (notebook) groups sources, chats and knowledge pages. The **Library** owns each source once; projects
attach sources through memberships, so one source can serve many projects. Every captured or reconverted
representation is an immutable **source revision** with a canonical readable text (`text.md`). **Knowledge** is what
Eliot and its agents produce: per-source guides, claim cards, digests and glossaries, and per-project pages — the
overview, saved answers, notes, reports, Wiki pages and the project map.

A **citation** points to an exact UTF-8 byte range of one source revision's `text.md`. A saved page referencing another
page is labelled derived; generated prose never becomes a primary source.

## Required capabilities

| Area | The complete product provides |
|---|---|
| Projects | Create, rename, archive, open and switch projects; each open project/chat has its own URL; drafts, source selection, chats and settings are per project. |
| Library | Batch upload files, add URLs or text; keep originals; show conversion state and warnings; detect exact duplicates; attach one source to several projects; replace or reconvert into a new revision; exclude from answers; detach, archive or delete deliberately. Unconvertible files stay stored and visibly need conversion. |
| Reading | Original and readable text, outline navigation, exact passage links, older revisions; works when models and search are unavailable. |
| Understanding | Automatic per-source guide with suggested questions, claim cards (methods, results with numbers and conditions, limitations, datasets, definitions) with verified quotes, digest and EN/RU glossary; automatic project overview. |
| Ask | Questions in Russian or English over the project default, an explicit selection or no sources; streamed answer with exact citations; stop, reconnect, reopen; save an answer as a page. |
| Retrieval | Whole reading when the selection fits; claim cards and hybrid/keyword search across English and Russian when it does not; source scope is applied before retrieval, never widened. |
| Knowledge | Notes, saved answers, reports and Wiki pages with history; proposals from agents; pages turn stale when their sources change and refresh as new revisions. |
| Project map | Topics with their sources and claims, comparison tables from claims, disagreements to review, gaps, reading routes. Derived navigation with exact links, not a graph database. |
| Deep research | Explicit job over library scope with optional web search; web material is captured into the Library before it is cited; progress, budget, partial results and Stop. |
| Agents | External agents connect over MCP (Streamable HTTP), use the shared toolset with their own models and propose pages; outgoing remote MCP tools and task offers when needed. |
| Models | Owner chooses default models for answers and distillation; per-project override; each model has known limits; credentials stay in Cloudflare. |
| Data ownership | Export originals, readable texts, claims and pages; delete with visible impact; deleted evidence shows as unavailable, never silently replaced. |

## What the owner can rely on

**Canonical text before derived convenience.** Original bytes and the readable text are kept independently of search
indexes and model output. A new conversion creates a new revision; old citations keep pointing at the old text. Search
indexes are disposable and rebuilt from the Library. Index OCR output is never treated as source text.

**Honest answers.** An answer separates what sources state from inference, says plainly when the selected sources do not
contain the answer, and never invents source names, ranges or page numbers. Claim-mode and search-mode answers say which
mode was used.

**Projects do not interfere.** There is no server-wide "current project"; every route, chat, job and write carries its
project. Switching tabs never redirects a stream. Removing a source from a project does not delete the shared source.

**Knowledge changes visibly.** A changed or deleted source marks the pages that cite it stale; refresh creates a new
revision; owner edits are not overwritten; agent writes are proposals.

**Bounded effort.** An ordinary answer is one model call (whole or claim mode) or a short, capped tool loop (search mode).
Jobs have limits on calls, tokens and time and stop when asked. Opening a project or reconnecting never starts model
work. Saving an existing answer never buys it again.

**Practical security.** Cloudflare Access is the single sign-in, checked once per request at the Worker. Inside, there
are no per-row permission checks: one owner sees everything; agents read and propose. Credentials live in Cloudflare.
Source text and tool output are data, never instructions.

## Owner interface

The existing Material 3 Expressive interface (`packages/ui` and `apps/eliotr-web` at the legacy baseline) is the
accepted design. The replacement moves it into the new application and connects it to the new functions; it does not
introduce another visual language. Keep its colour/type/shape/motion tokens, self-hosted Google Sans, colourful light
and dark themes, the top bar with navigation rail (bottom bar on phones), the Sources | conversation/reader |
agents-and-tools panes, 48 dp touch targets and geometry that does not jump while answers stream. Changes are polish:
plain language, fixes for observed problems, new screens from the same tokens and components. A different look needs an
explicit owner decision.

## System shape

One Cloudflare Worker deployment containing:

- the React/Vite owner app (static assets) and a Hono JSON API;
- `ChatAgent` (`AIChatAgent`, SQLite Durable Object) — one per chat;
- Workflows: `IngestWorkflow`, `DistillWorkflow`, `ProjectKnowledgeWorkflow`, `ResearchWorkflow`;
- the MCP endpoint on its own hostname.

Storage and platform services: **D1** for identities, relationships, states, claim cards (with FTS5 trigram search);
**R2** for originals, readable texts, block maps, distillation artifacts and page bodies; **AI Search** (one instance,
`default` namespace) as a disposable search projection for large scopes; **Workers AI** for conversion and models,
**AI Gateway** for external models and spend limits; **Cloudflare Access** for sign-in.

Browser, API, chat, MCP and Workflows call the same product functions. A module exists for a product responsibility.

## Rules that keep the code small

1. Implement one usable capability end to end — caller, function, stored result, reader — then the next.
2. One owner per fact and one implementation per behaviour. Replace callers and delete the predecessor; no `v2`
   wrappers or compatibility layers without a real consumer.
3. Add an abstraction only when it removes existing duplication or isolates a changing platform API.
4. Keep SQL relational and short; put decisions in readable TypeScript.
5. Parse provider responses for the fields you need and ignore the rest.
6. Measure on the assembled product with the `eval/` material, then fix the measured bottleneck.
7. Audits and reviews produce concrete fixes in the owning document or code, not registers or reports in the repo.

## Scope boundary

The complete replacement includes every capability above, delivered in the contour order of [MAP](MAP.md). Audio/video
products, public multi-user sharing, tenancy, a connector marketplace, automatic memory extraction, graph analytics and
a Rust/Wasm rewrite are later choices. Useful content from the old system is imported in K10 before the old system is
retired. Documentation authorises no deployment, production mutation or live-data deletion.
