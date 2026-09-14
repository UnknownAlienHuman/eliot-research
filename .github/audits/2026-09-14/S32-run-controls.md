# S32 — Stop/Recover доступны человеку и агенту

База a2aca127; ER-21/24/25/36. Depends #206/#207; MCP leg после #205. Planning only.

## 1. Суть
Реализованный endpoint не завершает продукт, если PWA и MCP не могут им пользоваться. Закрытие вкладки не считается отменой.

## 2. Что сделать
В existing research-run-panel/api добавить Stop для ACTIVE и Recover только для восстановимой failure. MCP tools `eliotr_research_cancel` и `eliotr_research_recover` делегируют тем же services. Ввод tools: workflow_instance_id и idempotency_key; auth не из body. REST paths и status DTO ровно из #206/#207, не отдельные команды DO.

## 3. Документация / grep
[Канон §7.7.1–2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'persist before notifying clients' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Переиспользовать panel lifecycle/status decoder, current operation ID и MCP dispatcher. После клика показывать sending/confirmation-pending, не optimistic CANCELLED. При потере ответа сохранить key и сверить GET status; recovery не означает Start new research. Не давать Recover после CANCELLED/integrity failure. Tool annotations не readOnly; cancellation idempotent, recovery outcome определяется сервером. Поздний status старого run/сессии не меняет экран нового. Пользователю объяснить, что уже отправленный provider call может завершиться, но новая работа остановлена.

## 5. Критерии выполнения
Browser и MCP проходят start→stop→reload→CANCELLED, failed-read→recover→same result, lost-response→same action. Повтор клика не повторяет платные этапы; unauthorized operations недоступны и отвергаются сервером. У Stop/Recover есть accessible names, понятные states и нет ложного success. Exact HTTP/D1/browser/MCP tests и SHA, без второго control plane.
