# S25 — проверить договорённость Wiki writer/reader для Unicode и references

База `a2aca127`; F15. P2, hardening. Разница SQL/TS предикатов доказана; создание сломанной записи через нормальный HTTP не доказано, поскольку parseInput уже валидирует заметку.

## 1. Суть
SQL length проверяет символы иначе, чем JS length; ref shape в 0064 слабее validRef. Нельзя объявлять каждую такую разницу уязвимостью, но успешная запись через поддерживаемый writer обязана читаться тем же приложением.

## 2. Что сделать
Проверить edit_note и base_evidence_map_ref по цепочке supported writer→commit→reader. Исправить только доказанное расхождение и сделать структурную валидацию повторно используемой для этой операции.

## 3. Документация
[LANGUAGE_RUNTIME_CONTRACT §3–4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), [канон §9.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 9.5. Proposal and publication' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'boundedText' -- apps/eliotr-core/src/wiki-owner-edit-proposal.ts
```

## 4. Как сделать
Corpus: BMP, emoji, NUL, lone surrogate, valid/invalid ref, граничная длина. Запускать через реальный service и D1, не только сравнение отдельно скопированных regex. Запись bad input должна отказать до effects; deliberately corrupted DB row должна безопасно отказать reader. Не удалять atomic guards, foreign keys, CAS и immutable constraints. Если нормальные writers уже защищены, закончить регрессионными tests и точным описанием границ SQL; не добавлять ненужные триггеры ради совпадения всех предикатов.

## 5. Критерии выполнения
- Любая принятая supported writer-ом запись успешно round-trips с теми же bytes/hashes.
- Invalid input не оставляет новых head/receipt/outbox; corruption reader не маскируется.
- Units длины и Unicode handling одинаково описаны и проверены.
- Нет массового удаления SQL-защиты или изменения старых migrations.
- Reachability каждого найденного дефекта показана; tests/SHA и отсутствие дефекта честно фиксируются.
