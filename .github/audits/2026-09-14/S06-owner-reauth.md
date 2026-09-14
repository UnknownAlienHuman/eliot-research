# S06 — читать свои исследования после повторного входа

База `a2aca127`; F02. Независимо от S05: здесь меняется JWT, а deployment остаётся прежним.

## 1. Суть
Access возвращает credential_generation с kid/iat. `readResearchRunStatus` передаёт новый credential в `loadHeldResearchScope`, хотя run хранит прежний. Новая сессия того же principal не должна превращать его историю в чужую. Сам факт выдачи JWT не удаляет строку SQL view — не воспроизводить эту ошибочную формулировку аудита.

## 2. Что сделать
Обеспечить чтение статуса и истории собственного run через новый валидный owner-сеанс. Отделить текущий read grant от неизменяемой execution provenance. Не менять всю систему JWT и не переписывать старые receipts.

## 3. Документация
[ELIOT_RESEARCH §7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'The Investigation survives' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'readResearchRunStatus' -- apps/eliotr-core/src/research-session.ts
git grep -n -F 'reauthorizeOwnerHistoricalScope' -- packages/cloudflare-navigation/src
```

## 4. Как сделать
В status/history readers использовать проверенную текущую identity/policy и существующий reauthorization механизм. Original run credential сохранять как provenance; новый запрос не получает права только по совпадению ID. Проверить тот же principal с другим iat/kid, другой principal и явно REVOKED grant. Не увеличивать TTL для маскировки причины, не делать credential_generation постоянной строкой и не вычищать fencing из SQL.

## 5. Критерии выполнения
- Два валидных owner JWT одного principal читают тот же run и checkpoints.
- Foreign principal, просроченный JWT и действующий revoke отказаны без раскрытия данных.
- Reauthorization не вызывает модель, не создаёт второй run и не меняет старые hashes.
- Доступность истории не требует ручного SQL или продления срока через UI.
- Есть integration regression текущего status/history HTTP с D1 и exact SHA/результаты.
