# Проверка старых PR: текущие задания и конкретные доноры

Дата 2026-10-08. Проверенный source baseline: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`.
Это продолжение REPAIR-SERIES.md, не второй execution plan и не поставка всего runtime. Доработаны существующие draft-задания; #328 — отдельный bounded source patch. Closed/unmerged #243/#245 не доказывают ни отсутствие реализации, ни её готовность.

## 1. Текущая карта

| PR | Конкретный результат задания | Что не делать |
|---|---|---|
| #231 S39/R07 | Native websearch → existing capture/conversion/admission; bounded decoder, truthful provider facts и unknown effects | Второй crawler/SDK или автоматическая повторная оплата после abort |
| #244 S52 | Existing Items adapter: metadata/name preflight, per-item resume/readback, promotion | Новый индексатор; upsert как бесплатный exactly-once |
| #282 S90 | Native emitted Worker/PWA metrics, source counters advisory | Оценивать deployment size по исходникам или сумме gzip файлов |
| #268 S76 | После S90 A/B — pinned formatter и механический diff с неизменными literals/SQL | Смешивать formatting и authority/retry fixes |
| #267 S75 | Existing report reader: bounded on-demand loading, view lifecycle, точные citations/export, честное regenerate/edit различие | Переписывать готовые read/accept/COW; постоянный permission cache |
| #291 S99 | Сохранить существующий полный scope; исправить observed-work trace и отдельно проверить managed capacity | Повторный freezer; заменить все 64 на 4096; silent truncation |
| #233 R06/S41 | ASK/BRIEF: отдельная execution-product identity, один product-plan compiler, exact evidence и section-local distillation | Запускать один 18-stage REPORT для каждого вопроса; перегружать retrieval `product` |
| #285 S93 | Golden v2: unknowns, product identity, immutable receipts, hard gates и holdout | Один aggregate score; LLM judge как canonical oracle |
| #328 | **Source patch:** unknowns реально adjudicated, failures сохраняются в GoldenRunResult | Выдавать этот bounded fix за полный S93/quality benchmark |
| #243 S51 | Closed/unmerged; статус просмотрен, не переоткрывался | Выводить полную готовность exhaustive из closed |
| #245 S53 | Closed/unmerged; COW/product implementation найден, не переоткрывался | Писать второй report engine |

У #267 на свежем чтении mergeable=true; прежнее наблюдение false было моментальным состоянием GitHub, не текущим blocker. Предыдущие non-forced согласования #244/#268 относятся к прошлому checkpoint.

## 2. Паспорта — что читать, какие функции менять и чем принимать

- [S39/R07 native websearch](https://github.com/UnknownAlienHuman/eliot-research/blob/c961638a7ef1ba0be4b49b4dccfa27d70c7f8227/.github/audits/2026-10-08/S39-websearch-native-boundary.md).
- [S52 Items reconciliation](https://github.com/UnknownAlienHuman/eliot-research/blob/0018b1aee9c317f4b36ba2fae78797cd43818780/.github/audits/2026-10-08/S52-items-reconciliation.md).
- [S90 emitted budgets](https://github.com/UnknownAlienHuman/eliot-research/blob/dc8cf19d26f0e4216c874c51b8663f8c5db57768/.github/audits/2026-10-08/S90-artifact-budget-gates.md).
- [S76 mechanical formatting](https://github.com/UnknownAlienHuman/eliot-research/blob/f1cecf2a8df532e93c8573cb657d750d6a1585f5/.github/audits/2026-10-08/S76-mechanical-formatting.md).
- [S75 report lifecycle](https://github.com/UnknownAlienHuman/eliot-research/blob/c498e3cac61ddd4505cf4297c7ee6acd28c2392d/.github/audits/2026-10-08/S75-report-view-lifecycle.md).
- [S99 scope/accounting/capacity](https://github.com/UnknownAlienHuman/eliot-research/blob/71e282abf6eb4aa08155a0c802bc9ace7bab4ee8/.github/audits/2026-10-08/S99-scope-accounting-and-capacity.md).
- [S41 ASK/BRIEF product runtime](https://github.com/UnknownAlienHuman/eliot-research/blob/d8d80a0115c3605522eedd20c0246b951ea7e92e/.github/audits/2026-10-08/S41-ask-brief-product-runtime.md).
- [S93 quality evaluation runtime](https://github.com/UnknownAlienHuman/eliot-research/blob/5732272cad380ccda370e759a499af82bd0eb3f2/.github/audits/2026-10-08/S93-quality-evaluation-runtime.md).
- [#328 Golden unknown adjudication source patch](https://github.com/UnknownAlienHuman/eliot-research/pull/328).

Каждый паспорт сохраняет первоначальные S-критерии, даёт CODE/DOCS paths, existing vs proposed functions, donor links, compatibility и negative acceptance. Документационный PR не является runtime delivery. #328 меняет код, но его compiler/test gates остаются PENDING.

## 3. Report UI и полный scope

**Report preview.** `renderResearchArtifactReport` заранее последовательно читает первые 32 секции; это не viewport loading и не общий предел отчёта. Требуется view-local demand loading; manual open за пределами preview остаётся. Экспорт проверяет все manifest sections. [Код](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/pwa-research-workspace/src/research-run-report.ts).

**Revise != свободный редактор.** `reviseArtifactSection` посылает protocol/expected revision без текста инструкции. Wiki `mountWikiEditForm` уже создаёт отдельный DRAFT. [API](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/pwa-research-workspace/src/artifact-product-api.ts), [server decoder](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-artifacts/src/artifact-product-input.ts).

**Scope уже полный.** `createOrientationApi` сохраняет whole execution snapshot до 4096 metadata; `.slice(0,64)` касается preview. `loadResearchPlanningSources` проходит исходный набор bounded batches. [Profile](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-navigation/src/owner-scope-profile.ts), [planning](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-research-runtime/src/research-run-admission.ts).

**Trace преувеличивает candidates.** ORIENT пишет full snapshot size в SOURCECARD count, хотя `orient` отбирает bounded candidateSources. Считать work у producer и передавать private immutable stats; denominator и omission count остаются полными.

Scope cap не равен managed-search capacity или quality acceptance: tail-source scenarios проверяются отдельно в #242/#291.

## 4. ASK/BRIEF: подтверждённый продуктовый разрыв

`InvestigationSchema` объявляет `ASK`, `BRIEF`, `COMPARE`, `FACT_CHECK`, `DEEP_RESEARCH`, `REPORT`. Но public `research.run` принимает только retrieval `product: "RESEARCH"`; `parseResearchRunRequest`, run payload и ledger/status не связывают execution product. S92 проверяет enum и generic ledger admission, но не product-specific retrieval/model/artifact; BRIEF отсутствует, live assertions — `NOT_EXECUTED`.

**Не писать новый answer engine.** Уже существуют:

- `createResearchOwnerDocumentPreset` — ASK-подобный one-section contract;
- `createArtifactCowSectionProducer` — synthesis, exact-current evidence и independent verification;
- Artifact COW/publication/history;
- R02/#242 — будущий один managed retrieval path.

#233 задаёт:

```text
ResearchRunRequest v3 + execution_product
→ immutable product binding
→ compileResearchProductPlan
→ существующие Workflow steps/handlers
→ ASK one-section artifact
→ BRIEF section-local evidence/contracts
```

Retrieval product, execution product и artifact kind — разные оси. Historical v1/v2 не классифицировать задним числом. Product-plan generation входит в digest. В architecture §8 удалить второй конфликтующий vocabulary `LOOKUP/ANSWER/ANALYZE/...` либо явно сделать его неканоническим UX profile.

Доноры: PaperQA2 question-bound evidence и STORM section-local drafting; не mutable session, Python runtime, URL-number citations или новый framework.

## 5. Golden Corpus: первый source-fix и оставшаяся работа

В main `acceptable_unknowns` парсился, но не adjudicated. `ObservedExtraction` не имел unknowns, `GoldenRunResult` терял failure list, а collapsing extractor возвращал `passed: true` рядом с forbidden collapse.

#328 исправляет ограниченный deterministic слой:

- exact subset unknown check;
- malformed/duplicate/unexpected unknown failures;
- typed missing-observation failure;
- failures и observed unknowns сохраняются в result;
- collapsing extractor получает настоящий verdict;
- focused regression cases добавлены.

Это **не** закрывает S93. #285 остаётся владельцем:

- Golden protocol v2;
- `expected_query_product` vs `expected_execution_product`;
- DEVELOPMENT/HOLDOUT;
- run manifest: code/corpus/case/retrieval/model/prompt/schema/product-plan generations;
- separate retrieval, claim, citation, unknown, latency and cost metrics;
- deterministic hard gates before optional model/human judge.

Donors: Promptfoo per-assertion `pass/score/reason/metric`; ScholarQABench separation citation correctness; DeepResearchGym bounded parallel evaluators. Eliot EvidenceHandle/ClaimAudit/Coverage remain canonical authority.

## 6. Доноры: конкретно что брать

| Код | Брать | Не брать |
|---|---|---|
| [TanStack Query.fetch/cancel/destroy](https://github.com/TanStack/query/blob/aab352876a01f76fd0e00b0b500a85907ec7c8b4/packages/query-core/src/query.ts#L683-L865) | In-flight Promise reuse по identity, consumed AbortSignal и lifecycle | React/runtime целиком, retries мутаций, восстановление private stale data |
| [IntersectionObserver](https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver) | Один observe/unobserve/disconnect на report view | Полный virtualizer или visibility как evidence authority |
| [Eliot mountWikiEditForm](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/apps/eliotr-pwa/src/wiki-edit-form.ts) | Новый DRAFT + exact readback + отдельная publication | Transient attempt key как гарантию replay после reload |
| [PaperQA2 GatherEvidence](https://github.com/Future-House/paper-qa/blob/57e89f7223b0960d5ee5ea048c69e3c47e088572/src/paperqa/agents/tools.py#L250-L315) | Contexts, связанные с конкретным вопросом | Mutable global session question и wholesale Python runtime |
| [STORM article generation](https://github.com/stanford-oval/storm/blob/fb951af7744dab086e34962e9bc6fe878e145f83/knowledge_storm/storm_wiki/modules/article_generation.py) | Section-local evidence/draft/assembly | URL-number citation authority и новый orchestrator |
| [Promptfoo GradingResult](https://github.com/promptfoo/promptfoo/blob/421e7959642c5d4cc1c983259a268de1c6f847b9/src/types/index.ts) | Per-assertion result + named metrics | External runtime/LLM assertion как canonical pass |

## 7. Порядок и границы

R00–R05 остаются первым ремонтом current Research path. R06/#233 использует R02 и Artifact COW, но не требует Web acquisition. #328 можно интегрировать независимо; Golden v2/per-product qualification следует после реальных R02/R03/R04/R06 outputs. #282 A/B → #268 остаётся прежней зависимостью. #267/#291 независимы от AIChatAgent и GraphRAG.

Не добавлять G3, GraphRAG, NotebookProject v2, K2/Basin или Rust rewrite как обязательный blocker. Shared contracts/migrations/manifests меняет один integrator.

Проверены source paths, функции и donor code; сохранены паспорта, PR bodies и bounded #328. Product SQL/main/production не менялись. #328 tests/compiler не запускались по текущему phase rule; commands записаны в PR и имеют статус PENDING. Не создавались issues/discussions/comments, force pushes, deployment, paid calls или backup.
