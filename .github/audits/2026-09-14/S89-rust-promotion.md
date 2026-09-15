# S89 — M6/M7: включить проверенные Rust families и удалить дубли authority

База a2aca127; ER-40/24/00. Inputs: S88/#280 и отдельная проверенная family S78–S87. Каждая family переключается отдельным малым implementation checkpoint; не один массовый rewrite. Непроверенные families не переключаются вслед за первой.

## 1. Суть
Ни CI Wasm, ни shadow сами по себе не выполняют binding decision. После promotion недопустимы две независимые production decisions или тихий возврат к более permissive TS.

## 2. Что сделать
Для всех обязательных production-critical families последовательно завершить M5 evidence→M6 caller switch→M7 removal. Сохранить reference fixtures, но убрать заменённые TS production implementations и избыточные wrappers. Existing Launch09 содержит единственную family status таблицу.

## 3. Документация / grep
[Language§10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), [Launch09 K6/K7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md).
```sh
git grep -n -F 'K6 — controlled per-family Rust promotion.' -- docs/implementation/launch-prs/09-rust.md
```

## 4. Как сделать
До switch сохранить exact native/Wasm/Worker/parity/property/mutation evidence, ABI/family generation, measured size/memory/CPU и rollback build. Подключить Rust result в действительный TS caller; TS может раньше отказать malformed/oversized wire input, не независимо решать домен. При trap/version mismatch affected operation fail-closed, no hidden TS fallback. SQL currentness/CAS и external effect discipline неизменны. Первое переключение без доказанной active-run compatibility делать после штатного завершения/паузы затронутых runs, не их удаления; supported old→new continuation отдельно доказывается по #197/#259. History/readers читают прежние canonical bytes. После положительной проверки с отключённым старым TS decision удалить его и проверить снова. Обновить existing registry/gap/Launch09 по каждой family, не одним общим Rust=true.

## 5. Критерии выполнения
- Все обязательные named families из Language/Launch09 имеют один фактический runtime owner и link caller→compiled module→receipt; CI-only реализация не засчитана.
- Promoted paths исполняются без старого TS decision; отрицательная mutation Rust обнаруживается actual caller test. Reference fixtures не являются вторым production owner.
- Wrong ABI/trap/rollback/revoke/purge/replay не усиливают authority, не меняют старые hashes и не повторяют paid effects.
- Rust deep gates (включая #176), actual Worker/browser/headless regression и измеренные bundle/startup/CPU проходят; exact SHA per family. Не подменять производительность процентом языка.
