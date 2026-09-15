# S76 — читаемый TypeScript вместо методов в одну многотысячную строку

База a2aca127; F24/OVR-05, ER-00/24. Изменение форматирования отдельно от изменения поведения.

## 1. Суть
В `research-session.ts` и model storage/admission есть длинные однострочные методы: невозможно нормально ревьюить гонки и диагностировать stack. Подсчёт строк до форматирования скрывает размер, но не доказывает performance.

## 2. Что сделать
Установить один root dev-formatter и применить его к существующим TypeScript/JavaScript исходникам, начиная с ResearchSession и model-attempt/spend-admission. Принятое средство: локально закреплённый Prettier, не formatter service и не новый MCP.

## 3. Документация / grep
[AGENTS](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/AGENTS.md), `## Swarm edit protocol`; [официальная установка Prettier](https://prettier.io/docs/install), проверена 2026-09-14, показана версия3.9.6.
```sh
git grep -n -F 'Keep a source file below 600 lines' -- AGENTS.md
```

## 4. Как сделать
Предлагаемые команды установки/проверки: `pnpm add -Dw --save-exact prettier@3.9.6`, затем `pnpm exec prettier --check <явные TS/JS paths>`. Сначала проверить совместимость закреплённого pnpm/Node; dependency только dev. `.prettierignore` исключает immutable contract/vector fixtures, SQL migrations, generated bindings, receipts, source snapshots и golden bytes. Не форматировать документы/JSON с нормативными digest автоматически. Использовать `.prettierrc` с существующим стилем и LF; не добавлять Husky/watch daemon. Механические изменения делать отдельно от bug fixes; diff не должен менять значения string/template literals или evaluated SQL. После первого принятого checkpoint применять тот же formatter в затрагиваемых файлах; приёмка серии требует устранить оставшиеся многотысячные code lines, а не просто поставить инструмент. Реальные слишком большие модули декомпозировать по S77, не minify обратно.

## 5. Критерии выполнения
- ResearchSession и model-attempt/spend методы читаемы; финальная проверка product TS/JS соответствует одному format contract.
- Literal/SQL/fixture bytes и runtime decisions не меняются; проверены typed AST/behavior и существующие tests, не только prettier exit0.
- Нет prettier-ignore ради сокрытия больших методов, новых фоновых tools и форматирования immutable fixtures.
- Source budgets, если выявили реальный избыток после форматирования, отражены как задача S77, не скрыты исключением/повышением лимита. Tool/lock changes и механический diff выделены, exact SHA/команды сохранены.
