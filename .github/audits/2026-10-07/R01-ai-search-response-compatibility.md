# R01 — Совместимость текстового ответа AI Search

**Тип:** исполнимое задание; этот commit меняет только документацию, не runtime.
**База проверки:** `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`, 2026-10-07.
**Результат реализации:** документированный текстовый ответ принимается без ослабления evidence boundary.

## Читать

- [AGENTS — Non-negotiable boundaries](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/AGENTS.md#non-negotiable-boundaries): строгие публичные контракты, locator не evidence.
- [Cloudflare Search Workers binding — search(), Response](https://developers.cloudflare.com/ai-search/api/search/workers-binding/#search): `query_kind` описывает модальность запроса; это не retrieval mode и не признак качества результата. Документация проверена 2026-10-07, дата страницы 2026-10-01.
- [Текущий decoder](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/platform-cloudflare/src/ai-search.ts): `RESULT_KEYS`, `decodeAiSearchSearchResult`, `exactObject`.
- [Существующие negative fixtures](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/infra/ai-search/ai-search-locator.test.mjs): сохранить все проверки, не переписывать их в позитивные.

## Подтверждённая проблема

Decoder допускает только `chunks` и `search_query` на верхнем уровне. Документированный ответ с `query_kind: text` отвергается до разбора chunks. Это воспроизводимая несовместимость формы ответа; наблюдение такого отказа в production не получено.

## Изменить CODE

1. В `packages/platform-cloudflare/src/ai-search.ts` явно разрешить только документированный discriminator для текущего text-only adapter. Отсутствующее поле допускается для прежних текстовых ответов; присутствующее поле должно иметь значение `text`.
2. `image`, `multimodal`, неизвестные и некорректные значения не становятся текстом по умолчанию. Не включать multimodal endpoint и не менять запросы.
3. Сохранить strict unknown-field rejection на остальных полях, полный source revision/scope/generation/digest/taint validation, byte/cardinality bounds и `UNRESOLVED_LOCATOR`.
4. Добавить узкие случаи к существующей locator-проверке либо отдельному соседнему `infra/ai-search/ai-search-query-kind.test.mjs`. Не создавать новый test framework.

## Изменить DOCS

В ближайшем описании AI Search adapter указать две принимаемые текстовые формы и отсутствие multimodal qualification. Не менять готовность всего RETRIEVAL и не объявлять `LIVE_QUALIFIED`.

## Что брать у донора

Донор — официальный Cloudflare wire contract, не новая библиотека. Переиспользовать существующие `exactObject`, `fail`, `decodeUnresolvedLocatorCandidates`. Не заменять strict decoder на `passthrough`, не переносить provider fields в canonical evidence автоматически.

## Приёмка

- Старый и новый текстовый envelope дают одинаковые locators, включая пустую выдачу.
- Present null/undefined/image/multimodal/unknown discriminator отклоняется; неизвестные authority-shaped поля по-прежнему отклоняются.
- Foreign scope, wrong generation, неверный digest, oversized preview, duplicate chunk остаются отрицательными случаями.
- Изменение не выполняет Search, не меняет схемы D1, сохранённые IDs, модель, retry или #320 prefilter.

## Проверка и границы публикации

Сначала `pnpm exec tsc -b packages/platform-cloudflare/tsconfig.json --pretty false` и scoped ESLint изменённых файлов, согласно [scoped-verification.md](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/docs/implementation/scoped-verification.md). Узкая регрессия исполняется на этапе приёмки; полные suites не запускать автоматически.

Подготовленный локально patch был проверен Node 22.16.0 / TypeScript 5.8.3: 16 envelope-сценариев, до исправления 15/16, после 16/16. Downstream decoder в этом envelope-прогоне не вызывался; это не полный locator/Vitest/workerd PASS. Workspace compiler, ESLint, Vitest и native provider проверка остаются PENDING.

Запись runtime patch через GitHub-инструмент была заблокирована. В этой ветке опубликовано только задание; внесение кода не заявляется. Документационный PR нельзя засчитать как исправление production.

**Связи:** независим от #320; не заменяет его scope filter. Последующее managed hybrid wiring относится к #242. Main, deployment, реальные provider calls и удаление данных не входят в задание.
