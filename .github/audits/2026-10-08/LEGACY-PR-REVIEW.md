# Проверка старых PR: текущие задания и конкретные доноры

Дата 2026-10-08. Проверенный source baseline: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`.
Это продолжение REPAIR-SERIES.md, не второй execution plan и не поставка runtime. Доработаны шесть существующих draft-заданий. Отдельно просмотрены closed/unmerged #243/#245; их статус не доказывает ни отсутствие реализации, ни её готовность.

## 1. Текущая карта

| PR | Конкретный результат задания | Что не делать |
|---|---|---|
| #231 S39/R07 | Native websearch → existing capture/conversion/admission; bounded decoder, truthful provider facts и unknown effects | Второй crawler/SDK или автоматическая повторная оплата после abort |
| #244 S52 | Existing Items adapter: metadata/name preflight, per-item resume/readback, promotion | Новый индексатор; upsert как бесплатный exactly-once |
| #282 S90 | Native emitted Worker/PWA metrics, source counters advisory | Оценивать deployment size по исходникам или сумме gzip файлов |
| #268 S76 | После S90 A/B — pinned formatter и механический diff с неизменными literals/SQL | Смешивать formatting и authority/retry fixes |
| #267 S75 | Existing report reader: bounded on-demand loading, view lifecycle, точные citations/export, честное regenerate/edit различие | Переписывать готовые read/accept/COW; постоянный permission cache |
| #291 S99 | Сохранить существующий полный scope; исправить observed-work trace и отдельно проверить managed capacity | Повторный freezer; заменить все 64 на 4096; silent truncation |
| #243 S51 | Closed/unmerged; статус просмотрен, не переоткрывался | Выводить полную готовность exhaustive из closed |
| #245 S53 | Closed/unmerged; COW/product implementation найден, не переоткрывался | Писать второй report engine |

У #267 на свежем чтении mergeable=true; прежнее наблюдение false было моментальным состоянием GitHub, не текущим blocker. В этом проходе его конфликт не разрешался и branch history не переписывалась. Предыдущие non-forced согласования #244/#268 относятся к прошлому checkpoint.

## 2. Паспорта — что читать, какие функции менять и чем принимать

- [S39/R07 native websearch](https://github.com/UnknownAlienHuman/eliot-research/blob/c961638a7ef1ba0be4b49b4dccfa27d70c7f8227/.github/audits/2026-10-08/S39-websearch-native-boundary.md).
- [S52 Items reconciliation](https://github.com/UnknownAlienHuman/eliot-research/blob/0018b1aee9c317f4b36ba2fae78797cd43818780/.github/audits/2026-10-08/S52-items-reconciliation.md).
- [S90 emitted budgets](https://github.com/UnknownAlienHuman/eliot-research/blob/dc8cf19d26f0e4216c874c51b8663f8c5db57768/.github/audits/2026-10-08/S90-artifact-budget-gates.md).
- [S76 mechanical formatting](https://github.com/UnknownAlienHuman/eliot-research/blob/f1cecf2a8df532e93c8573cb657d750d6a1585f5/.github/audits/2026-10-08/S76-mechanical-formatting.md).
- [S75 report lifecycle](https://github.com/UnknownAlienHuman/eliot-research/blob/c498e3cac61ddd4505cf4297c7ee6acd28c2392d/.github/audits/2026-10-08/S75-report-view-lifecycle.md).
- [S99 scope/accounting/capacity](https://github.com/UnknownAlienHuman/eliot-research/blob/71e282abf6eb4aa08155a0c802bc9ace7bab4ee8/.github/audits/2026-10-08/S99-scope-accounting-and-capacity.md).

Каждый паспорт сохраняет первоначальные S-критерии, даёт CODE/DOCS paths, existing vs proposed functions, donor links, compatibility и negative acceptance. Старые паспорта остаются в ветках; новое описание не выдаёт их за исправленный runtime. [Предыдущая редакция review](https://github.com/UnknownAlienHuman/eliot-research/blob/8ebece59ac933e40f23b3f7c8a9557d7a02b2efd/.github/audits/2026-10-08/LEGACY-PR-REVIEW.md) сохраняет подробности первого прохода.

## 3. Новое по #267 и #291

**Report preview.** `renderResearchArtifactReport` заранее последовательно читает первые 32 секции; это не viewport loading и не общий предел отчёта. Каждый read входит в общий busy/action controller. Требуется view-local demand loading; manual open за пределами preview остаётся. Экспорт по-прежнему проверяет все секции, а не только загруженные на экран. [Код](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/pwa-research-workspace/src/research-run-report.ts).

**Revise != свободный редактор.** `reviseArtifactSection` посылает protocol/expected revision, без текста инструкции. `mutationKey` привязан к artifact/section; его нельзя заменять random key на retry. Wiki `mountWikiEditForm` уже создаёт отдельный DRAFT. [API](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/pwa-research-workspace/src/artifact-product-api.ts), [server decoder](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-artifacts/src/artifact-product-input.ts). Свободный report editing не считать выполненным по смене кнопки.

**Scope уже полный.** `createOrientationApi` сохраняет whole execution snapshot до 4096 metadata; `.slice(0,64)` касается preview. `loadResearchPlanningSources` проходит весь исходный набор через bounded batches. Не переписывать freezer. [Profile](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-navigation/src/owner-scope-profile.ts), [admission/planning](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-research-runtime/src/research-run-admission.ts).

**Trace преувеличивает candidates.** В ORIENT SOURCECARD count равен full snapshot, хотя `orient` отбирает bounded candidateSources. Для 299 members/16 output/no Atlas это 299 в trace против 64 выбранных. Считать work у фактического producer и передавать private immutable stats; не копировать алгоритм в caller. Сохранить denominator, full omitted count и truncated sample. [Caller](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-navigation/src/orientation-service.ts), [selection](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-navigation/src/navigation-service.ts#L336-L453).

**Scope cap != retrieval acceptance.** Сохранённые 4096 refs не доказывают представимость filter #320 или качество #242. Ни UI preview, ни arbitrary truncation не решают large managed scope. Исходные 65/299/tail/history acceptance сохраняются отдельно от metadata freeze.

## 4. Доноры: конкретно что брать

| Код | Брать | Не брать |
|---|---|---|
| [TanStack Query.fetch/cancel/destroy](https://github.com/TanStack/query/blob/aab352876a01f76fd0e00b0b500a85907ec7c8b4/packages/query-core/src/query.ts#L683-L865) | In-flight Promise reuse по identity, consumed AbortSignal и lifecycle | React/runtime целиком, retries мутаций, восстановление private stale data |
| [IntersectionObserver](https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver) | Один observe/unobserve/disconnect на report view | Полный virtualizer или измерение visibility как evidence authority |
| [Eliot mountWikiEditForm](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/apps/eliotr-pwa/src/wiki-edit-form.ts) | Новый DRAFT + exact readback + отдельная publication | Transient attempt key как гарантию replay после reload |
| [Eliot scope/planning readers](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-research-runtime/src/research-run-admission.ts) | Exact requested-set reconciliation и bounded json_each batches | Тысячи SQL placeholders, wholesale body buffering, новый scope service |

Существующие Cloudflare Items/Web Search/getSize, CocoIndex fingerprints и Prettier решения подробно закреплены в соответствующих паспортах. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) ограничивают bind parameters и work, но `json_each(?1)` уже использует один JSON bind, не один bind на source. [TanStack cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation) по умолчанию может сохранить неиспользованный result и вернуть прежнее состояние; не копировать это после Eliot authority loss. Upstream source read не является deploy/CI/benchmark qualification донора для Eliot.

## 5. Порядок, доказательства и неизменённые границы

R00–R05 остаются первым ремонтом research path. #267 A/B независимы от managed rewrite и AIChatAgent; shared UI lifecycle меняет один integrator. #291 использует существующий scope, а #242/#320 владеют managed query/profile. #282 A/B → #268 остаётся прежней зависимостью. Не добавлять G3, GraphRAG, NotebookProject v2, K2/Basin или Rust rewrite как обязательный blocker этих исправлений.

Проверены source paths, точные функции и donor source, сохранены два новых паспорта и обновлены PR bodies. Product code, SQL, main и production не менялись; tests/compiler/browser/native/cost не запускались. Будущая code-first проверка: scoped compilation/ESLint; SQL depth-100 и minimal Clippy только для соответствующих изменений. Остальная приёмка после assembly, PENDING. Не создавались issues/discussions/comments, force pushes, deployment, paid calls или backup. Клиентская отмена ожидания не объявляется rollback.
