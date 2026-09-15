# S80 — Rust family: scope algebra и currentness

База a2aca127; ER-30/02/40. Использовать существующую scope identity parity, S78/#270 и принятые изменения #200/#202/#225. Target `eliotr-scope`; TS остаётся владельцем D1 enumeration/grant writes.

## 1. Суть
K2a проверяет serialization snapshot identity, но не algebra, membership resolution и authorization currentness. Устранение JWT-проблем не даёт права расширить frozen scope.

## 2. Что сделать
Перенести чистую нормализацию UNION/INTERSECT/EXCEPT, ordered member resolution и сравнение explicit currentness facts. На входе факты atoms, revisions, ownership, policy closure, purge и observed time; на выходе typed members/digests/denial, без доступа к DB.

## 3. Документация / grep
[Launch09](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md), [Language §5/§8.3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F 'K3.scope algebra/snapshot' -- docs/implementation/launch-prs/09-rust.md
```

## 4. Как сделать
Переиспользовать admitted scope schemas/vector corpus; global/project/source atoms имеют явные authorization observations. Canonical duplicate/order rules взять из актуального domain, не из порядка SQL-возврата. Шардинг/ограничения сериализации не должны silently отбрасывать members. Currentness для historical read и active execution различается по уже принятому контракту: не откатить #197/#198/#199/#225. Проверять все atoms до выдачи scope, preserving original frozen source refs. Snapshot/grant lifecycle и transactional checks остаются в TS/D1.

## 5. Критерии выполнения
- TS/native/Wasm совпадают для nested algebra, empty sets, duplicates/permutations, shared source, forbidden atom, membership/policy/purge changes и исторического scope.
- Changed scope под прежним request identity отклоняется; неизвестный/частичный member set не становится complete.
- Property tests algebra laws и negative mutation на EXCEPT/intersection/security closure обнаруживают регрессии.
- No I/O/hidden clock/whole-corpus unbounded load; existing Rust gates и actual D1 caller integration при S89. Exact SHA/fixtures/results.
