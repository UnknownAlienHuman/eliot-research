# S14 — публичная отмена обычного Research run

База `a2aca127`; F10. Не путать с уже существующей отменой EXHAUSTIVE_JOB и отдельным внутренним DO endpoint.

## 1. Суть
Обычный research.run имеет запуск и status, но не завершённый публичный cancel lifecycle. Человек/агент должен остановить лишнюю работу, не удаляя вкладку и не правя D1.

## 2. Что сделать
Добавить одну cancel-операцию к существующему run API и использовать каноническую W2 cancellation. Сначала owner HTTP; машинный authorizer S10 подключается тем же helper, без второго механизма.

## 3. Документация
[Канон §7.7.2, §7.11](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'Each stage checks cancellation and budget' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 7.11. Terminal dispositions and reopen' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
В ROUTES, HTTP и existing research service согласовать один proposed cancel endpoint; переиспользовать WorkflowCheckpointStore/monotone executor. Durable cancel фиксируется прежде успешного ответа. Native Workflow stop — дополнительный механизм, не источник истины. При потерянном ACK делать readback по прежнему operation ID. In-flight provider result можно сохранить как результат попытки, но нельзя запускать новые стадии/публиковать отменённую работу.

## 5. Критерии выполнения
- Cancel до старта, между стадиями и во время model I/O прекращает дальнейшие эффекты.
- Повторная отмена возвращает тот же durable outcome; restart сохраняет отмену.
- Поздний completion не снимает CANCELLED; гонка с уже завершённым run разрешается по persisted state.
- Чужая/неавторизованная отмена не меняет данные.
- Потерянное подтверждение не выдаётся за успех до readback; HTTP/D1/R2 tests и exact SHA сохранены.
