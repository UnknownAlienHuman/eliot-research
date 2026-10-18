# Perplexity donor: useful mechanisms without importing its platform

Checked 2026-10-18. This note distils the August 27 static audit of Perplexity Portable Computer together
with current official articles and public repositories. It is evidence for [explicit deep research](deep-research.md),
not a specification of Perplexity's private runtime and not an instruction to reproduce it.

## Evidence boundary

The retained Portable Computer audit examined `perplexity_26.8.4+build50522_arm64.deb`, Electron/ASAR assets,
strings from the native sidecars, local templates and public material. It did **not** execute the application,
sidecars, sandbox, broker or database. Static strings prove that a surface exists in the inspected binary; they
do not prove its live topology, authentication, cancellation, crash consistency or exact behavior.

The package supported these observations:

- an Electron control surface and a large native sidecar;
- a compact default tool set with optional capabilities omitted from model requests until available;
- progressive `load_skill` behavior and a separate managed/user Skill distinction;
- root-only optional delegation with a documented default depth of one and no spawn tool for leaves;
- sandbox/broker code paths and a per-run search socket;
- local SQLite schemas for sessions, trajectories, events, files and automations;
- cancellation, interruption, checkpoint and compaction-related symbols.

It did **not** reveal the full local Deep Research solver, a complete RPC schema, an observed fail-closed sandbox
probe, the actual compaction algorithm or the relationship between the hosted Search as Code path and local
`pplx-search`. Those remain unknown. Do not fill them in with a plausible architecture diagram.

Current public evidence checked for this note:

| Source | What it establishes | Limit |
|---|---|---|
| [Search as Code](https://www.perplexity.ai/hub/blog/rethinking-search-as-code-generation), 2026-06-01 | A model can compose retrieval, filtering, fan-out, joins, deduplication and stopping in sandboxed Python while intermediate bulk state stays outside token context. Explicit filesystem serialization was more reliable than a persistent REPL on long trajectories in their tests. | This is the hosted Perplexity architecture and vendor evaluation, not Eliot's required runtime. |
| [Agent Skills](https://www.perplexity.ai/hub/blog/designing-refining-and-maintaining-agent-skills-at-perplexity), checked 2026-10-18 | Skill names/descriptions are always-cheap routing hints; full instructions and reference files load progressively. Negative routing examples and forbidden loads are first-class evaluation cases. | It does not require a general Skill marketplace or loading several large instructions into every Eliot run. |
| [WANDR](https://www.perplexity.ai/hub/blog/wandr-benchmark-evaluating-research-agents-that-must-search-wide-and-deep) and [`perplexityai/wandr@9ea23c7`](https://github.com/perplexityai/wandr/tree/9ea23c7f24d0aaabc2c87b26815a513001b2e7ce) | Wide tasks are graded record by record using item, URL, excerpts and answer; precision, recall and hard/soft completion localize discovery, enrichment and evidence failures. | It is an expensive external evaluation harness, not product orchestration or a runtime completion gate. |
| [DRACO](https://www.perplexity.ai/hub/blog/evaluating-deep-research-performance-in-the-wild-with-the-draco-benchmark) | One hundred production-shaped tasks use roughly forty weighted criteria across factual accuracy, breadth/depth, presentation and primary-source citation, including negative criteria. | LLM judges require calibration and remain offline evaluators, not proof that an individual Eliot answer is true. |
| [`perplexity-search-sdk@638c83e`](https://github.com/perplexityai/perplexity-search-sdk/tree/638c83e0923ba4b95c6701239c3fc2abb7a18879) | The public Apache-2.0 Python wrapper exposes web search, page snippets, async calls and fan-out helpers. | Its compiled core is built from private source. Do not treat the wrapper as the implementation of Portable Computer or copy a Python runtime into the Worker. |
| [`search_evals@cab4c5d`](https://github.com/perplexityai/search_evals/tree/cab4c5df36e5660dc73f5580352eb52962587f01) | Reproducible provider adapters, resumable paid runs, cost records and inspectable traces are useful offline-evaluation practices. | It is not a product dependency, and its published scores are not Eliot measurements. |

## What Eliot should take

### Runtime owns authority; the model chooses bounded actions

The model may choose a query, a source to read or when to finish. Existing Eliot code owns source scope,
authorization, budgets, cancellation, tool availability, effect identity and durable result state. A prompt is
not an authority boundary. If a capability is unavailable, omit it from the callable surface rather than telling
the model not to use it.

This is directly compatible with one existing Cloudflare Workflow. It does not justify a sidecar, another
scheduler, a second database, a generic Harness or a new process topology.

### Keep the callable surface small

For the first explicit deep-research implementation, expose only the operations the selected task needs:
scoped search, exact source reading and finish. Existing connected-agent or computation routes may be used for
a task that actually requires calculation or file work; do not add arbitrary code execution to make the search
loop look like Search as Code. Search, read and saved-output APIs remain normal typed application operations.

A model-visible tool description states when to use the operation, its scope and its result. It does not contain
a duplicate implementation manual. Add a new tool only after a real task cannot be solved cleanly with the
existing set. Negative examples are useful when two tools are easily confused.

### Move repetitive data work out of token context

Batch independent searches only when a broad task actually needs them. Deduplicate locators, filter permitted
sources, join structured records and count coverage in deterministic code. Return compact summaries and handles
to the model; do not inject every candidate and intermediate table into the conversation.

Persist only explicit compact state between model turns: unresolved questions, accepted source references,
small notes and locators to larger outputs. Do not preserve a live interpreter namespace or duplicate the entire
conversation in a second research database.

### Scale effort to the request

Ordinary questions remain direct reading or one scoped retrieval plus one synthesis. Explicit deep research may
iterate. Broad collection and long-form analysis are different task shapes and need different stopping criteria,
but not separate orchestration platforms. Parallel branches or subagents are an optimization to consider only
after the single-loop implementation fails measured tasks; they are not the default design.

## What Eliot must reject

The older audit mapped donor mechanisms into a large vocabulary of owners, manifests, receipts and gates. That
vocabulary belonged to the former Memory OS architecture and must not be recreated in Eliot Research.
Specifically, do not introduce:

- `ObligationGraph`, `SearchProgramIR`, `ResearchStageGraph` or a generic research DSL;
- `CoverageLedger`, observation/proof ledgers or a database that mirrors native Workflow state;
- a new Harness, scheduler, executor, state owner, sidecar or Rust port of the Python Search SDK;
- a permanent delegation tree, swarm, planner/critic panel or default multi-agent research topology;
- an application Skill platform merely to store a few research heuristics;
- a runtime WANDR/DRACO judge, per-answer verifier model or benchmark score as completion authority;
- thousands of retrieval operations as a goal. Search as Code demonstrates a capability for very broad work,
  not the proper cost profile for a private notebook question.

Do not copy Perplexity's web-scale storage architecture either. Eliot has a private owner corpus and managed
Cloudflare retrieval. CobbleDB, Photon and Q2D-Web are valuable evidence about batch reads, separating index build
from query serving, passage ranking and retrieval evaluation; they are not reasons to build a web index.

## Concrete destination

[The deep-research implementation](deep-research.md) applies the useful mechanisms to the existing run,
Workflow, native search, evidence resolver, ResearchSession and report writer. The public-search and benchmark
repositories above stay optional development references. No Perplexity package, binary, SDK or hosted endpoint
becomes a canonical Eliot dependency.

A literal code reuse requires a fresh file-level license and dependency review. This note selects behavior only.
