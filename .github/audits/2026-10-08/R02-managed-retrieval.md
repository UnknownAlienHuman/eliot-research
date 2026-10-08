# R02 / S50 — Один managed relevance path и bounded exact evidence

Статус: IMPLEMENTATION TASK / документационный draft. База проверки 2026-10-08: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`. [PR #242](https://github.com/UnknownAlienHuman/eliot-research/pull/242). [Исходный S50](https://github.com/UnknownAlienHuman/eliot-research/blob/043c0d94aee327eaaba59f52b22afcdf5c4027a8/.github/audits/2026-09-14/S50-locate-lanes.md) и его LOCATE/literal/structure/diversity criteria сохраняются. Не вливать старую planning-ветку как новый runtime.

## 1. Читать

- `docs/architecture/ELIOT_RESEARCH.md`, §§6.5–6.10; `docs/agent-work/ER-04-query-planner-and-fusion.md`; `docs/implementation/runtime-contract.md`, Managed retrieval.
- [Cloudflare search API](https://developers.cloudflare.com/ai-search/api/search/workers-binding/#search): instance search, parameters, response. [Hybrid](https://developers.cloudflare.com/ai-search/configuration/indexing/hybrid-search/), [filtering](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/), [reranking](https://developers.cloudflare.com/ai-search/configuration/retrieval/reranking/). API проверен 2026-10-08; binding search допускает query или messages, не оба.
- [lanes.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/retrieval/src/lanes.ts): `createSemLaneExecutor`, `executePlannedLanes`, `candidatesByLane`.
- [managed compiler](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-projection/src/ai-search-managed-read.ts): `compileAiSearchManagedSearchRequest`, `createD1BackedAiSearchManagedSearchPort`.
- [decoder](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/platform-cloudflare/src/ai-search.ts): `decodeAiSearchSearchResult`, `mapAiSearchChunkToLocator`, `selectLane`.
- [service](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/retrieval/src/service.ts): `createRetrievalQueryService`; [composition](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-research-runtime/src/research-retrieval-composition.ts): `retrieveWithHeldScope`, `selectedDocumentFallbackCandidates`.

## 2. Проблема / результат

Сейчас SEM вызывает managed.search с `[SEM]`, compiler выбирает vector-only; keyword-enabled instance сам по себе не включает hybrid. Отдельный D1 LEX плюс Eliot RRF — текущая композиция. Уже происходящий двойной provider fusion НЕ доказан: это риск наивного перехода на hybrid, если сохранить две независимые копии его contributions.

Цель для primary relevance profile: IDENT/EXACT → один scoped Cloudflare hybrid list → Eliot diversity/currentness → bounded exact resolution/backfill. D1 остаётся для exact/identifier/literal/exhaustive и явно выбранной деградации. Provider chunks не становятся evidence.

## 3. CODE: checkpoint A — договориться о входе, результате и версии

Один integrator владеет `packages/retrieval/src/ports.ts`, `query-codec.ts`, `query-persistence.ts`, `packages/contracts/src/retrieval.ts`, platform decoder и managed compiler. Новые internal types должны быть versioned и совместимы с историческими persisted results.

Managed-result envelope сохраняет actual provider query, ordered candidates, requested/observed processing и degradation. Не присваивать hybrid hit произвольный SEM/LEX как единственное происхождение; list identity и keyword/vector/rerank signals различаются. Не размножать один provider list на два голоса RRF.

Разделить четыре обязательных ограничения: provider candidate cap, exact-resolution scan cap, final evidence cap, total evidence UTF-8 cap. Дополнительный cap добавлять только при отдельной реально исполняемой фазе. Ограничения server-owned; candidate cap соблюдает native ceiling. Не менять все requested_limit константы разом.

Digest включает execution profile/generation, scope, запрос, literals/поддерживаемые negatives, policy и принятые бюджеты. Если поддержка negatives/decomposition ещё отсутствует, явно оставить gap; не заявлять сохранение отсутствующего поля. Старые hashes не пересчитывать новым codec. Тексты запросов хранятся под disclosure/retention trace, не в публичной телеметрии.

Явно задавать `retrieval_type: hybrid`, filters, reranking, query_rewrite, cache и return_on_failure policy. Для строгого research-запроса partial processing не выдавать за полный success. Requested reranking не равен observed reranking; отсутствие scoring evidence отмечается неизвестностью, а не выдуманным receipt.

## 4. CODE: checkpoint B — подключить один физический запрос

Изменить `packages/retrieval/src/lanes.ts`, `planner.ts`, `service.ts`, `fusion.ts` и названную runtime composition. Использовать существующие managed port, resolver и budget guard. Не добавлять Cloudflare SDK/provider server/BM25 engine.

Primary profile выполняет один managed hybrid call. Сохранить provider order; outer fusion применять только к действительно независимым lists с объявленной policy. `executePlannedLanes` и service не должны поддерживать два расходящихся цикла: выбрать один runner с явными budget/currentness hooks, без нового универсального pipeline framework.

`selectedDocumentFallbackCandidates` не маскируется под найденный LEX hit: убрать из primary path или вернуть как явно tagged structural fallback по выбранному product profile. Сохранить безопасный local/direct fallback, exact byte verification и original raw query. FAST_SEARCH остаётся без генерационной модели; EXHAUSTIVE не зависит от top-k.

## 5. CODE: checkpoint C — добрать допустимое evidence без unbounded scan

В `service.ts` не обрезать весь fused pool до final evidence limit перед resolution. Идти по ranked candidates до final cap или scan/bytes/deadline stop. Каждый resolve расходует scan budget; повтор одного canonical handle не считается новым evidence. Currentness проверяется на настоящих effect/read boundaries.

Known unresolvable candidate даёт точную omission reason; transient I/O и authority revoke не превращаются в no-hit. Проверять byte cap до добавления excerpt; oversized evidence не обрезать так, чтобы сломать digest. Ranked tail вне scan budget учитывается как невыполненная работа, а не «нет результатов». No-hit не означает absence в полном corpus.

Сохранить исправления #322/#323. В #320 уже предусмотрен bounded prefilter: не переписывать его параллельно, не снимать ограничения по длине ключа и filter bytes. Большой непредставимый scope — явный предел, не глобальный query, truncation или автоматический fan-out.

## 6. Доноры / DOCS

Cloudflare исполняет BM25/vector/fusion/reranking. [PaperQA2 docs.py](https://github.com/Future-House/paper-qa/blob/57e89f7223b0960d5ee5ea048c69e3c47e088572/src/paperqa/docs.py) — только идея широкого candidate pool перед дорогой обработкой evidence; не Python runtime и не provider citation authority. Exact evidence разрешает существующий Eliot resolver.

В ER-04 и архитектуре §§6.7–6.9 описать logical signals против physical calls, единицы бюджетов, provider query provenance и старые/new execution profiles. Синхронизировать runtime-contract и существующие status/gap entries в implementation commit. G3 hierarchical layout/reindex не становится blocker этой ограниченной правки.

## 7. Приёмка и порядок

Зависимости: #324 (text envelope), #320 (prefilter). A→B→C — checkpoints одного блока; не отдавать shared types трем параллельным агентам. R03/#325 разрабатывается через согласованный port, но end-to-end интеграция ждёт B/C.

- Foreign top-1 не вытесняет in-scope result; empty scope делает zero provider calls.
- В primary запросе один physical hybrid call, list не получает двойного голоса; trace сохраняет query/rank и honest degradation.
- При final limit 1, invalid top-1 и допустимом tail получается один exact handle только в пределах scan budget.
- Deadline/byte/scan exhaustion, no-hit и provider/authority failure различаются. No-hit не даёт COMPLETE_SCOPE.
- Historical same-key replay, изменённый profile, rotation/revoke/purge/cancel и malformed/unknown fields проверяются отдельно.
- Исходные LOCATE identifier/quote/vague/tail-literal/diversity/structure cases остаются; omitted required capability не маскируется успешным empty executor.

Code-first: `pnpm exec tsc -b packages/retrieval/tsconfig.json packages/cloudflare-projection/tsconfig.json packages/cloudflare-research-runtime/tsconfig.json --pretty false`, scoped ESLint затронутых files; SQL — `pnpm d1:depth`. После сборки расширить existing retrieval, managed-read и core semantic fixtures. Сейчас CODE, compilation, behavioral/native/quality — PENDING. `remote:true` использует deployed Search, не offline emulator. Нет deployment, paid calls, index promotion, backup, комментариев или изменения main.
