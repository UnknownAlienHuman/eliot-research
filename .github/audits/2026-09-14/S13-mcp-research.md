# S13 — тонкие Research tools в существующем MCP

База `a2aca127`; F09. Зависимости: S11/#203 и S12/#204 для рабочего service API.

## 1. Суть
Текущий MCP предоставляет статус/диагностику и Google candidate plans, но не сквозное исследование. Проверка связи не означает возможность работать с корпусом.

## 2. Что сделать
Добавить минимальные адаптеры для разрешённого каталога проекта, query/run/status и чтения результата/цитаты. Это представление существующих операций, не второй backend и не новый transport service.

## 3. Документация
[Канон §1.1 и §0](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
[ADR-0006](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/adr/0006-google-external-transport-profiles.md).
```sh
git grep -n -F 'private agent MCP' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'GEMINI_MCP_TOOLS' -- packages/cloudflare-workspace-mcp/src
```

## 4. Как сделать
Использовать existing JSON-RPC dispatcher и проверенный actor context; связать handlers с теми же application services, что HTTP. Длинный run возвращает handle, status читается отдельно. Каталог должен использовать разрешённый scope вместо обхода `MCP_CATALOG_SCOPE_REQUIRED`. Google candidate semantics не менять. Имена/схемы новых tools зафиксировать один раз в существующем контракте, annotations выставить по реальным эффектам.

## 5. Критерии выполнения
- initialize → tools/list → scoped catalog → run → status → report → citation проходит headless.
- HTTP/MCP дают одинаковые durable IDs, hashes и dispositions для одного запроса.
- read-only tools не запускают модель; run не объявлен readOnly; malformed/foreign/revoked input отказан.
- Повтор после потери ответа не создаёт второй run.
- Один MCP, никаких browser cookies или provider keys у клиента; exact tests/SHA и примеры запросов без секретов.
