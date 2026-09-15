# S98 — агент добавляет источник без браузера и без Google

База a2aca127; ER-24/29/14. Дополняет #202/#223 и #203–#205. #250 — Workspace-specific candidate admission, не обычный machine ingest. Existing normalized-bundle routes уже owner_or_service; raw-file capture остаётся отдельным owner-путём.

## 1. Суть
Read/query/run/report API не завершает headless lifecycle, если новый источник агент может добавить только через owner browser или ручной SQL. При этом Research grant не должен автоматически давать source write.

## 2. Что сделать
Замкнуть существующий normalized-bundle discover/prepare/part upload/file complete/commit/status/recovery через явно делегированный service principal и разрешённый source namespace. Не добавлять второй uploader/protocol, не открывать raw owner endpoints простой заменой роли.

## 3. Документация / grep
[Канон: trusted agents](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [маршруты](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/interfaces/src/routes.ts), [ER-29](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-29-source-acquisition-admission-and-qualification.md).
```sh
git grep -n -F '/api/v1/ingest/bundles/prepare' -- packages/interfaces/src/routes.ts
```

## 4. Как сделать
Расширить один выбранный в S10 `project_client_grant`: отдельная operation `ingest.bundle` и explicit `ingest_namespace_ids`, по умолчанию пустой набор. Owner CRUD S31 валидирует grantor как действующего разрешённого writer каждого namespace; project read membership не выдаёт такое право. Grant/namespace policy/current ownership перепроверяются до upload и перед canonical commit. Действительный actor остаётся service, исходный mutable owner/receipt lineage сохраняются; delegate не становится новым owner. Подготовленный normalized bundle проходит existing admission/quality/residency, external или offline preprocessing не подтверждает его автоматически. Idempotency связывает namespace/revision/bytes; partial uploads и lost ACK восстанавливаются по прежним operation/part IDs. При привязке нового source к проекту использовать существующий authorized membership/CAS path, не имплицитный side effect по названию grant. Если нужен отдельный project.attach permission — явно добавить в тот же grant и проверить owner ceiling, без общего административного доступа. Тонкий HTTP/MCP client только вызывает existing services, не меняет D1 напрямую.

## 5. Критерии выполнения
- Новый service без browser cookies/Google добавляет разрешённый bundle, получает ровно одну admitted revision/outbox и затем разрешённые query/run/citation через тот же проектный lifecycle.
- Read-only grant, другой namespace, changed owner, revoke во время upload, wrong digest/map/retention и stale target revision не дают canonical commit.
- Resume/replay не дублируют source/parts/outbox; незавершённые staging bytes не становятся model context.
- Actual HTTP/D1/R2 integration тест использует grant, выданный owner API, не preseeded success; old owner ingress не регрессирует. Пример client requests, exact SHA и результаты. Paid preprocessing и source-owner cutover не разрешаются этим grant автоматически.
