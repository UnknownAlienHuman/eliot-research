# S63 — удалить все управляемые зависимости, не только original

База a2aca127; ER-28/34. Вход: case S62/#254 и dependency producers S55/#247. Существующий erasure coordinator/closure store остаётся единственным исполнителем.

## 1. Суть
Удаление R2 original не убирает normalized text, projection, Wiki/report, model intermediate и управляемые delivery/backup copies. Ложный PURGED опаснее явно незавершённого удаления.

## 2. Что сделать
Завершить перечисление и удаление точной closure всех зарегистрированных мест; учесть одновременно создаваемые производные. Для retention/legal hold — существующий BLOCKED с причиной и review date. Срок хранения отчёта, provider logs и backup должен быть описан отдельно от срока JWT.

## 3. Документация / grep
[ER-28](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-28-privacy-erasure-and-purge-closure.md) и [ER-34](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-34-backup-restore-and-platform-exit.md).
```sh
git grep -n -F 'Locked backup conflict reports PURGE_BLOCKED.' -- docs/agent-work/ER-34-backup-restore-and-platform-exit.md
```

## 4. Как сделать
Переиспользовать `packages/cloudflare-erasure`, canonical purge ledger и S55 manifests. Producer fence должен запрещать поздний новый derived copy после принятого purge. Для каждого места сохранить identity/generation и реальное отсутствие, а не ACK удаления. Не превращать разные source revisions/residencies в один объект по совпадению hash. Cursor/checkpoint удаления устойчив к restart и повтору. Offsite/Google adapters подключаются через уже существующие provider closure ports; отсутствие доказательства сохраняет BLOCKED, не заставляет ждать всю другую тему для разработки локальной части. Не обещать удалять неконтролируемые файлы, скачанные пользователем; обозначить границу управляемых копий.

## 5. Критерии выполнения
- Fixture source→normalized→index→Wiki→artifact→managed export/backup удаляется или редактируется по канону; exact open, semantic search, historical readers и exports не раскрывают purged bytes/влияние.
- Purge во время synthesis/upload/notification не позволяет воскресить данные; lost ACK/restart не теряет оставшиеся места и не удаляет чужие объекты.
- Locked backup/provider outage/неподтверждённое отсутствие оставляют BLOCKED с review condition; снятие hold продолжает тот же case.
- Минимальные tombstones/receipts не содержат удалённый текст. Проверены текущие policy и residency; результат интеграции с backup/Google отмечен отдельно от локальной closure.
- Existing erasure tests плюс реальные D1/R2 fixtures, exact SHA и результаты. Случаи на живой платформе выполняются только на разрешённых disposable данных.
