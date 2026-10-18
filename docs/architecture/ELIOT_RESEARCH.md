# Eliot Research — product manifesto

## Purpose

Turn a personal collection of sources into useful, inspectable knowledge. The owner should spend time
understanding material and making decisions, not administering a research platform or its agents.
This is a single-owner research workspace, not an enterprise knowledge-infrastructure product.

## The product

Bring materials into a Library, organize them into projects, search and read them, ask questions,
and save useful answers with citations. Reopen and edit reports, reuse findings in a Wiki, and review
proposed changes in Inbox. Connect external agents, assign work and receive their results.
Library, Lens, Research, Wiki and Inbox are parts of one workspace, not independent products.
Ordinary source/report downloads and explicitly requested deep research remain useful capabilities.

The essential journey is source → question → usable answer → inspect the source → save and reuse.
Every feature must improve that journey or a selected agent collaboration task.

## What the owner can rely on

Answers arrive progressively; a normal question does not pay for a deep investigation by default.
Deep research is an explicit choice with visible progress, cancellation and bounded spending.
Lists and navigation are responsive; expensive work happens only when the requested operation needs it.

Sources, model conclusions and verified quotations stay distinguishable. A citation opens the actual
source revision and passage, not a model-invented reference. Exact citation matching does not prove that
a conclusion is true. Missing material, partial coverage, failed work and provisional output are visible.
A search result is not a claim that the entire collection was examined.

Saved work survives reopening, reconnecting and routine application updates. Reconnection does not
repeat paid work. Changing project membership is not deleting the source from the Library.
Private material and credentials are protected with established mechanisms, proportionate to real access.
Connected agents receive the access their selected task needs, not implicit ownership of the workspace.

## Shape of the system

One owner, one coherent application, one current implementation of each behavior. Keep Cloudflare as
the managed backend and React/Vite as the browser interface. Astro is not the target.
Use the platform for storage, search and durable execution instead of building competing infrastructure.
Modules separate actual responsibilities; deployment units, languages and package boundaries are means,
not features to maximize. No layer is required merely to resemble a framework or a diagram.

## Simplicity is about responsibilities

Build the requested capability, not a configurable system for every imaginable variant of it.
Prefer a direct, understandable operation to chains of adapters, registries, policies and generic engines.
Add an abstraction when existing callers need it and it removes repeated logic, not for hypothetical reuse.
Keep one owner of each decision and durable fact; derived views must not become parallel sources of truth.

Do not build custom cryptography, signed proof chains, universal hashed envelopes, index-promotion systems,
or agent-governance platforms. Normal authentication, credential protection, content identity and necessary
concurrency checks remain; they are not an excuse for verification machinery at every internal step.
Features must earn their complexity through user value. Being implemented, registered or tested does not
make an unselected feature worth keeping. Donors supply useful solutions, not an obligation to adopt their scope.

## Replace instead of accumulating

Backward compatibility with discarded prototypes is not a product requirement. Replace a design and
remove its predecessor; do not grow a second permanent generation around it. Preserve actual user content
and acknowledged work through a deliberate transition, not every historical mechanism that produced it.
Old tests, speculative clients and archived plans do not dictate the future product.

Success is a useful product whose behavior can be understood and changed locally: fewer independent
mechanisms, duplicated decisions, round trips and failure states. Line counts are diagnostic evidence,
not architecture, a target to fill, or a reason to compress readable code. Removing useful behavior to win
a size metric is as wrong as moving unnecessary machinery into another package or language.

Implementation locations, donor choices, migration mechanics and verification commands belong in the
[implementation plan](../implementation/backend-entrypoints.md), not in this manifesto.
