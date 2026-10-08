# S41 — Реальные ASK и BRIEF, а не только enum и общий Research

**Статус:** исполнимое задание. Этот файл не меняет runtime.
**Проверенная база исходников:** `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`, 2026-10-08.
**Цель:** дать человеку и агенту два рабочих NotebookLM-подобных продукта поверх уже существующих evidence/retrieval/artifact primitives, не запускать один и тот же 18-stage REPORT-контур для любого вопроса.

## 1. Подтверждённый разрыв

1. `InvestigationSchema` регистрирует `ASK`, `BRIEF`, `COMPARE`, `FACT_CHECK`, `DEEP_RESEARCH`, `REPORT` и другие execution products.
2. Публичный `research.run` принимает только retrieval-поле `product: "RESEARCH"`; `parseResearchRunRequest` не принимает execution product.
3. `persistResearchSessionRunPayload` и `ResearchSessionRunApplicationInput` execution product не сохраняют. Ledger head также не доказывает его.
4. `tests/integration/browser/s92-products.mjs` проверяет enum и прямую запись generic ledger head. Он не выполняет product-specific stage plan, retrieval, model output или artifact; `BRIEF` в списке сценариев отсутствует, а live product assertions честно `NOT_EXECUTED`.
5. Ordinary owner preset уже существует: `createResearchOwnerDocumentPreset` создаёт один section contract `answer` и политику `research_report`. `createArtifactCowSectionProducer` уже делает synthesis, exact-current evidence recheck и independent claim verification. Новый answer/report engine не нужен.

Следовательно, наличие enum и одинакового ledger admission нельзя засчитывать как реализацию продуктов.

## 2. Что читать

- `docs/architecture/ELIOT_RESEARCH.md`: §§6.6–6.12, 7.7–7.12, 8, 9.1–9.3.
- `apps/eliotr-core/src/research-session.ts`: `parseResearchRunRequest`, `createResearchRunService`.
- `packages/interfaces/src/semantic-api.ts`: `QueryRequest`; не смешивать retrieval product и Research execution product.
- `packages/cloudflare-research-runtime/src/research-session-application.ts`: `persistResearchSessionRunPayload`, `persistResearchSessionRunApplication`.
- `packages/cloudflare-workflows/src/research-workflow-step-execution.ts`: `executeResearchWorkflowNativeSteps`.
- `packages/cloudflare-research-configuration/src/research-owner-document-preset.ts`: `createResearchOwnerDocumentPreset`.
- `packages/cloudflare-research/src/research-report-config.ts`: текущий single-section config.
- `packages/cloudflare-research/src/artifact-cow-section-producer.ts`: `createArtifactCowSectionProducer`, `compileSection`, `validateCurrentEvidencePack`, `validateCitedEvidence`.
- `tests/integration/browser/s92-products.mjs`: текущая граница admission-only.
- R02/#242: managed retrieval и exact-resolution budgets. R00/#209: first-cause semantics.

## 3. CODE — checkpoint A: явная продуктовая идентичность

### 3.1. Не перегружать `QueryRequest.product`

`FAST_SEARCH/LOCATE/ORIENT/RESEARCH/...` — физические retrieval products. `ASK/BRIEF/...` — Research execution products. Это разные оси.

Добавить отдельный versioned run contract, например:

```ts
interface ResearchRunRequestV3 extends QueryRequest {
  readonly request_version: "eliotr.research-run-request.v3";
  readonly inquiry_protocol_ref: VersionedRef;
  readonly execution_product: "ASK" | "BRIEF";
}
```

Предлагаемый путь нового типа: `packages/interfaces/src/research-run.ts` **(NEW)** либо рядом с `semantic-api.ts`, но не расширять generic query methods execution-specific полями.

Изменить:

- `parseResearchRunRequest` — exact-key decoder v3;
- request digest/idempotency identity — включает product;
- `persistResearchSessionRunPayload` — сохраняет product;
- run status/history — возвращает product для новых runs;
- MCP/computer-agent run schemas — принимают product только после явного разрешения соответствующего grant/profile.

V1/v2 bytes и replay не переписывать и не угадывать задним числом как ASK или DEEP_RESEARCH. Для historical runs wire field остаётся optional/legacy-unclassified. Нельзя выводить product из заголовка artifact или handler name.

### 3.2. Durable binding

Новый product должен быть связан с `operation_id`, `investigation_id`, request SHA и handler generation до Workflow dispatch.

Предпочтительно расширить существующий canonical run record новой forward migration и обновить backup table specs/strict decoders. Не создавать второй mutable registry. Если существующий `research_workflow_run` нельзя безопасно расширить без изменения его guards, допускается отдельная immutable one-row binding table, но её обязанность ограничена product identity; ledger/outbox/attempt stores не дублируются.

Новая migration выбирает следующий номер после актуального main. Старые migrations не редактировать. Existing rows остаются читаемыми.

## 4. CODE — checkpoint B: один product-plan compiler

Добавить один server-owned compiler, предлагаемый путь:

`packages/cloudflare-research-runtime/src/research-product-plan.ts` **(NEW)**

```ts
compileResearchProductPlan({
  executionProduct,
  protocol,
  evidenceGrade,
  sourceMode,
}): ProductExecutionPlan
```

Plan содержит:

