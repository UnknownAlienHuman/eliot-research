# S08 — исправить проверку scope при replay research.query

Перечитано на `a2aca127`, `research-session.ts:113–121`; F05. Это дефект привязки запроса, не установленная утечка: сохранённая authority дополнительно проверяется.

## 1. Суть
Replay вычисляет digest из нового query/product/limit, но берёт `scope.digest` из прежнего результата. Новая `parsed.scope_expression` в этой ветке не сравнивается. Один idempotency key может вернуть результат другого запрошенного scope.

## 2. Что сделать
Зафиксировать request identity с канонической исходной scope expression. Одинаковый запрос replay-ить; изменённый scope под тем же ключом отклонять до новых writes.

## 3. Документация
[Execution contract §3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md); [канон §6.12 Retrieval trace](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 6.12. Retrieval trace' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'retrievalRequestDigest' -- apps/eliotr-core/src/research-session.ts packages/retrieval/src/query-persistence.ts
```

## 4. Как сделать
В существующем request/result store сохранить недостающую identity либо использовать уже сохранённое однозначное поле. Не делать re-freeze только ради сравнения: timestamp создаст новый snapshot. Определить каноническую эквивалентность expression существующим scope codec. Для старых записей без достаточной identity — явная несовместимость, не догадка. Не изменять historical digests задним числом.

## 5. Критерии выполнения
- Одинаковые query/key/expression дают те же evidence/trace, без новых scope/grant/model calls.
- PROJECT A→B, selected-source замена и GLOBAL→PROJECT под тем же key дают conflict.
- Изменение query/product/limit по-прежнему обнаруживается.
- Несовместимый replay не создаёт никаких записей; текущие revoke/purge проверки остаются.
- Integration tests через реальный HTTP/D1, исправляющий SHA и before/after.
