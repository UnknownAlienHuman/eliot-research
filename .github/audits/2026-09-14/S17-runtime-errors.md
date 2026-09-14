# S17 — различать причины runtime-отказа Research

База `a2aca127`; F13. Не дубликат S02: там test harness, здесь production error mapping.

## 1. Суть
Semantic configuration/currentness helpers сводят разные ошибки к WORKFLOW_AUTHORITY_STALE; другие wrappers теряют первоначальный cause. В live-журнале первоначальный OUTPUT_CORRUPT позднее выглядел как budget stop. Агент чинит не ту причину.

## 2. Что сделать
Сохранить исходный тип/этап ошибки на пути semantic preparation → Workflow → status response. Отличать malformed configuration, missing credential, expired proof, real revoke, transient I/O и corrupt output, используя существующие error families.

## 3. Документация
[Execution contract §5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).
```sh
git grep -n -F '## 5. What a good result is' -- docs/implementation/launch-prs/execution-contract.md
git grep -n -F 'configurationMissing' -- apps/eliotr-core/src/research-semantic-server.ts
git grep -n -F 'void message' -- apps/eliotr-core/src
```

## 4. Как сделать
Исправить узкий error mapping, не добавлять logger/framework или отдельный каталог сотен кодов. Сохранять первую failure reason для конкретной attempt; вторичные ошибки записывать как последствия, не замену. Наружу отдавать безопасные code/stage/trace_id и действие восстановления; secret values, provider payload и source text не выводить. Секрет можно назвать по имени переменной, но не показывать значение. Retryability отражает реальную безопасность повтора.

## 5. Критерии выполнения
- Изолированные injections перечисленных причин дают различимые безопасные результаты.
- Первоначальный corrupt-output не превращается в budget failure при повторном чтении статуса.
- Нет секретов/source body в message/cause/log/HTTP.
- Fail-closed и UNKNOWN semantics сохранены; public CompletionDisposition не расширен.
- Tests на реальном caller chain, exact SHA и before/after.