- required/optional stages;
- branch roles;
- counter-search requirement;
- maximum provider calls/tokens/bytes;
- materialization profile;
- completion/coverage requirements;
- generation/ref, входящий в request identity.

Исполнять его через существующие native Workflow steps и stage handlers. Не создавать второй Workflow engine. Пропущенная стадия получает typed `NOT_REQUIRED_BY_PRODUCT_PLAN` receipt; она не изображает выполненную функцию.

### ASK v1

Минимальный corpus-only путь:

```text
scope/protocol currentness
→ R02 managed retrieval
→ exact EvidenceHandle resolution
→ bounded answer synthesis
→ independent claim audit
→ citation resolution
→ coverage/unknowns
→ one-section artifact/read model
```

Использовать existing owner preset и `createArtifactCowSectionProducer`. ASK не запускает branch/counter/acquisition автоматически, если protocol этого не требует. No-hit не превращается в complete-scope absence.

### BRIEF v1

BRIEF использует тот же frozen scope/evidence authority, но формирует несколько коротких section contracts:

1. key findings and numbers with conditions;
2. disagreements/counterevidence;
3. limitations, unknowns and next probes.

Не добавлять новый renderer. Эволюционировать report config до versioned v2 с `section_contracts`, сохранив чтение v1 `section_contract`. ArtifactKind на первом срезе остаётся `research_report`; execution product и artifact kind — разные оси. Новый `brief` kind добавлять только при доказанной потребности отдельного lifecycle/export policy.

Каждая секция получает свой bounded EvidencePack и проходит existing `compileSection` + independent verification. Общий context dump для всех секций не использовать.

## 5. CODE — checkpoint C: реальный product acceptance

Исправить misleading coverage в `tests/integration/browser/s92-products.mjs`:

- admission test назвать admission, не product execution;
- добавить `BRIEF` в registration/admission только после v3 contract;
- product acceptance читает exact product binding, stage receipts и итоговый artifact;
- ASK доказывает one-section answer + exact cited handle + claim audit;
- BRIEF доказывает ожидаемые section contract IDs и отдельные evidence ledgers;
- legacy v2 replay не меняет identity;
- ASK и BRIEF с одним idempotency key конфликтуют до model call;
- unsupported product/grade/protocol rejected before paid effect;
- live-model dependent checks остаются `NOT_EXECUTED`, пока реальный gateway не разрешён.

Наличие строки enum, D1 row или общего DRAFT не является product PASS.

## 6. Доноры

### Внутренние

- `createResearchOwnerDocumentPreset`: готовая ASK presentation/semantic configuration.
- `createArtifactCowSectionProducer`: exact evidence + independent verification.
- `createArtifactProductService` / COW revision path: publication/edit/history.
- R02 managed retrieval: единственный primary relevance path.

### PaperQA2

[`GatherEvidence`](https://github.com/Future-House/paper-qa/blob/57e89f7223b0960d5ee5ea048c69e3c47e088572/src/paperqa/agents/tools.py#L250-L315): evidence привязан к конкретному вопросу. Брать question-bound contexts; не брать mutable global `session.question` и Python runtime.

### STORM

[`StormArticleGenerationModule`](https://github.com/stanford-oval/storm/blob/fb951af7744dab086e34962e9bc6fe878e145f83/knowledge_storm/storm_wiki/modules/article_generation.py): section-local drafting and assembly. Брать разделение section evidence/draft; не URL-number citation remapping, thread-level all-or-nothing и новый framework.

Cloudflare AI Search/Workflows остаются commodity retrieval/orchestration. Не писать собственный BM25, vector engine или scheduler.

## 7. DOCS

Обновить §7.12 конкретными stage profiles и результатами ASK/BRIEF. В §8 удалить/переименовать второй конфликтующий vocabulary `LOOKUP/ANSWER/ANALYZE/DEEP/AUDIT/REPORT`; authority — enum из `InvestigationSchema`, а intelligence/evidence grade остаются отдельными осями.

Документировать:

- retrieval product != execution product != artifact kind;
- legacy runs без product binding;
- ASK не означает complete coverage;
- BRIEF — distillation artifact, не полный DEEP_RESEARCH;
- exact evidence/claim audit обязательны для поддерживаемых утверждений.

## 8. Приёмка

- Один и тот же corpus/question даёт различимые ASK и BRIEF identities и outputs.
- ASK не выполняет ненужные branch/model stages; skipped receipts видимы.
- BRIEF имеет section-local evidence, disagreement и limitation sections.
- Missing/revoked/purged evidence, unsupported protocol, stale config, cancellation and lost ACK do not become successful answers.
- Unknown model effect не повторяется автоматически.
- Historical v1/v2 bytes/replay/status остаются читаемыми.
- Product plan generation участвует в digest; изменение plan не переиспользует старый result.
- Human UI и agent API читают один canonical product/result, а не отдельные реализации.

## 9. Проверки и границы

Code-first: scoped TypeScript build и ESLint изменённых paths; при migration — `pnpm d1:depth` и backup/table-spec alignment. Focused fixtures добавляются вместе с code, full browser/native/quality выполняются после assembly.

Не включать в этот PR: Web acquisition (#231), GraphRAG, NotebookProject v2, AIChatAgent transport, K2/Basin, audio/video outputs или новый frontend framework. Нет deployment, paid calls или historical uncertain-run replay.
