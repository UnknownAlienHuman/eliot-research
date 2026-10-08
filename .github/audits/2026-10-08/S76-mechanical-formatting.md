# S76 — Читаемый TypeScript без изменения canonical bytes

Проверено 2026-10-08 на `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`. Это дополнение к #268; formatter/runtime в этом PR ещё не установлены и не изменены. Исходный S76 сохранён как историческое задание.

## Читать

- AGENTS: Swarm edit protocol и source heuristics; `docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md`; `docs/implementation/scoped-verification.md`.
- [Текущий source gate](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/scripts/check-budgets.mjs): `countPhysicalLines`, MAX_FILE_LINES/MAX_PACKAGE_SOURCE_LINES.
- [ResearchSession](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/apps/eliotr-core/src/research-session.ts): `fetch`, `start`, `execute` — первый mechanical batch, не повод удалить DO.
- [Prettier install](https://prettier.io/docs/install), [CLI --debug-check](https://prettier.io/docs/cli#--debug-check), [embeddedLanguageFormatting](https://prettier.io/docs/options#embedded-language-formatting), прочитаны 2026-10-08.

## Корневая проблема и зависимость

Source gate всё ещё считает физические строки hard failure. Пока это правило действует, раскрытие однострочного метода может вынуждать бессмысленный split. Поэтому сначала #282 checkpoint A/B: emitted measurement + явное согласование advisory source diagnostics. Не ждать полного T6 workload; это не циклическая зависимость.

Механическую правку не смешивать с R00/R02/R03/R04 behavior changes. Shared package.json/lock/config сначала меняет один integrator; массово не форматировать файл, пока другой агент меняет его семантику. Один рабочий checkout/worktree на manager; не плодить leaf worktrees ради formatting.

## CODE — два checkpoint

### A. Только development tooling

Добавить один exact-pinned local formatter в root devDependencies и lockfile; установить совместимость с pinned Node/pnpm. Старое упоминание 3.9.6 — исторически выбранный pin, не доказательство текущей latest-версии. Реальную выбранную версию записать в checkpoint. Не использовать network-fetching npx latest в CI.

Единая небольшая config: LF, стиль проекта, `embeddedLanguageFormatting: "off"` для mechanical pass. По умолчанию Prettier может форматировать распознанный код внутри строк; это недопустимо, когда строка — prompt/SQL/канонические данные. Отключение опции не заменяет проверку значений strings/templates.

Исключить generated bindings, migrations, fixtures/vectors, persisted receipt snapshots и canonical data; не добавлять ignore для больших product methods. Не добавлять Husky, watcher, daemon, MCP formatter или другой production dependency.

### B. Reviewable mechanical batch

Первым отформатировать `apps/eliotr-core/src/research-session.ts`; соседние model-attempt/spend modules брать только после exact ownership inventory, не по широкому glob. Сохранить функции, imports/exports, SQL, error vocabulary, numeric bounds и order of effects.

Команды ПОСЛЕ установки formatter:

```sh
pnpm exec prettier --debug-check apps/eliotr-core/src/research-session.ts
pnpm exec prettier --write apps/eliotr-core/src/research-session.ts
pnpm exec prettier --check apps/eliotr-core/src/research-session.ts
pnpm exec tsc -b apps/eliotr-core/tsconfig.json --pretty false
pnpm exec eslint apps/eliotr-core/src/research-session.ts
```

`--debug-check` не совмещается с `--write`; это safeguard formatter, не доказательство observational equivalence. Сравнить до/после actual literal/template values и извлекаемые SQL expressions; обратить внимание на tagged-template raw/cooked values, comment directives, regex, Unicode и line endings. Значимые расхождения не оправдывать formatter PASS. Не normalise JSON/SQL/prompts ради стиля. Финальные runtime/replay проверки исходного S76 сохраняются после assembly.

В этот diff НЕ входят bounded parser correction в `start`, retries, cache, removal of WeakMap, изменение checkpoint stage topology или перенос TS authority в Rust. Такие изменения меняют поведение и идут в своём checkpoint. Если файл после форматирования длинный, source metric сообщает это; функциональный split допустим позже по ownership/cohesion, не по числу строк.

## Донор: что действительно переиспользовать

Prettier даёт parser/printer, `--debug-check`, `--check` и явную embedded-language policy: не писать formatter самостоятельно. Собственный Eliot SQL extractor/существующие contract fixtures — средство контроля значимых данных; новый AST/pretty-printer framework не нужен. Scope — качество review, не заявление об ускорении программы.

## DOCS / результат

Обновить toolchain/scoped-verification и форматирующую часть AGENTS согласованно с #282. Объяснить разницу mechanical formatting и behavior refactor; сохранить запрет изменения старых migrations/accepted bytes.

Результат: выбранные production methods можно читать и ревьюить; нет новых helpers/packages ради line budget; pinned formatter повторно не меняет файл; authority/replay/literal values сохранены. Tool installation без отформатированного caller не закрывает S76.

## Проверка и границы

Сейчас все code/compiler/formatter/runtime результаты PENDING. Приёмка: invariant literals/templates/SQL, negative/start/replay/cancel/terminal-state cases, no fixture rewrite, no hidden ignores, неизменные release-budget thresholds. Сравнение байтов emitted JS само по себе не обязательно совпадает из-за formatting/debug positions; проверять смысл и actual shipped budget отдельно.

Planning branch можно согласовать с актуальным main, сохраняя историю и только Markdown delta. Не вливать её как runtime fix. Нет source change, deployment, backup, платных вызовов или discussion comments в этой подготовке.
