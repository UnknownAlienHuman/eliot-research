# S76 — читаемый TypeScript вместо методов в одну многотысячную строку

База a2aca127; F24/OVR-05, ER-00/24. Изменение форматирования отдельно от изменения поведения. Уточнена связь с S90/#282: source counts — диагностика сопровождения, не runtime performance и не основание минифицировать методы.

## 1. Суть
В `research-session.ts` и model storage/admission есть длинные однострочные методы: затруднены ревью гонок и диагностика stack. Подсчёт физических строк до форматирования скрывает размер, но не доказывает производительность.

## 2. Что сделать
Установить один root dev-formatter и применить его к существующим TypeScript/JavaScript исходникам, начиная с ResearchSession и model-attempt/spend-admission. Принятое средство: локально закреплённый Prettier, не formatter service и не новый MCP.

## 3. Документация / grep
[AGENTS](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/AGENTS.md), `## Swarm edit protocol`; [официальная установка Prettier](https://prettier.io/docs/install), проверена 2026-09-14, версия3.9.6. Процедурные source-budget правила пересматриваются явно в [S90/#282](https://github.com/UnknownAlienHuman/eliot-research/pull/282), не тайным исключением форматируемых файлов.
```sh
git grep -n -F '## Swarm edit protocol' -- AGENTS.md
```

## 4. Как сделать
Предлагаемые команды: `pnpm add -Dw --save-exact prettier@3.9.6`, затем `pnpm exec prettier --check <явные TS/JS paths>`. Проверить совместимость закреплённого pnpm/Node; dependency только dev. `.prettierignore` исключает immutable contract/vector fixtures, SQL migrations, generated bindings, receipts, source snapshots и golden bytes. Не форматировать документы/JSON с нормативными digest автоматически. Использовать `.prettierrc` с существующим стилем и LF; не добавлять Husky/watch daemon. Механические изменения отдельно от bug fixes; diff не меняет значения string/template literals или evaluated SQL. После первого принятого checkpoint использовать тот же formatter; наличие инструмента без устранения многотысячных code lines не завершает задачу. Когезию больших модулей улучшать по реальным ответственностям; не нарезать бессмысленные packages и не minify обратно. S77/#269 касается общей Unicode-validation primitive, а не общего бюджета размера.

## 5. Критерии выполнения
- ResearchSession и model-attempt/spend методы читаемы; product TS/JS соответствует одному format contract.
- Literal/SQL/fixture bytes и runtime decisions сохранены; это подтверждают existing tests и проверка semantic diff, не только prettier exit0.
- Нет prettier-ignore ради сокрытия больших методов, фоновых tools или форматирования immutable fixtures.
- Счётчики source size не маскируются; фактические build/runtime budgets проверяются в S90/#282. Tool/lock changes и механический diff выделены, exact SHA/команды сохранены.
