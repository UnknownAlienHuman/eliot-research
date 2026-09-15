# S64 — доставка outbox/Queue восстанавливается без повторных эффектов

База a2aca127; ER-15/24. Outbox/inbox/lease/consumer уже реализованы. Не создавать ещё одну очередь или job-систему.

## 1. Суть
Пропущенное сообщение не должно навсегда оставить импорт/проекцию/публикацию незавершёнными, а duplicate/lost ACK не должны создавать вторые канонические эффекты. Частный happy-path receipt не закрывает poison/DLQ/restart.

## 2. Что сделать
Закончить composition scheduled reconciliation → существующий outbox dispatcher → consumer settlement, а также безопасное повторное предъявление DLQ-задания после устранения причины. Работать с прежним topic/idempotency/payload digest, не создавать новую логическую операцию.

## 3. Документация / grep
[ER-15: Implemented contour, Failure rules, Verification](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-15-outbox-queue-and-retry-discipline.md).
```sh
git grep -n -F 'A Queue acknowledgement is emitted only after durable consumer settlement.' -- docs/agent-work/ER-15-outbox-queue-and-retry-discipline.md
```

## 4. Как сделать
Использовать `d1-outbox-store.ts`, `d1-inbox-store.ts`, `execution-lease.ts`, `outbox-dispatcher.ts`, `queue-consumer.ts`, app `queue.ts`/`scheduled.ts` и `outbox-reconciler.ts`. Scheduled job перечитывает intent/receipt прежде resend, consumer — текущую source/policy/purge authority. Не держать network I/O в D1 transaction. Poison не бесконечно крутится: действует существующий Queue max_retries/DLQ. Operator replay допускается только после исправления причины и текущей авторизации; receipt уже завершённого job возвращается без handler effect. Нельзя пересылать DLQ bytes в обход decode/currentness.

## 5. Критерии выполнения
- Потеря send ACK, двойная доставка, crash после effect до ACK, stale lease и restart дают ровно один authoritative результат.
- Пропущенное сообщение находится reconciliation; payload substitution отказана; revoked/purged intent не исполняется после redelivery.
- Poison оказывается в DLQ и виден в диагностике; безопасный повтор после устранения причины использует прежнюю identity, не запускает второй paid call.
- `pnpm delivery:check`, platform/core tests и реальные локальные producer→Queue→consumer сценарии проходят. Remote duplicate/DLQ acceptance остаётся отдельной платформенной проверкой; exact SHA/команды/результаты сохранены.
