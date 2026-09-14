# S12 — машинное чтение сохранённого отчёта и точной цитаты

База `a2aca127`; F09. Зависимость S10/#202; полного запуска S11 ждать для reader unit/integration tests не требуется.

## 1. Суть
Даже после запуска run service-клиенту нужны результат, sections и доказательства. Сейчас большая часть artifact/reauthorization маршрутов owner-only. Результат в PWA не равен доступному машинному продукту.

## 2. Что сделать
Допустить авторизованного service principal к существующим artifact/section/citations/open readers в пределах разрешённого проекта. Не открывать Wiki publication или erase в этом PR.

## 3. Документация
[Канон §7.9, §9.3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'A model cannot mint citation IDs.' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 9.3. Evidence labels' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Переиспользовать artifact draft reader, historical reauthorization и exact Evidence resolver. Обобщить контекст авторизации, не клонировать owner-reader под новым именем. При stream проверять существующие пределы и revoke/purge rules. Результат сохраняет DRAFT, coverage и claim verdicts; service-доступ не повышает его статус. Для cross-owner report требовать существующее явное разрешение, не выводить его из владения источником.

## 5. Критерии выполнения
- Headless клиент получает тот же body digest, section и exact excerpt, что разрешённый owner.
- Чужие report IDs, denied projects, purged dependencies и revoked policy не раскрывают bytes/metadata.
- Историческая цитата соответствует исходной revision, не текущему head.
- Чтение не вызывает paid synthesis и не меняет артефакт/права.
- HTTP/D1/R2 tests и combined сценарий с S11 после его готовности; exact SHA/results.
