# S73 — простой Library/project пользовательский цикл

База a2aca127; ER-25/30. S03/#195 чинит один browser regression; здесь оставшийся целостный сценарий Sources, не новый backend. Переиспользовать existing project/catalog/admission/revision APIs.

## 1. Суть
Sources показывает пересекающиеся workspace/project/import панели, несколько refresh-кнопок и плохо обозначенные действия. Частично сохранённый upload выглядит готовым источником; новый пользователь не понимает следующий шаг.

## 2. Что сделать
Один project selector, один список источников, одно «Добавить документ» с последовательными состояниями upload/processing/admission/index readiness. Создать/переименовать проект, attach/detach существующего source, открыть revision, заменить файл, перейти к Lens/Research. Возможность выбора нескольких файлов делать очередью per-file operations, без unbounded batch или общей ложной успешности.

## 3. Документация / grep
[Production plan §8.7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md), [ER-25](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-25-owner-pwa.md).
```sh
git grep -n -F '### 8.7 Owner PWA' -- docs/implementation/production-readiness-plan.md
```

## 4. Как сделать
Перестроить existing `main.ts`, project/library/raw-file panels и API clients, не создавать React rewrite/новый store framework. Каждое действие имеет подпись/accessible name и привязано к exact project/source/revision. Изменение membership использует expected revision/CAS; shared source не загружается повторно ради второго проекта. Search readiness не равно admission. Сохранить idempotency после lost response/reselect; partial failure одного файла не стирает успешные другие. Empty/error/blocked states объясняют действие, технические IDs остаются в details. Keyboard/mobile и dark/light проверять на реальных controls, не screenshots-only.

## 5. Критерии выполнения
- Empty account→workspace→два проекта→import→attach shared source→revision update→Lens→Research выполняется без ручного SQL и без дублирования source.
- Stale membership conflict, failed conversion, reload/lost ACK, forbidden source и purge отражены честно; тексты кнопок/labels не пусты.
- На desktop/mobile основные действия видимы, нет нескольких конкурирующих import/refresh forms; focus и keyboard navigation работают.
- Existing API/storage identities сохранены; короткие real-browser сценарии используют общий harness. Скриншоты dark/light/mobile, exact SHA и результаты tests приложены.
