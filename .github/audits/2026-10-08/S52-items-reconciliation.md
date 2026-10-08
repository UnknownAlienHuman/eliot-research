# S52 — Исправить существующий Items adapter, не писать второй индексатор

Проверено 2026-10-08 на main `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`. Это уточнённое implementation-задание для #244; runtime и SQL этим документом не изменены. Исходные требования A → shadow B → promotion → rollback из S52 сохраняются.

## Читать

1. `docs/START-HERE.md`, актуальный checkpoint в `docs/implementation/backend-delivery-plan.md`; текущий owner request разрешает эту PR-подготовку, не deployment/backup.
2. Архитектура §§6.4.2 и 19.10; `docs/agent-work/ER-38-governed-projection-generation-execution.md`.
3. [Реальный Items adapter](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-projection/src/managed-index.ts): `createManagedProjectionPort`, `indexItem`, `decodeItem`, `assertExpectedMetadata`, `managedItemFilename`.
4. [Delivery composition](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-ai/src/projection-execution-delivery-handler.ts): `projectionExecutor`, `projectionManagedGenerationIsActive`, `createProjectionExecutionDeliveryHandler`.
5. [Cloudflare Items binding](https://developers.cloudflare.com/ai-search/api/items/workers-binding/) и [first-party типы](https://github.com/cloudflare/workerd/blob/cb61e82b35bf4cac7fc69821743337b8ca498bd5/types/defines/ai-search.d.ts): `AiSearchItems`, `AiSearchItem`, `AiSearchListItemsParams`.

## Уточнение прежнего аудита

Items API УЖЕ используется: `uploadAndPoll(key, document, options)` → `items.get(uploaded.id).info()`. Factory подключена в delivery handler. Утверждение v11 §148 об отсутствии этого пути неверно. Его следует исправить в аудите, а не реализовывать ещё раз.

Есть конкретные несовместимости/риски в существующем коде:

- `managedItemFilename` допускает до 256 символов с `.md`, тогда как документация upload устанавливает максимум 128. Это слишком широкий контракт, не доказательство отказа текущих автоматически созданных коротких ключей.
- `assertExpectedMetadata` требует ровно пять Eliot-полей. Документированный item-info допускает built-in `filename`, `folder`, `timestamp`; такой корректный расширенный ответ будет отвергнут. Это проверка совместимости, не установленная причина live-инцидента.
- После успешных первых item uploads ошибка следующего приводит к общему DEGRADED; локальные per-item receipts теряются. Нельзя считать, что uploads откатились или весь набор уже прочитан обратно.
- `as unknown as ProjectionAiSearchNamespace` скрывает расхождение собственного интерфейса binding. В `platform-cloudflare/src/bindings.ts` существует другая Items-форма; не объединять её механически с публичными domain contracts.

## CODE — три checkpoint одного владельца

### A. Узкий совместимый boundary

Изменить `managed-index.ts` и только нужную часть `packages/platform-cloudflare/src/bindings.ts`/delivery composition.

До ПЕРВОГО provider call проверить весь bounded набор: source/generation, provider key, document size и metadata. Имя проверять по native upload envelope; не обрезать и не переименовывать старые keys молча. Сохранять существующий более строгий 4 MiB application budget: увеличение provider limit не требует его повышения.

Разделить Eliot custom metadata и распознанные built-in поля. Пять custom values по-прежнему сравниваются точно; валидировать допустимые built-ins отдельно. Не заменять всё на permissive record, не игнорировать неизвестные authority-bearing поля. Нормализованный внутренний receipt остаётся strict/versioned. Проверить обе формы на retained native fixture перед qualification.

Переиспользовать native `items.uploadAndPoll`, `items.get(id).info()`, typed item status. `completed` + согласованный readback не равен generation ACTIVE. `error/skipped/outdated` не успех.

### B. Exact resume без повторной индексации готовых items

Сначала прочитать существующие projection job/item receipts в execution/store path; только недостающую durable связь добавить в том же capability, без нового index registry. Для каждого item привязать desired document digest, provider ID/key, source ID, managed generation и readback digest. Отличать исходный `section_text` от реально загруженного `document_context_header + section_text`.

При lost upload ACK: bounded lookup по exact key + source, затем info; при наличии сохранённого provider ID использовать сразу его. First-party `AiSearchListItemsParams.key` существует в прочитанных типах; public binding-таблица его не перечисляет. Проверить именно установленный SDK/runtime; если поддержка не доказана, использовать документированный REST exact-key endpoint через имеющийся transport, не full-list scan и не cast, изображающий отсутствующий API.

Совпадение metadata с нашим заявленным content digest само по себе не хэширует provider bytes. Для необходимой content attestation использовать `items.get(id).download()` с bounded read/hash либо явно ограничить receipt уровнем metadata-readback. Чужой key/source, несовпадение bytes или неполный набор не разрешают reuse. Повтор upload с тем же именем может заново индексировать item: upsert не означает бесплатный/no-effect replay.

### C. Существующая generation authority

Сохранить `createAiSearchGenerationRegistryService`, `createD1AiSearchGenerationRegistryStore`, `assertImmutableAiSearchProfile`, expected-head CAS и `projectionManagedGenerationIsActive`. Набор partial receipts никогда не продвигается как полный. Переход A→B и rollback обязаны учитывать CURRENT purge/owner authority; readback старого A не возвращает удалённый источник.

Не подменять текст failure поиском слова `status` в произвольном message: использовать закрытый safe adapter outcome, совместимый с existing reason vocabulary. Не логировать provider body. Номер forward migration выбирать по актуальному main только при реальном изменении persisted shape.

## Донор — конкретное заимствование

Cloudflare даёт транспорт, polling, item status и content readback; не писать их копию. [CocoIndex `entry_fingerprint` / `register_all_fn_logic`](https://github.com/cocoindex-io/cocoindex/blob/57d92ec865c1fd2becd135559ef2d954c4721ffd/rust/sdk/cocoindex/src/logic.rs) показывает привязку cache validity к версии функции. В Eliot использовать УЖЕ имеющиеся projector/profile/generation identities в exact resume key; не импортировать CocoIndex, его persistent engine или новый универсальный fingerprint registry.

## DOCS и результат

В ER-38 и §19.10 различить planned/uploaded/completed/readback/active; исправить §148 внешнего аудита. В production readiness записать проверенный native item envelope и единицы лимитов. Исторические receipts/миграции не переписывать.

Результат: admitted source проходит уже существующий pipeline; после перезапуска не теряется учёт завершённых items; metadata-compatible response не даёт ложную деградацию; partial B не обслуживает запросы. R02/#242 владеет query/ranking, #320 — scope filter. G3 folder layout, новый embedding model и multi-instance fan-out в этот срез НЕ входят.

## Приёмка и проверки

До реализации все пункты PENDING. Code-first: scoped `tsc -b` для cloudflare-projection/cloudflare-ai и ESLint изменённых файлов; при SQL — `pnpm d1:depth`. После assembly расширить существующий `packages/cloudflare-projection/src/managed-index.test.ts` и native projection fixtures: metadata+recognized built-ins; key 128/129; invalid последнего item до любых calls; первый upload сохранён/следующий упал; lost ACK; changed bytes under same name; duplicate/foreign source; generation rotation/purge; A→B→rollback. Нативные проверки выполняются отдельно в разрешённом scope, не через скрытый remote binding локальных тестов.

Не заявлять runtime PASS, performance improvement или LIVE_QUALIFIED по этому Markdown. Один integrator владеет adapter/types/receipts; другие агенты не редактируют эти общие файлы параллельно. Новые обсуждения, provider calls, deployment и backup не создаются.
