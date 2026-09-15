# S94 — exact build/resource readback и первая полная staging-выкладка

База a2aca127; ER-26/27/00. Не развёртывать ничего ради создания этого задания. Входы для первой полной попытки: code-complete выбранный профиль, #210/#281/#282/#284; реальные T4/T6 receipts ещё не могут быть её предусловием.

## 1. Суть
Git main SHA, Cloudflare version ID, schema generation и видимая PWA — разные identities. Наличие Worker в inventory или успешный wrangler deploy не доказывают нужные bindings/assets/code.

## 2. Что сделать
Завершить проверку existing deploy orchestrator: preflight→exact build→аддитивные миграции→private staging deployment→независимый version/binding/schema/assets/Wasm readback. Привязать deployment receipt к фактическому tested tree и параметрам выбранного transport.

## 3. Документация / grep
[Production plan Phase7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md), [execution contract§6](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).
```sh
git grep -n -F '## 9. Phase 7 — provision a real staging environment' -- docs/implementation/production-readiness-plan.md
```

## 4. Как сделать
Existing `scripts/deploy-cloudflare.mjs`/preflight/deployment-verification, canonical resources.json и wrangler config; не raw CLI обход или второй deploy tool. Local fixtures отрицательных responses сначала. Живая цель задаётся оператором: account/resource IDs, hostname/jurisdiction, secret references, budget, разрешение на disposable data. Staging label не доказывает изоляции фиксированных имён; сверить реальную цель и serving production. Access должен защищать все выдающие private data routes; не выводить secrets в receipt. Проверить каждый required D1/R2/Queue/DLQ/DO/Workflow/AI binding, static asset marker и Wasm digest через соответствующий readback, не только список объектов. Отсутствующий mandatory код блокирует; отсутствие будущего T4 результата не создаёт циклический запрет первой staging-попытки.

## 5. Критерии выполнения
- Wrong target/version/binding/partial migration/config drift/fake health PASS обнаружены и не дают успешного deployment receipt.
- Actual deployed build/assets/schema/Wasm соответствуют exact проверенному commit/tree/config, доступ защищён, production data не тронуты.
- Local dry-run/preflight/order/negative tests проходят; actual staging receipt получен только после разрешённого запуска, со всеми identities и cleanup/rollback reference.
- После выкладки запускаются S95/S93/S96, до этого project не объявлен production-ready. Missing credentials/approval локализованы здесь, не мешают писать/test-ить остальные code tasks.
