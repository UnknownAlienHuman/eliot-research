# S90 — Измерять выпускаемый artifact, а не поощрять сжатый исходник

Проверено 2026-10-08 на `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`. Дополнение к #282, документационный draft. Исходные startup/heap/CPU/workload требования сохраняются, но не блокируют первый bounded build-budget checkpoint.

## Читать

- `AGENTS.md`: Source-maintainability heuristics; `docs/implementation/production-readiness-plan.md`, Phase 13; `docs/implementation/scoped-verification.md`.
- [Текущий checker](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/scripts/check-budgets.mjs): `countPhysicalLines`, `walk`, четыре source thresholds.
- [Core build scripts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/apps/eliotr-core/package.json): `build` и `deploy:dry-run` уже вызывают `wrangler deploy --dry-run --minify --outdir dist`.
- [Реализация Cloudflare `getSize` / `printBundleSize`](https://github.com/cloudflare/workers-sdk/blob/aaa6a880682fcc33a02366d7b193474f05e36717/packages/deploy-helpers/src/deploy/helpers/bundle-reporter.ts); [CLI reference](https://developers.cloudflare.com/workers/wrangler/commands/).

## Подтверждённое состояние

Checker честно печатает NOT_MEASURED для emitted/startup/heap/CPU, но всё ещё возвращает failure по физическим строкам и сумме source bytes. Это не измерение deployed Worker: scan apps/eliotr-core не учитывает все транзитивные workspace imports; перенос кода в package меняет счётчик без обязательного уменьшения bundle. Formatting разворачивает строки и может ухудшать этот gate без ухудшения программы.

Не заявлять, что этот стимул доказан как историческая причина каждого minified метода. Исправить конфликт правил: читаемость не должна достигаться обходом gate.

## CODE — последовательность

### A. Bounded build-size checkpoint, ДО массового formatting

Расширить существующий `scripts/check-budgets.mjs` явным artifact mode; source scan/`countPhysicalLines` сохранить как диагностику. `package.json`, AGENTS и build/runtime documentation меняются согласованно одним integrator. Новый CLI/script alias пометить NEW до реализации; не выдавать предполагаемую команду за существующую.

Использовать имеющийся `pnpm cf:dry-run` либо раздельные `pnpm build:pwa` / `pnpm build:worker` с закреплённым Wrangler. Перед запуском inspect custom build hooks и явно запретить deploy/provision/remote flags. Из stdout/retained build outputs извлечь native Total Upload и перечень entry/modules/Wasm с digest. Неподдержанный output/parser version — NOT_MEASURED, а не 0.

`getSize` в прочитанном donor считает gzip от конкатенации содержимого modules+entry. Не подменять метрику суммой gzip каждого файла, размером исходников или одного entry.js. Сам private `@cloudflare/deploy-helpers` не добавлять в product dependencies; использовать установленный Wrangler как источник измерения. Donor SHA — reference, не доказательство, что установленный Wrangler 4.143.1 имеет тот же внутренний layout.

Для PWA считать initial eager JavaScript конкретной entry page и его статический import graph; shared chunk считать один раз. Dynamic chunks, CSS, total build и standalone agent inbox показывать отдельными метриками. Не суммировать весь dist как initial JS и не игнорировать dynamic import, который startup немедленно вызывает: окончательно проверить network waterfall на приёмке. Не требовать нового bundler/framework.

Retained report: source commit/dirty state, lockfile digest, Node/pnpm/Wrangler, build flags, module manifest+digests, metric/unit/method, threshold policy и PASS/FAIL/NOT_MEASURED. Генерируемый report не должен включать secrets или absolute developer paths. Порог берётся из существующего release contract (в проверенной базе Worker <=4 MiB compressed, PWA initial <=600 KiB gzip), не из будущего максимального vendor quota.

### B. Явно исправить incentive

В AGENTS/checker documented source-line/source-byte counts перевести в advisory diagnostics вместе с введением реального emitted gate. Это нормативная корректировка эвристики, не скрытый waiver. Security byte limits в request/readers/SQL/model budgets НЕ изменять. Не переносить тесты, не исключать крупные modules и не повышать release limits ради PASS.

Code-size gate не измеряет complexity, startup или цену D1/R2. Их отсутствие отображать отдельно. После checkpoint A/B #268 может форматировать код без искусственного распила на 600 строк.

### C. Runtime measurements — отдельная приёмка

По уже существующим #288/S96 и #286/S94 измерить startup/CPU/heap/read counts/latency на pinned build; не создавать второй benchmark suite. [Workers native traces](https://developers.cloudflare.com/workers/observability/traces/) использовать для dependency timing вместо самописного tracer. Samples не доказывают полноту workload; raw source/query/prompts в telemetry не писать. Tracing configuration и paid/native запуск требуют отдельного разрешённого scope.

## DOCS и результат

Согласовать AGENTS, Phase 13, scoped-verification и названия package scripts. Source size, bundle size, initial load и runtime latency — разные поля. S76 formatting зависит только от готового A/B, не от будущего T6 benchmark; обратной зависимости нет.

Результат: workspace import реально увеличивает измеренный Worker; перенос функции между пакетами сам по себе не даёт ложной экономии; code formatting не ломает release budget за счёт line counter. Unknown measurements не становятся зелёным readiness.

## Acceptance после assembly

Добавленный reachable dependency/Wasm учитывается; unreachable fixture не попадает в shipped manifest; stale dist/иной lock/dirty output не приписывается чистому SHA. Unicode/LF/CRLF source diagnostics сохраняются. Eager/shared/lazy/PWA-inbox графы различаются. Bundle >contract получает FAIL; missing build получает NOT_MEASURED. Нет автоматического deploy и скрытых удалённых действий.

При реализации: `node --check scripts/check-budgets.mjs`, scoped ESLint; compiler для изменённого TS, если он появится. Фактический pinned dry-run — отдельный build check; full tests/native/performance после assembly. Сейчас все новые результаты PENDING. В этом PR только Markdown, main и runtime не изменены; нет backup или новых discussion comments.
