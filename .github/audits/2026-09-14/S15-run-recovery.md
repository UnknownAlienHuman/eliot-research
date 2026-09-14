# S15 — восстановить тот же run после временного отказа чтения

База кода `a2aca1277b0edbbed04de66e0d44e383e1b815ef`; F10/F11. Исправление задания от 2026-09-14: запрещаются повторные платные эффекты завершённых этапов, а не первый вызов ещё не выполненного AUDIT_CLAIMS. Это одно восстановление, не новый retry engine.

## 1. Суть
Стандартные стадии используют retries.limit=0. Нельзя включать слепой повтор неизвестного платного эффекта, но восстановимый отказ чтения после сохранённого SYNTHESIZE не должен заставлять создавать новое исследование. После VERIFY существует самостоятельный платный AUDIT_CLAIMS, поэтому прежний критерий «общее число платных попыток не меняется» был неверен.

## 2. Что сделать
Восстановить один существующий run: SYNTHESIZE уже committed, следующий VERIFY прерван временной ошибкой чтения. Дойти до законного terminal outcome через неизменённые operation ID, frozen inputs и канонические D1/R2 checkpoints. Штатный первый AUDIT_CLAIMS выполнить под его собственной бюджетной и idempotency authority; уже выполненный этап не вызывать повторно.

## 3. Документация и точные ориентиры
[Канон §7.7.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [Execution contract §3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).

[Реальная stage factory](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/apps/eliotr-core/src/research-stage-handlers.ts) отдельно собирает SYNTHESIZE, VERIFY и AUDIT_CLAIMS. [Audit handler](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/cloudflare-research-stages/src/research-claim-audit-stage-handler.ts) использует operation_kind AUDIT.

```sh
git grep -n -F 'A lost ACK is UNKNOWN' -- docs/implementation/launch-prs/execution-contract.md
git grep -n -F 'recoverStartedAttempt' -- apps/eliotr-core/src packages/cloudflare-research/src packages/cloudflare-research-stages/src
```

Актуальная внешняя справка, проверена 2026-09-14: [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/), [Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/). `resume()` относится к paused instance; обычный `restart()` сбрасывает промежуточное native state, тогда как документированный restart from step переиспользует результаты предыдущих шагов. Наличие конкретной формы API проверить по закреплённым в репозитории типам и runtime, а не только по свежей документации.

## 4. Как сделать
Переиспользовать W2/W3 readback и recoverStartedAttempt. Различить safe read retry, committed-output recovery и UNKNOWN model effect. Выбор native restart/resume согласовать с фактическим engine status: не называть resume восстановлением errored instance без проверки. Native state не заменяет D1/R2 authority. При restart ранее committed stages обязаны восстановиться из канонических receipts без новых provider effects. Не обновлять зависимости молча ради другой формы API.

В существующем run API определить один recovery operation и его idempotent ответ; если такой маршрут отсутствует, добавить узко и документировать request/response. Не создавать replacement operation ID. Integrity/auth/cancel не считать transient. Новые последующие платные стадии допускаются только по прежним нормальным правилам policy/quote/reservation; recovery не является разрешением на расходы.

## 5. Критерии выполнения
- До инъекции сбоя в контролируемом успешном сценарии: SYNTHESIZE вызван ровно один раз и committed; AUDIT_CLAIMS ещё не вызывался. Qualification/config фиксированы, дополнительные служебные model calls исключены условиями fixture, а не скрыты из учёта.
- После recovery: тот же run доходит до законного результата; SYNTHESIZE по-прежнему вызван один раз, его operation/receipt/output hash неизменны; AUDIT_CLAIMS впервые выполняется ровно один раз с отдельной штатной reservation. Общий счётчик не обязан оставаться прежним.
- Повтор recovery после завершения, потерянный ответ и restart не создают дополнительных SYNTHESIZE/AUDIT provider calls, reservations или результатов.
- UNKNOWN provider effect не повторяется до доказуемого readback; revoke/cancel/corruption остаются отказами. Недостаточный бюджет для ещё не начатого AUDIT даёт штатный budget outcome, а не обход.
- Сохраняются persisted rows/objects и exact SHA, команды, before/after. Controlled-provider тест не объявляется живой приёмкой Cloudflare. Проверку выбранной native lifecycle-операции на разрешённом deployment указать отдельно.
