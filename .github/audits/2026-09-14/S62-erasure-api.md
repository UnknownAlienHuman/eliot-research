# S62 — разрешённый запрос удаления и его durable status

База: `a2aca1277b0edbbed04de66e0d44e383e1b815ef`. ER-28/24/25. Существуют permission producer, erasure services и coordinator; их не переписывать. Это PR-задание, не выполненное удаление.

## 1. Суть
Существование erasure-кода и кнопки не доказывает полный разрешённый цикл. ERASURE объявлен disabled, реестр сохраняет незавершённое caller/coordinator wiring. Локальный запрос должен создавать один ErasureCase и показывать настоящий outcome, а не успешную отправку.

## 2. Что сделать
Замкнуть существующие prepare → permission → execute → status в owner HTTP и существующей PWA-панели. Этот шаг заканчивается корректным запуском/наблюдением coordinator; полная closure всех производных копий — S63.

## 3. Документация / grep
[ER-28](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-28-privacy-erasure-and-purge-closure.md), разделы `## Required implementation` и `## Mandatory negative boundary`; канон: `ErasureCase`.
```sh
git grep -n -F '## Mandatory negative boundary' -- docs/agent-work/ER-28-privacy-erasure-and-purge-closure.md
git grep -n -F 'prepareErasureForOwner' -- apps/eliotr-core/src
```

## 4. Как сделать
Использовать `erasure-owner-prepare.ts`, `erasure-owner-service.ts`, `erasure-owner-status.ts`, существующий coordinator и DTO. Разрешение выдаётся только владельцу точного namespace/source и запрошенного scope; обычный Research delegation S10 не даёт erase. Request, permission и ErasureCase связываются существующим idempotency identity. Ответ отправки не называть PURGED. Не сбрасывать grants/purge ledger вручную и не создавать вторую deletion queue. Отражать PENDING/BLOCKED/завершение через существующую статусную модель, не расширять CompletionDisposition.

## 5. Критерии выполнения
- Чистый owner HTTP/PWA → подтверждение конкретного source → один ErasureCase → status проходит на локальных Worker/D1/R2; replay/reload не создают второй case.
- Foreign source, service без erase, stale/expired permission и изменённый input под тем же key отказаны без удаления.
- Потерянный ACK восстанавливается по case ID; BLOCKED/UNKNOWN не изображаются как PURGED; отчёт содержит разрешённую причину и дальнейшее действие.
- Исходники/credentials не попадают в логи. Есть before/after rows, точный SHA и результаты existing erasure/browser tests. Production-data deletion этим заданием не разрешается.
