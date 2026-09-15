# S97 — окончательное закрытие v1 и production canary

База a2aca127; release owner, ER-26/27/00. Это конечная приёмка, не ещё одна система гейтов. Входы: реализованные mandatory Slices0–6 выбранного gemini-mcp профиля, Rust families M1–M7, local #284, quality #285, deployment #286, native #287 и workload #288. S98/S99 также относятся к основному headless/corpus пути и не исключаются из приёмки из-за позднего номера.

## 1. Суть
Число закрытых PR, зеленый CI и наличие работающего Worker не равны production-ready. Нужно подтвердить весь выбранный продукт на совместимых фактических generations, включая источники, исследование, результаты, Google, federation и recovery.

## 2. Что сделать
Сверить существующие implementation-status.json/gap-register/release-checklist/security-checklist с исполнением и retained evidence; закрыть применимые mandatory gaps только по точным исправлениям и проверкам. Затем провести канонические canary loops и сформировать один существующего формата release receipt.

## 3. Документация / grep
[Production readiness Phase14](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md).
```sh
git grep -n -F '## 16. Phase 14 — production launch' -- docs/implementation/production-readiness-plan.md
git grep -n -F 'Only after this receipt is complete' -- docs/implementation/production-readiness-plan.md
```

## 4. Как сделать
Не доверять старым галочкам или утверждению «файл существует»: по обязательной записи проверить actual caller, local negative/replay case, configured runtime и применимый live receipt. Старые частные live-cases признавать частными, не обнулять и не превращать в полную qualification. Record Worker/schema/R2 residency/search/AI Search/Rust ABI+Wasm/PWA/Access/Google/model-route identities и rollback targets. Canary: новый source→exact retrieval/open→governed run→accepted artifact/Wiki publish→federation job→selected Workspace action→disposable erasure→clean restore. Контроль canary window и разрешение production head задаёт release owner, а не модель сама себе. Известные незакрытые обязательные ошибки/overdue erasure/необработанный DLQ останавливают выпуск; новый обнаруженный дефект относится к owning задаче, не оправдывает расширение scope на optional продукты. README/START-HERE/индексы/registry согласуются по фактической версии. Сводка по старым theme PR разрешает закрыть superseded планы, но не сливать их древние code trees или автоматически удалять unmerged work.

## 5. Критерии выполнения
- Каждое mandatory требование выбранного профиля имеет implemented caller + negative/replay evidence + применимую реальную qualification, без пропусков, неизвестных усилений и stale receipts.
- T0–T6, safety/erasure/restore/rollback и production-critical Rust завершены по своим критериям; при смене затронутых generations приёмка повторена адресно.
- Canary loops проходят, DLQ/overdue erasure согласованы с release rule, current secrets/Access/budgets активны; production head одобрен явно после окна наблюдения.
- Один точный release receipt с перечисленными identities опубликован; только затем слова production-ready допустимы. Нет нового registry, автоматической абсолютной гарантии или выдуманного месячного счёта.
