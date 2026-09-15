# S32 — Stop/Recover доступны человеку и агенту

База a2aca127; ER-21/24/25/36. Кодовые входы: S14/#206 cancel и S15/#207 recover; MCP leg использует S13/#205. Это не зависимость от закрытия их будущих live-checks. Planning only. Уточнение: запрещаются дубли завершённых paid effects, а не первый законный AUDIT после восстановления.

## 1. Суть
Endpoint сам по себе не даёт пользователю управлять работой. Закрытие вкладки не отменяет run, а повторная кнопка Start не является Recover. Прежняя формулировка PR body «нет дополнительных model effects» была чрезмерной: после сохранённого SYNTHESIZE может потребоваться ещё не выполненный AUDIT_CLAIMS.

## 2. Что сделать
В existing research-run-panel/api добавить Stop для ACTIVE и Recover для сервером подтверждённой восстановимой failure. MCP tools eliotr_research_cancel и eliotr_research_recover делегируют тем же services; input workflow_instance_id/idempotency_key, auth не из body. REST paths и status DTO — ровно из #206/#207, не второй DO-control API.

После принятой cancellation UI показывает подтверждённый статус; при uncertain response — отдельное состояние ожидания подтверждения. Recover продолжает тот же run, а explicit reopen/новое исследование остаётся другим действием.

## 3. Документация / grep
[Канон §7.7.1–7.7.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [реальная stage factory](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/apps/eliotr-core/src/research-stage-handlers.ts).
```sh
git grep -n -F 'persist before notifying clients' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'AUDIT_CLAIMS' -- apps/eliotr-core/src/research-stage-handlers.ts
```

## 4. Как сделать
Переиспользовать existing panel lifecycle/status decoder, operation ID, action key и MCP dispatcher. Отправка действия не меняет состояние на optimistic CANCELLED. При lost response сохранить action key и выполнить status/readback; если исход не установлен, не отправлять новый Start или новый recovery с другим ключом. Double-click объединяется одной client action, но серверная идемпотентность обязательна независимо от UI.

Cancelled/integrity-failed/incompatible run не получает кнопку ложного Recover; причина и допустимый следующий шаг приходят из серверного результата, а не вычисляются по подстроке сообщения. Tool annotations не readOnly; cancellation/recovery идемпотентны в своих допустимых состояниях. Поздний status старого run или отозванной сессии не меняет текущий экран. После cancellation не утверждать, что уже отправленный provider call физически остановлен: гарантируется отсутствие новых разрешённых стадий после принятого cancel.

Счётчики effects сравнивать по операциям и стадиям. Completed SYNTHESIZE не повторяется; первый ещё не выполненный AUDIT после recovery разрешён по своей обычной policy/reservation. Нехватка бюджета на него отображается как budget outcome, а не обход проверки или fake completion. На простом status/readback число model calls не растёт.

## 5. Критерии выполнения
- PWA и MCP проходят start→stop→reload→подтверждённый CANCELLED; отправка/503/lost response сами не отображаются как подтверждённая отмена.
- Recovery fixture до сбоя: SYNTHESIZE=1 committed, AUDIT=0. После успешного восстановления: тот же run и synthesis hash, SYNTHESIZE=1, AUDIT=1. Нет требования сохранить общий счётчик вызовов неизменным.
- После завершения повтор Recover, double-click и lost response не создают дополнительных synthesis/audit attempts, reservations или новых runs.
- Read-only delegation не отменяет/восстанавливает, revoked/foreign requests отвергаются сервером; late response не восстанавливает приватный view.
- У Stop/Recover есть accessible names и различимые pending/confirmed/blocked states. Actual HTTP/D1/browser/MCP tests, exact SHA и результаты; никаких вторых control plane или client-side success fixtures.
