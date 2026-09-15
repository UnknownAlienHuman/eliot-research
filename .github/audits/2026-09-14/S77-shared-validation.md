# S77 — переиспользовать проверку текста без восьми разных реализаций Unicode

База a2aca127; F23/DUP-01. Дополняет canonical JSON S28/#220. Не объединять разные wire contracts по совпадению названия функции.

## 1. Суть
`boundedText` и похожие проверки копируют подсчёт длины/суррогатов/NUL, но единицы и разрешённое форматирование различаются. Универсальное «заменить все восемь» может сломать persisted identity и допустимые запросы.

## 2. Что сделать
Вынести общую чистую проверку well-formed Unicode/длины в существующий нижний слой contracts/domain; domain-specific allowed characters, error codes и byte limits остаются явными у caller. Начальный обязательный consumer — Wiki owner edit; подключить следующие реально эквивалентные consumers после differential tests, несовместимые ограничения не унифицировать силой.

## 3. Документация / grep
[Языковой контракт §3–§4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), [Wiki producer](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/apps/eliotr-core/src/wiki-owner-edit-proposal.ts).
```sh
git grep -n -F 'function boundedText' -- apps packages
git grep -n -F 'hasLoneSurrogate' -- apps/eliotr-core/src/wiki-owner-edit-proposal.ts
```

## 4. Как сделать
Для каждого найденного тела указать units (UTF-8 bytes/UTF-16 units), trim/empty/NUL/surrogate/control behavior и текущий error mapping. Общая primitive возвращает результат/причину без I/O и без изменения текста; параметры units обязательны, не неявные defaults. Wrapper сохраняет доменный code/status. Не делать validator DSL, нового package или второй schema registry. Strict input schema остаётся source of truth. Canonical fixtures показывают equivalence на принятом домене; known bug исправляется отдельным versioned изменением, а не автоматически копируется в Rust. Аналогично инвентаризировать оставшиеся canonical serializers относительно #220 и Rust M2: иной byte contract сохраняется явно, эквивалентный алгоритм удаляется при переключении callers.

## 5. Критерии выполнения
- BMP/astral/surrogate/NUL/LF/CRLF/empty/max/max+1 cases сохраняют прежние допустимые bytes/errors каждого перенесённого caller.
- Нет silent trim/normalization и ретроспективного изменения IDs/hashes. Writer/reader Wiki round-trip остаётся корректным.
- Повторяющаяся Unicode primitive удалена у перенесённых consumers; оставшиеся различия документированы по контракту, не скрыты счетчиком LOC.
- Boundary/typecheck и focused plus caller integration tests проходят; exact functions removed, SHA и результаты сохранены. Декомпозиция больших файлов не создаёт нового authority/service.
