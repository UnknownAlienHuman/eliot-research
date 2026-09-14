# S16 — DO terminal state должен соответствовать каноническому результату

База `a2aca127`; F12. P2: внутренний DO-путь, не доказанная пользовательская гонка.

## 1. Суть
`ResearchSession.cancel` подавляет ошибку D1 cancel через best-effort catch и всё равно сохраняет CANCELLED. `execute` после внешнего I/O пишет ENGINE_COMPLETED из старого snapshot. Ложное подтверждение отмены видно в коде; гонку completion/cancel необходимо воспроизвести.

## 2. Что сделать
Убрать неподтверждённый success и сделать terminal state DO монотонным представлением D1 outcome. Не переносить каноническую authority из D1 в DO.

## 3. Документация
[Канон §7.7.1](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'persist before notifying clients' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'best-effort' -- apps/eliotr-core/src/research-session.ts
```

## 4. Как сделать
Сначала найти реальные callers; не объявлять эту DO-ветку главным HTTP входом без доказательств. Инъекцией остановить execute на внешнем await, вызвать cancel, затем отпустить completion. При D1 failure вернуть uncertain/error и не изобретать receipt. После canonical outcome обновлять DO через короткое атомарное сравнение текущего состояния; одного неатомарного reread перед save недостаточно. Не оборачивать model/network I/O в долгий DO lock.

## 5. Критерии выполнения
- D1 cancel failure не даёт успешного CANCELLED.
- Победившая каноническая отмена не снимается поздним execute.
- Completed-first/cancel-first, lost ACK и restart сходятся к одному D1 outcome.
- Foreign/stale caller отказан; прежние operation/receipt IDs сохраняются.
- Доказаны reachability и interleaving tests; неприменимая ветка помечена отдельно, не выдаётся за live incident.
