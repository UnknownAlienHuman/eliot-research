# S65 — рабочий coherent BackupEpoch и offsite adapter

База a2aca127; ER-34. O2 уже реализует шифрование, nonce authority, coherent cut и replay: повторно писать их нельзя. Выбор реального внешнего destination/его ключей — операторская конфигурация, не угадываемое значение.

## 1. Суть
В `infra/backup/README.md` подтверждены локальные O2 fixtures и controlled destination; это не доказательство действующего независимого offsite backup. Полная схема Core после последних миграций должна попадать в portable export.

## 2. Что сделать
Соединить `packages/platform-cloudflare/src/backup.ts` с действительными D1/R2 source ports и существующим `copyOffsiteExport`. Реализовать deployment adapter по уже определённому интерфейсу OffsiteCopyAdapter (`describe/put/get/delete`) для явно настроенного разрешённого destination. Не привязывать порт к новому облачному backend.

## 3. Документация / grep
[Backup contour](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/infra/backup/README.md), [ER-34](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-34-backup-restore-and-platform-exit.md).
```sh
git grep -n -F 'O2 (IMPLEMENTED_NOT_LIVE)' -- infra/backup/README.md
git grep -n -F 'export interface OffsiteCopyAdapter' -- packages/backup-o2/src/offsite.ts
```

## 4. Как сделать
Использовать `epoch.ts`, `coherent-cut.ts`, `offsite.ts`, destination/nonce/replay authority и additive migrations0018/0019. Экспортировать все текущие authority tables/columns и R2 manifest с согласованным cut; неизвестная таблица не пропускается молча. Secrets/KEK не входят в export. Чтение ciphertext и аутентифицированное расшифрование проверяют bytes до receipt; ACK не достаточен. Не хранить всё тело epoch в памяти. Локально тестировать интерфейс controlled destination; для live требуются проверенный failure domain, удаляемость/retention, endpoint/credential references. Без этих параметров код можно закончить, но fake live destination или fixture receipt запрещены. Не считать второй bucket того же failure domain независимой копией.

## 5. Критерии выполнения
- Из populated Core/R2 получается полный portable epoch с schema/migration/purge/heads/objects, без пропуска новых колонок и секретов.
- Concurrent mutation либо входит в согласованный cut, либо даёт явно незавершённый export; corrupt/missing part не принят.
- Lost put ACK/restart/replay используют прежнюю copy identity и durably unique nonces; expiry/delete readback работают, locked destination даёт BLOCKED.
- Existing O2 tests сохранены, добавлен real workerd/D1 source-port тест. Live offsite put/get/delete и failure-domain evidence записываются отдельно после настройки разрешённой цели; exact SHA и результаты обязательны.
