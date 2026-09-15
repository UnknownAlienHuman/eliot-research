# S66 — восстановление BackupEpoch без возвращения удалённых данных

База a2aca127; ER-34/13. Вход S65/#257 (epoch), existing purge ledger; полная интеграция с S63/#255. O3/O4 явно не завершены в ER-34.

## 1. Суть
Резервная копия сама по себе не восстанавливает систему. Старый epoch может содержать уже удалённые документы, отозванные grants и устаревшие схемы; его нельзя включать в рабочий трафик как есть.

## 2. Что сделать
Реализовать existing restore port: проверить epoch → восстановить Core в изолированной цели → применить текущие purge/policy → восстановить допустимые объекты → проверить heads → перестроить проекции → только затем выдать readiness. Код не создаёт второй production backend.

## 3. Документация / grep
[ER-34](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-34-backup-restore-and-platform-exit.md), `## Mandatory negative boundary`.
```sh
git grep -n -F 'Restore an epoch containing later-purged bytes' -- docs/agent-work/ER-34-backup-restore-and-platform-exit.md
```

## 4. Как сделать
Переиспользовать BackupEpoch/manifest parsers, migration history, erasure closure и projection rebuild S52/#244. Target identity перед любым write отличается от serving resources, traffic disabled; отсутствие независимого актуального purge frontier запрещает раскрытие. Не применять rollback старого ledger вместо актуальных запретов. Секреты и отозванные credentials не восстанавливать как ACTIVE; новые operator credentials задаются отдельно. Checkpoints восстановления живут в existing operation model; каждый part привязан к epoch/hash. Не считать Queue/DO/search готовой authority, их восстановить из Core/R2. Native source handles остаются exact, purged — redacted/nonrevealing. Portable exit export использует тот же epoch, не новый формат.

## 5. Критерии выполнения
- Epoch до purge → restore после purge: удалённые bytes/metadata/influence никогда не доступны ни HTTP, ни индексу; missing purge frontier держит readiness false.
- LIVE samples и source/Wiki/Investigation/artifact heads совпадают по hashes; grants выдаются заново только по текущей политике.
- Interrupted/corrupt/missing-part restore не включает трафик, повтор продолжает прежнюю операцию; повторный rebuild не дублирует canonical state.
- Есть actual local D1/R2 restore regression с текущими миграциями, measured duration; отдельный clean-target live receipt с RPO/RTO после явного выбора цели, exact SHA и runbook.
