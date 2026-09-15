# S90 — измерять реальный bundle/runtime, не выдавать source bytes за лимит Cloudflare

База a2aca127; F24/RT-01, ER-00/17/26. В `check-budgets.mjs` 600KiB Worker source и 2MiB PWA source — эвристики исходников, не размер deployable bundle. По указанию владельца устраняются искусственные процедурные ограничения, не реальные memory/security bounds.

## 1. Суть
Текущий gate суммирует TS/JS src, включая тесты под src, и провоцирует перенос/сжатие ради числа. Он не проверяет фактические compressed JS/Wasm, startup и initial PWA load.

## 2. Что сделать
Заменить ложный runtime proxy на измерение actual build artifacts и канонические performance budgets. Source-line/size counters сохранить как отчёт о сопровождении, не повод минифицировать методы/прятать файлы/нарезать бессмысленные packages. Процедурное изменение явно согласовать в существующих AGENTS/tooling docs по решению владельца, без secret waiver/whitelist.

## 3. Документация / grep
[Production plan Phase13](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md), [Language§9](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F '## 15. Phase 13 — execute T6 workload and performance qualification' -- docs/implementation/production-readiness-plan.md
```

## 4. Как сделать
В existing build/check command считать emitted Worker JS+Wasm compressed total, PWA initial first-party JS отдельно от deferred chunks, actual startup/heap и operation CPU по existing measurement tools. Нормативные repository targets: Worker≤4MiB compressed, startup≤400ms, first-party heap target≤32MiB, initial PWA JS≤600KiB gzip; это не заявление о vendor quota. Зависимости и test-only artifacts не должны случайно попадать в Worker. Scope/byte/request limits для безопасности сохраняются. Сохранить readable formatting #268; определить реальные source hot spots по imports/ownership, переместить pure logic в существующие domain/Rust boundaries только по смыслу. Build failures исправлять tree-shaking/lazy assets/устранением дублей, не увеличением нормативных целей. Measurement unavailable — NOT_MEASURED, не PASS.

## 5. Критерии выполнения
- Два воспроизводимых builds дают artifact identities/size measurements; source file relocation не меняет runtime result gate.
- Negative oversized build выявляется; мелкий source с большой dependency не проходит мимо проверки; tests не ship-ятся.
- Formatter и semantic tests проходят, нет нового service/package ради числа строк; procedural docs/counters больше не создают конфликт с измерениями.
- Existing runtime targets измерены на локальном/нативном уровне с явным источником; реальная T6 нагрузка отдельно. Exact SHA, параметры измерений и remaining bottlenecks перечислены.
