# Eliot Research — серия исправлений R00–R05

Дата: 2026-10-08. Проверенный main: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`.

**Это индекс шести implementation tasks, а не отчёт об исправленном продукте.** Все шесть PR — документационные drafts; runtime и SQL в них пока не реализованы. Отдельные более ранние #320–#323 содержат source patches и сохраняют собственные pending checks. Из этого индекса не следует разрешение на их merge, deployment, платные вызовы или повтор исторического uncertain run.

Цель серии — исправить существующий путь source → поиск → evidence → исследование → проверяемый ответ для человека и агента. Не создавать ещё один NotebookLM framework и не превращать расширение UI, G3 reindex или новую graph DB в условие устранения текущих ошибок.

## 1. Шесть PR, шесть результатов

| ID / PR | Читать / точные функции | Что сделать | Готовый результат |
|---|---|---|---|
| **R00 / [#209](https://github.com/UnknownAlienHuman/eliot-research/pull/209)** | failure-model; architecture §§7.7–7.9; `workflowFailure`, `recordWorkflowFailure`, `retainWorkflowFailure`, `resolveCitationSet` | Согласовать пять freeze-кодов в TS и SQL; различить invalid evidence и невозможность проверки | First cause сохраняется до D1/status, temporary I/O не становится evidence-invalid |
| **R01 / [#324](https://github.com/UnknownAlienHuman/eliot-research/pull/324)** | Cloudflare search response; `decodeAiSearchSearchResult`, `exactObject` | Допустить только документированный text query_kind и прежний envelope, не ослабляя остальные guards | Новый текстовый provider response проходит decoder; чужой/malformed/multimodal ответ не проходит |
| **R02 / [#242](https://github.com/UnknownAlienHuman/eliot-research/pull/242)** | architecture §§6.5–6.10, ER-04; `compileAiSearchManagedSearchRequest`, `createD1BackedAiSearchManagedSearchPort`, `retrieveWithHeldScope` | Один scoped hybrid list, query/ranking provenance, separate candidate/scan/evidence/bytes budgets, bounded backfill | Используется managed relevance без двойного голоса; invalid top candidate не уничтожает допустимый tail |
| **R03 / [#325](https://github.com/UnknownAlienHuman/eliot-research/pull/325)** | architecture §§7.5–7.9; `createResearchBranchRolePromptDependencies`, `createResearchBranchExecutionHandlers`, synthesis prompt | Immutable root/branch question → собственный retrieval → typed candidate findings → synthesis | Можно проследить, какой вопрос решала ветка и какой содержательный вывод дошёл до ответа |
| **R04 / [#214](https://github.com/UnknownAlienHuman/eliot-research/pull/214)** | architecture §§7.2, 7.8–7.9; branch execution/results, freeze lineage | Counter query; relation candidate отдельно от selected handle; убрать source_class substring authority | Найденный контрпример достигает audit; обычный релевантный passage не объявляется противоречием |
| **R05 / [#326](https://github.com/UnknownAlienHuman/eliot-research/pull/326)** | architecture §7.7; `executeResearchWorkflowNativeSteps`, `ExternalAgentTaskStore`, MCP callback; Cloudflare events/rules | Publish → native wait → result+outbox → event(locator) → authoritative consume | Обычное ожидание агента не требует ручного restart и не повторяет paid effect |

Полные паспорта, закреплённые за коммитами:

- [R00 — CODE/SQL/DOCS и negative acceptance](https://github.com/UnknownAlienHuman/eliot-research/blob/38a9e76613c3eeb892e381d03c18b68737d87df4/.github/audits/2026-10-08/R00-first-cause-and-citation-outcomes.md).
- [R01 — decoder compatibility](https://github.com/UnknownAlienHuman/eliot-research/blob/826215185a34472a9462363dc1a4a06027a4dee5/.github/audits/2026-10-07/R01-ai-search-response-compatibility.md).
- [R02 — managed retrieval, three checkpoints](https://github.com/UnknownAlienHuman/eliot-research/blob/c921f78b9565c66870fec365e568614c7f9fa6dc/.github/audits/2026-10-08/R02-managed-retrieval.md).
- [R03 — native branch semantics](https://github.com/UnknownAlienHuman/eliot-research/blob/a1f52618b3266c4d102020f5c8db0449de17d274/.github/audits/2026-10-07/R03-native-branch-semantics.md).
- [R04 — counter query and freeze relation](https://github.com/UnknownAlienHuman/eliot-research/blob/96d05cf9996963a4e3699c481f17893393467b6f/.github/audits/2026-10-08/R04-counter-search.md).
- [R05 — external task wait](https://github.com/UnknownAlienHuman/eliot-research/blob/a08d7d14e02be343004511a40924ffd9ff221802/.github/audits/2026-10-07/R05-native-workflow-wait.md).

## 2. Порядок без перекрывающегося владения

```text
R00 (#209) ─────────────────────────→ R05 (#326)

#320 scope + R01 (#324) → R02 (#242) → R03 (#325) → R04 (#214)
                                 (финальная интеграция)
```

R00 и R01 можно разрабатывать независимо. R03 можно готовить через согласованный retrieval port параллельно R02, но итоговую интеграцию делать после R02. R04 интегрируется после общих R03 types/executor; не редактировать эти файлы параллельно. R05 не зависит от нового UI или graph stack, но использует failure vocabulary R00.

| Общая граница | Единственный владелец checkpoint |
|---|---|
| failure vocabulary + соответствующая forward migration | R00 integrator |
| platform AI Search decoder | сначала R01, затем R02 |
| retrieval request/trace/profile identity, lane loop, budgets | R02 integrator |
| branch question/finding contract и common execution | сначала R03, затем R04 |
| counter-specific relation и freeze lineage | R04 |
| external task + result/outbox + native wait + MCP wake | R05 integrator с existing delivery owner |
| общие barrels/manifests/status и изменения app composition | integrator соответствующего блока, не параллельные leaf agents |

Это proposed integration order, не второй глобальный план. [START-HERE](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/docs/START-HERE.md) и текущий backend-delivery-plan остаются операторской точкой входа. Индекс не снимает историческую паузу на deployment/backup и не создаёт новую active claim. По прямому указанию владельца audit-comments/discussions не создаются; результаты фиксируются в файлах и PR bodies.

## 3. Что брать у доноров, а что не брать

**Cloudflare — готовая реализация commodity слоя.** [Search binding](https://developers.cloudflare.com/ai-search/api/search/workers-binding/): использовать instance.search и явные retrieval/rerank/cache/rewrite/failure options. Не писать собственный BM25/vector/reranker service. Текущий query_kind относится к input modality, не к authority evidence. Типовой ответ provider не заменяет exact resolver. Документация проверена 2026-10-08.

**Cloudflare Workflows — готовое durable ожидание.** [Events](https://developers.cloudflare.com/workflows/build/events-and-parameters/): `waitForEvent`/`sendEvent`; [rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/): replay и step boundaries. Native wait располагается в orchestration, не внутри другого step.do. Event type — bounded letters/digits/hyphen/underscore; task/result digest — locator, не разрешение. D1 outbox и authoritative readback сохраняются.

**PaperQA2 — question-bound evidence.** [GatherEvidence, pinned lines 250–315](https://github.com/Future-House/paper-qa/blob/57e89f7223b0960d5ee5ea048c69e3c47e088572/src/paperqa/agents/tools.py#L250-L315). Перенять связь context с вопросом; не mutable session.question, не Python runtime. Сам upstream TODO указывает, что временная подмена общего вопроса мешает parallel calls. Для R02 [docs.py](https://github.com/Future-House/paper-qa/blob/57e89f7223b0960d5ee5ea048c69e3c47e088572/src/paperqa/docs.py) — источник идеи отдельного candidate pool, не wholesale port.

**Собственный Eliot — предпочтительный донор authority.** Переиспользовать exact resolver, first/latest retention, current scope, W1/W2/W3, attempt store и outbox. Не создавать ещё один ledger, Error framework, permission cache или registry ради каждого улучшения.

## 4. Обязательная форма implementation checkpoint

Для каждого R-блока в PR body фиксировать:

```text
Baseline: точный обновлённый main SHA
Checkpoint: одно рабочее изменение A/B/C из паспорта
Owned paths: фактические файлы и shared integrator
CODE: что подключено у реального caller, что удалено/переиспользовано
DOCS: какие существующие sections/contracts скорректированы
Compatibility: старые bytes, generations, replay и forward migration
Checks: точные команды, toolchain, результаты; неисполненное PENDING
Remaining: конкретный следующий checkpoint, не общий «продолжить аудит»
```

Не менять old migration, не повышать лимиты для зелёного результата, не засчитывать scaffold/DTO/18 технических стадий как готовое исследование. Не добавлять очередной completion enum. Existing #320–#323 patches сохранить; ни наличие PR, ни mergeable не являются выполненной приёмкой.

## 5. Проверки и статус

По [scoped guide](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/docs/implementation/scoped-verification.md): TypeScript — build references и scoped ESLint; SQL — `pnpm d1:depth`; затронутый Rust — cargo check и minimal Clippy. Во время code-first assembly не запускать автоматически broad unit/browser/native/quality/paid suites. Финальные negative/acceptance criteria остаются обязательными, но до выполнения имеют статус PENDING.

Документационные изменения проверяют существование путей/символов, корректность ссылок и отсутствие циклов в зависимостях; это не runtime acceptance. R01 хранит отдельную историческую envelope-only reproduction, не workspace/Vitest/workerd доказательство. Сбой локальной сетевой загрузки не мешает GitHub API; отсутствующие локальные зависимости не выдаются за прошедшую compilation.

После assembly использовать существующие S92 local → S94 staging → S93/S95/S96 → S97 release gates, только в разрешённом scope. `remote:true` для AI Search выполняет реальный удалённый поиск. Ни один read/GET successful response не квалифицирует полный продукт.

## 6. Следующая волна — не смешивать с R00–R05

После исправления текущего research path: source discovery/capture под существующим #231; быстрый grounded answer и DISTILL поверх тех же evidence/artifact contracts; human/agent workspace и publication/history под существующими UI tasks. Не требовать большого NotebookProject v2, K2/Basin, G3 reindex, Rust-переписывания, новой graph database или второго agent harness прежде, чем текущая цепочка работает корректно.

Из аудита v11 в первую очередь переносится решение проблемы, не весь объём текста. Качество определяется реальным caller path и проверяемым итогом, а не числом PR, строк документации или названных доноров.
