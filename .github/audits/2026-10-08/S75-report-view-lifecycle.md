# S75 — Дочитать существующий report UI, не строить его заново

Дата проверки: 2026-10-08. Source baseline: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`.
**Статус: документационный PR-задание; production-код не изменён.** Исходный S75 и его критерии сохраняются: draft/revision, citations, section revision, owner review/publication, history и полный проверяемый export. Закрытые #245/#243 не переоткрывать по одному статусу closed/unmerged.

## 1. Что прочитать и что уже работает

- [Architecture §§9.1–9.3](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/docs/architecture/ELIOT_RESEARCH.md), [ER-11](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/docs/agent-work/ER-11-artifact-compiler.md), production-readiness-plan §8.5: COW, section EvidencePacks, publication != scientific verification.
- [renderResearchArtifactReport](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/pwa-research-workspace/src/research-run-report.ts): чтение и проверка секций, supporting/counter citations, Markdown export, Wiki proposal уже подключены. Однострочный файл в apps/eliotr-pwa — re-export, не отсутствующая реализация.
- [createArtifactProductControls](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/pwa-research-workspace/src/artifact-product-controls.ts), [readArtifactPublication / acceptArtifact / reviseArtifactSection](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/pwa-research-workspace/src/artifact-product-api.ts): readback после ACCEPTED, стабильные mutation identities, UNKNOWN и COMMITTED уже различаются.
- [parseReviseArtifactProductSectionRequest](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-artifacts/src/artifact-product-input.ts): v1 принимает protocol и expected_artifact_revision; свободного текста редакционной задачи нет. Не добавлять поле только в браузер.

## 2. CODE — один владелец, три ограниченных checkpoint

### A. Читать по потребности; не блокировать редактирование автопросмотром

Править `packages/pwa-research-workspace/src/research-run-report.ts` и соседний `research-run-panel.ts` (composition/lifecycle). Сейчас setTimeout последовательно вызывает первые `sectionReaders.slice(0, 32)`, независимо от viewport. Каждый read использует общий action controller и setActionsDisabled. Это до 32 предварительных section reads при отсутствии остановки, НЕ ограничение общего числа секций: остальные доступны вручную.

Заменить eager loop одним view-local механизмом открытия секции. Автоматически загрузить первую; остальные — по явному Open section или фактическому попаданию в viewport. Для viewport использовать один нативный IntersectionObserver, `observe`/`unobserve`/`disconnect`, а не scroll listener на каждую секцию. Сохранить конечный суммарный бюджет автоматических чтений, не превышающий прежний 32; concurrency сначала 1. Ручное открытие секции за пределами автоматического бюджета остаётся доступным. Без observer работает ручной путь.

Reuse `readReauthorizedResearchArtifactSection`, `decodeSectionBody`, `renderReadingMarkdown`. Разделить read-in-flight и exclusive mutation busy; автоматический read не должен удерживать общий запрет всех пользовательских действий. Перед mutation остановить queued preview и отменить ожидание in-flight preview; не считать отмену rollback серверной работы.

Для одной view один in-flight Promise на tuple: view epoch/renderSerial + deployment generation + artifact ref + section ref + body_sha256. Ключ не заменяет server authorization; не переносится между пользователями/видами. После settle удалить запись; не создавать постоянный permission cache. При dispose/смене отчёта/clearPrivate отключить observer, очередь и controllers; late completion проверяет epoch, generation, abort и disposed перед любым DOM update. Из renderer вернуть cleanup и вызвать его в lifecycle panel (внутренний API, не новый сервис).

### B. Citation/read/export сохраняют прежние доказательства

Reuse `readReauthorizedResearchArtifactSectionCitations`, `resolveClaimEvidenceCitations`, `citationRefKey` и `research:evidence-selected`. Original handle и свежий reauthorized handle не смешивать. После каждого await повторить проверку актуального view перед отображением; никакого stale-data восстановления после logout/revoke/purge. Это требование к изменяемому пути, не заявление о найденной эксплуатации.

Сохранить независимые обозначения owner publication, claim-audit execution и текущей доступности evidence. UI не ставит ACCEPTED самостоятельно. `acceptArtifact` и последующий `readArtifactPublication` остаются.

`downloadResearchDraftMarkdown` вызывается только после чтения/проверки ВСЕХ manifest sections и citations, а не visible subset. Суммарный output/UTF-8 budget проверять отдельно от лимита preview; ошибка последней секции не создаёт якобы полный файл. Не использовать закэшированный grant или снятый с экрана excerpt вместо reauthorization. Это пользовательский export отчёта, не возобновление отменённых backup/offsite работ.

### C. Названия действий и настоящее редактирование

Текущий `reviseArtifactSection` — regeneration/reverification без пользовательской инструкции. Назвать действие соответственно и отдельно показать Check same operation при незавершённости. Сохранить `mutationKey` и тот же durable attempt при reload/retry; новый UUID на каждый click запрещён.

В Wiki уже есть [mountWikiEditForm](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/apps/eliotr-pwa/src/wiki-edit-form.ts): новый DRAFT, exact readback, отдельная публикация. Переиспользовать принцип, НЕ копировать её transient attemptKey как гарантию reload-idempotency отчёта.

Свободное редактирование report body/instruction этим UI-срезом не реализуется. Если оно входит в обязательный product scope S75, сохранить его как отдельный незакрытый checkpoint: сначала versioned server command, digest инструкции/базовой секции и путь COW/re-audit, потом форма. Нельзя объявить весь S75 завершённым только по переименованной кнопке или выдавать regeneration за редактор.

## 3. Донор: брать механизм, не весь frontend stack

[TanStack Query Query.fetch](https://github.com/TanStack/query/blob/aab352876a01f76fd0e00b0b500a85907ec7c8b4/packages/query-core/src/query.ts#L683-L865): повторное использование уже выполняющегося Promise и передача AbortSignal. [Query.cancel / destroy](https://github.com/TanStack/query/blob/aab352876a01f76fd0e00b0b500a85907ec7c8b4/packages/query-core/src/query.ts#L410-L455): явное завершение lifecycle. Pin — прочитанный commit, не квалифицированный для Eliot релиз.

Не переносить automatic retries, stale-data fallback, persistent/broadcast cache или React. В [документации cancellation v5](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation) неиспользуемый query по умолчанию может завершиться и остаться в cache; отмена может вернуть прежнее состояние. Для private evidence после authority loss это не подходит. В Eliot нужен только view-local in-flight dedup, не новый QueryClient/framework.

[Native IntersectionObserver](https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver) — готовый viewport primitive. Он сообщает пересечение, не авторизацию/прочтение пользователем; не использовать видимость как сигнал научной проверки.

## 4. DOCS / совместимость / зависимости

В production-readiness-plan §8.5 и исходном S75 явно разделить реализованные read/accept/regenerate/Wiki-edit операции и отсутствующий report editorial command. Внести lifecycle/preview/export semantics в существующую PWA документацию, без нового реестра готовности.

A/B — internal UI change без изменения immutable artifact/source bytes, SQL и public API. Не реформатировать одновременно файлы R00–R05; не ждать полного #282/#268 или новой AIChatAgent-миграции. Сложные backend authority changes интегрирует владелец artifacts отдельно. Основной repair path #209/#242/#325/#214 остаётся приоритетом, S75 его не блокирует.

## 5. Результат и приёмка

- Отчёт из 40 секций: initial read первой секции; нет автоматического обхода всех 32 сразу; 33-я/40-я открываются вручную; одно открытие не дублируется одновременным observer callback.
- Смена A→B во время read, logout/revoke/deployment change и dispose не допускают поздней вставки текста A; observer/listeners/controllers сняты. Клиентский abort не выдаётся за rollback.
- Auto preview не блокирует navigation/user action на всю цепочку; mutation остаётся сериализованной и exact-CAS.
- Download включает все разрешённые секции и точные citation mappings; ошибка последней секции не даёт full export. Owner acceptance не подменяет claim audit.
- Retry того же revise использует прежнюю identity; UNKNOWN не запускает новую модель; чужой/mismatched child или receipt отвергается. Wiki edit остаётся DRAFT и требует отдельной публикации.
- Сохранить исходные S75 accessibility, history, negative authorization и browser/storage критерии. Изменённый content не наследует старый audit.

Code-first: scoped TypeScript build для `packages/pwa-research-workspace/tsconfig.json` и приложения по фактическим references, ESLint только changed files. Existing browser/storage fixtures расширить после assembly; новые случаи не называть выполненными. Все compiler/browser/performance/native результаты этого задания **PENDING**. Никаких deployment, provider calls, новых discussion comments или merge в main.
