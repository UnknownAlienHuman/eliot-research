# S84 — Rust family: exact evidence и coverage

База a2aca127; ER-07/10/39/40. Targets `eliotr-evidence` и `eliotr-coverage`; identity/scope из #270/#272. Фактические чтения R2 и текущая авторизация остаются TS adapters.

## 1. Суть
Результат поиска — locator, не proof. Migration должна сохранить привязку EvidenceHandle к точным admitted bytes и различие complete/sampled/unknown denominator; нельзя «исправлять» честный INCOMPLETE_COVERAGE на успех.

## 2. Что сделать
Перенести pure invariants resolution (revision/owner/scope/purge/map/range/length/digest) и детерминированное вычисление coverage/absence/disposition из наблюдённых verified facts. Не переносить внешний resolver I/O и не генерировать новые citation IDs в модели.

## 3. Документация / grep
[Канон§6.10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [Launch09 K4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md).
```sh
git grep -n -F 'Only `NO_MATCH_IN_COMPLETE_SCOPE` permits a scoped absence claim.' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Existing handle/coverage schemas и actual TS decisions — единственный reference до promotion. Вход фиксирует источник наблюдений, not caller-supplied success booleans: TS выполняет fetch/currentness и передаёт validated facts, Rust проверяет invariants. Preserve eligible/represented/cited/omitted sets, independence/family и failed/skipped lanes. Полное отсутствие допускается только после reconciled exhaustive denominator; no-hit/relevant-answer/sample — разные вещи. Unknown denominator не запрещает каждый узкий supported answer автоматически, но запрещает полный absence claim. Retention/purge во время read проверяются снова в adapter перед disclosure. Существующие девять CompletionDisposition не расширять.

## 5. Критерии выполнения
- TS/native/Wasm результаты/typed errors совпадают на exact Unicode/table/range positives и corrupt/foreign/stale/purged negatives.
- Missing/duplicate shard, omitted member, unknown denominator и source-family duplication не дают ложной полноты/независимости.
- Accepted citation invariants не ослаблены; mutation подмены hash/range/count/denominator обнаруживается.
- Real resolver/exhaustive caller tests #240/#243 продолжают проходить, pure Rust gates/SHA и shared fixtures сохранены. Promotion только после S88/S89.
