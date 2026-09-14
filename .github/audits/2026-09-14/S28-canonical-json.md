# S28 — убрать один реальный дубль canonical JSON без изменения hashes

База `a2aca127`; F23. Узкий refactor одной семьи и двух consumers, не replace-all по всему репозиторию.

## 1. Суть
В проекте несколько независимых canonical serializers. Подобные имена не доказывают одинаковые byte contracts: значения undefined, nonfinite numbers, Unicode, sorting и массивы могут обрабатываться по-разному. Нельзя удалить их по grep-счётчику.

## 2. Что сделать
Выбрать две действительно эквивалентные реализации из evidence/retrieval family, зафиксировать поведение fixtures и заменить дублирование одним существующим допустимым lower-layer implementation. Удалить заменённое тело, не оставить ещё один wrapper-стек.

## 3. Документация
[Языковой контракт §3 и §4.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), [AGENTS Dependency direction](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/AGENTS.md).
```sh
git grep -n -F 'Canonical serialization rules' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
git grep -n -e canonicalEvidenceJson -e canonicalRetrievalJson -- packages/cloudflare-evidence/src packages/retrieval/src
```

## 4. Как сделать
Сначала перечислить точные функции и callers и сравнить output/errors на versioned fixtures. Покрыть object key order, Unicode/escapes, -0, null, invalid numbers и nested values в реально допустимом домене. Если семантика отличается, эту пару не объединять без versioned migration. Сохранить текущую language authority: не объявлять Rust promoted только ради refactor. Не добавить forbidden dependency/cycle.

## 5. Критерии выполнения
- Существующие persisted fixture bytes/digests/IDs до и после полностью совпадают.
- Некорректные значения по-прежнему дают ожидаемые ошибки.
- Удалена конкретная дублированная реализация, два consumers используют один contract.
- Boundary tests проходят, нет новой package/service/serializer generation без необходимости.
- Объём фактического удаления и exact SHA/tests указаны; «удалено 26» без проверки не заявлять.
