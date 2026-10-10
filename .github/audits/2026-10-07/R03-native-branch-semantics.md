# R03 — Вопрос → поиск ветки → содержательный результат → synthesis

**Статус:** задание на исправление, документационный draft. Runtime не изменён.
**База:** `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`, проверка 2026-10-07.
**Граница:** остаточные native-branch дефекты после доставленного S37. Закрытый #229 не переоткрывать; его старую ветку не вливать. Новый framework/планировщик/очередь не нужны.

## 1. Читать только нужные разделы

- [Архитектура §§7.5–7.9](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/docs/architecture/ELIOT_RESEARCH.md): planning manifest, hypotheses, W1/W2/W3, evidence freeze и claim audit.
- [Native prompt](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-research-runtime/src/research-branch-role-prompt.ts): `createResearchBranchRolePromptDependencies`.
- [Shared executor](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-research-branches/src/research-branch-execution.ts): `createResearchBranchExecutionHandlers` и переходы read/analyze/reconcile; проверить имя factory по фактическому export перед правкой.
- [External path](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-research-branches/src/research-external-branch-analysis.ts): `taskBody`, `consumeResult`. Здесь objective и questions уже передаются: не объявлять этот путь лишённым вопроса и не переписывать его вместе с native transport.

## 2. Дефект и целевой результат

Native prompt соединяет статический role question и trusted prompt, но не имеет явного immutable root/branch-question binding. Branch output v1 содержит status/handles/unknowns/limitations, не typed finding. Чтение общего evidence pack и выбор handles не равны выполнению отдельного research question.

Результат исправления: для каждой требуемой non-counter ветки можно проследить точный плановый вопрос, реально выполненный retrieval, использованные admitted handles и содержательный candidate finding, который дошёл до synthesis. Нерешённая ветка остаётся явно нерешённой.

## 3. Изменить CODE — три согласованных checkpoint

### A. Вопрос и retrieval

- В `packages/contracts/src/research-branch.ts` определить новую версию существующего branch envelope: root question/digest, branch question/id, planning manifest ref/digest, scope ref. Не копировать весь Ledger в prompt.
- В `packages/cloudflare-research-runtime/src/research-retrieve-branches.ts` получать вопросы из сохранённого planning manifest и передавать branch query через существующий `retrieveWithHeldScope`. У каждой фактически исполняемой ветки свой стабильный request digest; одинаковые immutable inputs допускают явное переиспользование результата.
- В `research-branch-role-server-prompt.ts` и `research-branch-role-prompt.ts` передавать текст вопроса как task data, а не расширение инструментальных полномочий. Привязать prompt/model-request identity к обоим digest.
- Не выполнять роли, отсутствующие в protocol. Concurrency bounded server-side; не добавлять per-role scheduler. Сначала последовательный корректный путь, затем измеряемая оптимизация.

### B. Finding, а не только список ссылок

- В `packages/cloudflare-research-branches/src/research-branch-role-output.ts`, `research-branch-execution-results.ts` и `research-branch-execution.ts` добавить bounded candidate finding: question ID, proposition/observation, точные evidence refs, qualifications/unknowns. Использовать существующие типы claims, observations и debts там, где они подходят; не вводить вторую authority-модель.
- Не использовать подстроки `source_class` как доказательство роли/противоречия. Роль задаёт план и selection receipt; support проверяется отдельно.
- Не присваивать candidate finding authoritative truth по confidence или CANDIDATE_READY. Не сохранять скрытый chain-of-thought.

### C. Довести результат до ответа

- В `packages/cloudflare-research-runtime/src/research-synthesis-prompt.ts` включать компактные проверенные branch findings вместе с root question и reopened exact evidence, а не безграничные transcripts.
- Передавать unmet roles, opposing findings и ограничения; отсутствие findings нельзя скрыть успешным checkpoint.
- Актуализировать соседний `research-semantic-server.ts` только для wiring нового handler generation. Старые сохранённые runs читаются прежним codec/handler; неизвестное смешение generations отвергается.

## 4. Донор: что именно перенять

[PaperQA2 GatherEvidence, pinned code](https://github.com/Future-House/paper-qa/blob/57e89f7223b0960d5ee5ea048c69e3c47e088572/src/paperqa/agents/tools.py#L250-L315): evidence собирается относительно конкретного вопроса и contexts сохраняют вопрос. Перенять question-bound context. НЕ переносить временную замену общего `session.question`: в самом коде отмечено, что она мешает parallel calls. Никакого Python/LangChain runtime в Worker.

Cloudflare остаётся исполнителем durable steps; shared Eliot W1/W2/W3, resolver и reference firewall остаются владельцами authority. Этот PR не заменяет их агентным framework.

## 5. Изменить DOCS

В архитектурных §§7.7–7.9 уточнить различие branch query, candidate finding и verified support. В соответствующем work packet перечислить перечисленные cross-package файлы как одну integrator-owned границу. Обновить имеющиеся implementation-status/gap entries только в implementation commit и только по фактически подключённой версии. Не создавать новый реестр готовности.

## 6. Приёмка после сборки

- Два разных вопроса по одному corpus дают разные question-bound inputs/digests; вопросы сохраняются после restart.
- SUPPORT/ALTERNATIVE находят passage вне первоначального общего top-k через свой query; scope не расширяется.
- Parallel ветки не изменяют общий question, не смешивают evidence refs и не обгоняют бюджет.
- Подмена question/planning/scope/prompt generation отвергается до модели или settlement на соответствующей границе.
- Findings действительно видны synthesis; подстановка прежнего handles-only output не засчитывается как новая версия.
- Ложный/foreign/stale/purged handle, неподдержанный finding и потерянный результат сохраняют negative semantics; replay не повторяет завершённый model call.
- External objective/questions сохранены. COUNTER выполняется отдельно по #214, без чтения финального support-ответа как инструкции.

## 7. Порядок и проверки

R03 можно реализовывать параллельно с managed retrieval #242, пользуясь его существующим port; финальная интеграция требует versioned envelope #242. Контрпоиск #214 интегрируется после общего branch binding. #209 сохраняет first-cause semantics.

Во время реализации: `pnpm exec tsc -b packages/cloudflare-research-branches/tsconfig.json packages/cloudflare-research-runtime/tsconfig.json --pretty false`, scoped ESLint изменённых файлов; при SQL — `pnpm d1:depth`. Сначала проверить реальные references/пакетные команды по [scoped guide](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/docs/implementation/scoped-verification.md). Existing branch/model/synthesis fixtures расширяются, не заменяются. Behavioral/native/quality checks сейчас PENDING.

Не увеличивать scope, response bytes, model budget или source-count limits молча. Не применять изменения к историческому uncertain production-run. Не делать deployment, backup, GitHub-комментарии либо оплатные model/Search calls.
