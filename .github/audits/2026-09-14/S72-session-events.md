# S72 — durable progress, WebSocket reconnect и hibernation

База a2aca127; ER-09/24/25. Existing ResearchSession — presentation, не второй исполнитель. Исправление DO cancellation S16/#208 и run authorizer #198/#202 переиспользуются.

## 1. Суть
Внутренний DO возвращает SESSION_WEBSOCKET_PENDING. Status polling не доказывает предусмотренные persist-before-notify, hibernation и восстановление cursor при смене клиента.

## 2. Что сделать
Завершить bounded events transport над D1 checkpoints/change events. Предлагаемый публичный вход: `GET /api/v1/research/run/:workflow_id/events` с WebSocket Upgrade и optional after-cursor; если совместимый маршрут уже добавлен, использовать его, не создавать второй. Обычный status GET остаётся fallback.

## 3. Документация / grep
[Канон §7.7.1](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '### 7.7.1. ResearchSession Durable Object' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Route key = verified principal + investigation/run; при подключении и выдаче проверять текущую read authority, не query-string bearer. Event frame содержит existing operation/sequence/stage/state и refs, не полные source/model bodies. Источник replay — существующие D1 checkpoints/change receipts; outbox ускоряет уведомление после commit. Cursor связывается с principal/run/authorized scope; expired cursor требует explicit resync. DO хранит только connections/cursors/pending approvals. Применить native hibernation API закреплённого runtime, без своего WS broker. Slow consumer получает resync/закрытие по existing envelope, не неограниченную очередь. Новая авторизованная сессия продолжает историю через текущий grant, а revoke закрывает поток.

## 5. Критерии выполнения
- Disconnect/eviction/restart/lost notification → replay всех committed событий в порядке; повторённое событие безопасно, не новый run.
- До D1 commit события нет; late notification не отменяет CANCELLED и не раскрывает revoked данные.
- Foreign/stale cursor отказан; hibernation не теряет knowledge state; frame≤64KiB и live DO state≤256KiB по канону.
- PWA и headless client сходятся к status API; local Worker/DO tests и отдельный actual hibernation receipt, exact SHA.
