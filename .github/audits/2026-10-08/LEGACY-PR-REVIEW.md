# Проверка старых PR и продолжение серии исправлений

Дата 2026-10-08. Проверенный source baseline: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`.

Это дополнение к REPAIR-SERIES.md, не новый глобальный план и не runtime delivery. Глубоко уточнены четыре старых задания; у трёх других проверены metadata/state, без заявления о полной функциональной приёмке. Новый PR не создан: использованы существующие #231/#244/#268/#282 и индекс #327. Новые обсуждения/comments отсутствуют.

## 1. Что действительно проверено/изменено

| PR | Наблюдение | Действие |
|---|---|---|
| #231 S39 | Открытый документационный draft; первичный websearch donor имеет permissive decoding и abort-only-wait semantics | Сохранён новый паспорт и уточнён body: native call, bounded parse, честные unknowns, existing capture/admission |
| #244 S52 | Открытый draft; первоначально mergeable=false; Items API уже реализован и подключён | Новый паспорт; planning branch согласована с main non-forced merge-commit; original S52 сохранён |
| #268 S76 | Открытый draft; первоначально mergeable=false; source-line hard gate конфликтует с mechanical formatting | Новый паспорт; planning branch согласована с main без переписывания истории; связь с #282 A/B |
| #282 S90 | Открытый документационный draft; есть source checker, нет его emitted measurements | Новый паспорт: использовать native Wrangler build metrics; отдельно initial PWA graph и runtime |
| #267 S75 | Открыт, draft, mergeable=false на чтении | Только status/body review. Конфликт НЕ исправлен, runtime/PWA completeness не проверена. Не объявлять готовым к merge |
| #243 S51 | Закрыт, merged=false | Не переоткрыт. Closed planning PR сам по себе не доказывает ни отсутствие кода, ни completion |
| #245 S53 | Закрыт, merged=false | Не переоткрыт. Existing artifact-product/COW exports и composition найдены; новый report engine не назначается |

Область review — эти семь старых PR, а не все открытые PR репозитория. Actual diff #244/#268 прочитан: исходный delta — Markdown-задание. После согласования product files берутся из main; поверх остаются только original task и новый passport. Это не merge runtime исправления.

## 2. Полные задания с pinned links

- [S39/R07: native websearch boundary](https://github.com/UnknownAlienHuman/eliot-research/blob/c961638a7ef1ba0be4b49b4dccfa27d70c7f8227/.github/audits/2026-10-08/S39-websearch-native-boundary.md), PR #231.
- [S52: existing Items adapter + exact resume](https://github.com/UnknownAlienHuman/eliot-research/blob/0018b1aee9c317f4b36ba2fae78797cd43818780/.github/audits/2026-10-08/S52-items-reconciliation.md), PR #244.
- [S76: mechanical formatting](https://github.com/UnknownAlienHuman/eliot-research/blob/f1cecf2a8df532e93c8573cb657d750d6a1585f5/.github/audits/2026-10-08/S76-mechanical-formatting.md), PR #268.
- [S90: emitted artifact gate](https://github.com/UnknownAlienHuman/eliot-research/blob/dc8cf19d26f0e4216c874c51b8663f8c5db57768/.github/audits/2026-10-08/S90-artifact-budget-gates.md), PR #282.

Каждый паспорт: что читать; точные существующие CODE paths/functions; новые paths явно NEW; последовательность; DOCS amendments; donor с кодом; сохранённые инварианты; проверяемый результат; pending acceptance. Архивные критерии не удалены.

## 3. Существенные исправления предыдущего аудита

**Items API не отсутствует.** v11 §148 противоречит `packages/cloudflare-projection/src/managed-index.ts` и `packages/cloudflare-ai/src/projection-execution-delivery-handler.ts`: `createManagedProjectionPort` реально вызывает uploadAndPoll и get(id).info. Править existing adapter, не создавать ещё один.

**Нельзя копировать native wrapper без анализа.** `agents/websearch/source.ts` валидирует request и держит provider на стороне host, что полезно. Но unbounded response.text, silent item drop и fabricated query/requestId/latency defaults не подходят Eliot. Abort уже dispatched binding не означает no charge/no effect. Эти границы теперь входят в #231.

**Типы и docs сверять отдельно.** Public Items table не перечисляет exact-key параметр list, но прочитанный `AiSearchListItemsParams.key` в workerd его содержит. В установленном SDK это нужно проверить, а не объявлять ни гарантированную поддержку, ни полное отсутствие. `items.get(id)` возвращает handle; `info()` выполняется отдельно. Source key и provider item ID не взаимозаменяемы.

**Hybrid correction сохраняется из R02.** В текущем path vector-only выбор не доказывает уже существующий double-provider-fusion. Двойной голос — риск наивного переключения на hybrid с сохранением независимых копий того же списка.

## 4. Краткая карта доноров

| Донор / код | Использовать | Не переносить |
|---|---|---|
| [Cloudflare AiSearchItems / AiSearchItem](https://github.com/cloudflare/workerd/blob/cb61e82b35bf4cac7fc69821743337b8ca498bd5/types/defines/ai-search.d.ts) | upload/status/info/download/exact-key lookup; правильные native shapes | Upsert как exactly-once; metadata как доказательство content bytes; permissive authority |
| [Cloudflare createAIWebSearch / abortable / readResponse](https://github.com/cloudflare/agents/blob/000d076d535b8bf53ac66b2c86c4c83c5a95d8c7/packages/agents/src/websearch/source.ts) | Один transport и host-selected provider | Unbounded body; silent drops/default facts; retryable как разрешение повторной оплаты |
| [CocoIndex entry_fingerprint / register_all_fn_logic](https://github.com/cocoindex-io/cocoindex/blob/57d92ec865c1fd2becd135559ef2d954c4721ffd/rust/sdk/cocoindex/src/logic.rs) | Связь validity с code/profile generation | Универсальный memo engine, новый registry или дублирование имеющихся Eliot identities |
| [Cloudflare getSize / printBundleSize](https://github.com/cloudflare/workers-sdk/blob/aaa6a880682fcc33a02366d7b193474f05e36717/packages/deploy-helpers/src/deploy/helpers/bundle-reporter.ts) | Native emitted module manifest и gzip всего entry+modules | Сумма gzip отдельных files; source bytes как deployment metric; private helper dependency в Worker |
| [Prettier CLI](https://prettier.io/docs/cli#--debug-check) / [embedded-language policy](https://prettier.io/docs/options#embedded-language-formatting) | Готовый parser/printer и отдельные debug/check/write шаги | Новый formatter, background agent, rewrite canonical fixtures, семантические fixes в mechanical diff |

## 5. Порядок без новых искусственных blockers

R00–R05 остаются ремонтом текущего research path. #244 adapter/readback можно готовить независимо от R03/R04; его shared provider types интегрировать последовательно с R01/R02. #231 discovery/capture можно разрабатывать отдельно, финальная цепочка использует admitted source + #244 + #242. #282 A/B → #268; full T6 не блокирует formatting. Ни G3, ни NotebookProject v2, ни graph DB, ни K2/Basin не требуются для этих исправлений.

Общие package manifests/config/lock меняет один integrator. Formatter не проходит по файлам одновременно с semantic patches. Source comments и hosted PR descriptions не являются authority release. Изменять main/deploy/paid resources этим планом не предписано.

## 6. Проверки и неизменённые границы

В этом проходе выполнено чтение кода/PR metadata и двух original patches, документации и donor source; сохранены паспорта и PR bodies; exact branch updates сделаны без force. Compilation/Vitest/workerd/provider benchmarking не запускались — product code не менялся. Нет заявлений о production-исправлении, стоимости или превосходстве доноров на нашем corpus.

После реализации: scoped compilation/ESLint; SQL depth-100 и minimal Clippy только для соответствующих изменений. Behavioral/native/quality gates остаются после assembly и помечены PENDING. Не запускать historical uncertain run и не возобновлять отменённый backup.
