# S01 — Устранить пять отказов package-boundary gate

Приоритет: P1, первый блокер проверочного конвейера. Владельцы: ER-00 и владельцы затронутых пакетов. Родительская тема: #96. База проверки: `a2aca1277b0edbbed04de66e0d44e383e1b815ef`, 2026-09-14. Связь со сводным аудитом: F20.

Это draft PR-задание, а не исправление. Паспорт не сливать как выполненный код. Реализация — один ограниченный change set актуального main, без worktree; закрытие только после ссылки на исправляющий commit и проверки. Ни deployment, ни ослабление gates этой задачей не разрешены.

## 1. Суть

CI [34838617436](https://github.com/UnknownAlienHuman/eliot-research/actions/runs/34838617436) останавливает `verify` и `windows-tooling` на package boundaries. Последующие product tests в verify не исполняются. Проверка использует точные import specifiers; пять отказов не доказывают пять циклов зависимостей.

## 2. Что сделать

Разобрать и устранить ровно следующие зависимости:

- `cloudflare-research/src/artifact-draft-reader.ts` → `cloudflare-artifacts/artifact-draft-reauthorization.js` и `artifact-draft-citations-reauthorization.js`;
- `cloudflare-research/src/research-qualification-prompt.ts` → `@eliotr/retrieval`;
- `cloudflare-research-stages/src/research-coverage-result.ts` и `research-historical-coverage-reader.ts` → `@eliotr/domain`.

Вне задачи: общий рефакторинг, повышение лимитов, обновление toolchain, переделка auth/Workflow, исправление browser harness.

## 3. Документация и точный grep

[AGENTS.md](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/AGENTS.md): `## Dependency direction`.

[Execution contract](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md): `## 3. Implement each checkpoint this way`, `## 4. Commands and test environment`.

```sh
git grep -n -F '## Dependency direction' -- AGENTS.md
git grep -n -F 'PACKAGE_RULES' -- scripts/check-boundaries.mjs
```

## 4. Как сделать

Сначала сохранить пять исходных отказов. Для каждого указать импортируемый символ, объявленную package dependency, export и допустимое направление. Если это пропущенный разрешённый export — зарегистрировать только обоснованный specifier; если это реальное нарушение — использовать существующий нижележащий порт/модуль. Не разрешать весь `@eliotr/*`, не скрывать файл от сканера и не добавлять обратную зависимость. Сохранить или расширить существующий `boundaries:negative`, в том числе отрицательный пример неправильного направления и неизвестного subpath. Совместно менять manifest/exports только когда это действительно требуется выбранным исправлением.

## 5. Критерии выполнения

- [ ] `pnpm boundaries:check` и `pnpm boundaries:negative` проходят на Linux и Windows.
- [ ] Все пять исходных отказов устранены с объяснением; намеренно запрещённый импорт по-прежнему даёт non-zero.
- [ ] Typecheck затронутых пакетов проходит; публичные DTO и runtime-поведение не изменены.
- [ ] CI больше не останавливается на boundary step. Следующий независимый failure записан отдельно, а не назван общим PASS.
- [ ] Приложены exact SHA, команды/exit codes и before/after. Полный release остаётся заблокирован до остальных обязательных gates.
