# S11 — machine query → run → status через существующий API

База `a2aca127`; F09. Настоящая зависимость: project-scoped authorization S10 / #202. Не ждать остальных тем проекта.

## 1. Суть
Таблица ROUTES обещает owner_or_service для query/run, но `requireOwner` и semantic-server composition отказывают trusted_agent. Одного изменения labels маршрута недостаточно.

## 2. Что сделать
Подключить S10 к существующим POST query/run и GET run-status. В этом PR завершить запуск/наблюдение, без артефактного reader и MCP.

## 3. Документация
[Канон §0, §7.7.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'Trusted agents and optional client adapters use the direct semantic API.' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'requireOwner' -- apps/eliotr-core/src/research-session.ts
```

## 4. Как сделать
Пройти actual HTTP → scope/orientation → semantic preparation → Workflow: в нужных местах использовать одно решение S10, а не копировать owner checks. Scope, operation attribution и spend policy должны соответствовать настоящему service principal. Сохранить существующие QueryRequest, idempotency и budget contracts; новые поля добавлять только при реальной необходимости и с совместимостью. Не писать второй research engine и не запускать браузер.

## 5. Критерии выполнения
- Service token с проектным разрешением выполняет query, запускает run и получает status/operation ID через HTTP.
- Повторный POST сохраняет один run; несовпавший input даёт conflict.
- За пределами проекта/бюджета, при revoke и неверной identity нет модельных вызовов.
- Owner flow проходит прежние тесты; проверки не сводятся к подставленному owner_pwa context.
- End-to-end клиент без cookies/DOM проходит на локальном Worker/D1/R2 с явно контролируемым внешним provider; results/SHA приложены.
