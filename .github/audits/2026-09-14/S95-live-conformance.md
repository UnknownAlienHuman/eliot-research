# S95 — реальные T4/T5 round trips, не повтор локальных mocks

База a2aca127; ER-27/26 и владельцы проверяемых контуров. Живое выполнение после #286; подготовка probe-кода/fixtures не зависит от наличия аккаунта. Проверять на разрешённых disposable данных, не ломать рабочую библиотеку владельца.

## 1. Суть
Локальный Worker и отдельный успешный provider call не доказывают native Workflow restart, Queue redelivery/DLQ, Access/MCP/Workspace и восстановление после реального сетевого отказа.

## 2. Что сделать
Собрать короткие operation-specific probes из существующих integration suites в один воспроизводимый conformance запуск. Выполнить на exact attested staging build: Access/API/MCP, D1/R2, Queue/DLQ, DO reconnect/hibernation, Workflow/cancel/recovery, model/gateway settlement, AI Search generation, selected Workspace и independent federation. Security/erasure/restore/rollback проверяются через подготовленные S63/S66/S67/S69, не реализуются заново в runner.

## 3. Документация / grep
[Production readiness Phase8/10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md), [handoff](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/cloudflare-handoff.md).
```sh
git grep -n -F '## 10. Phase 8 — execute T4 live platform conformance' -- docs/implementation/production-readiness-plan.md
git grep -n -F '## 12. Phase 10 — execute T5 security, privacy and failure hardening' -- docs/implementation/production-readiness-plan.md
```

## 4. Как сделать
Использовать current integration/provisioning/readback helpers; если единого runner ещё нет, создать тонкий CLI orchestrator над ними, не библиотеку вторых implementations. Вход: exact target/build/config/schema/corpus digest, suite и secret references; live flag и target approval явно отличны от fixture mode. В fixture mode нет account calls. Для каждой проверки сохранить ожидаемый/наблюдённый durable state и identities, не только HTTP200/ACK. Native resume/restart поведение сверить с закреплёнными runtime/types, paused и errored не смешивать. Контролируемый response-loss proxy может терять только ACK: он не подменяет provider/application state. Model UNKNOWN не повторяется слепо; lawful первый audit отделён от повторной synthesis. Независимый читатель получает реальные R2/D1/provider receipts, проверяет hashes/generations. Выбран gemini-mcp; не требовать legacy Drive OAuth. Missing external credential/peer/action permission — NOT_EXECUTED с точным prerequisite, не синтетический PASS. Probe cleanup idempotent, fenced собственными IDs; он не удаляет чужие данные.

## 5. Критерии выполнения
- Native duplicate/lost ACK/restart/cancel/expiry/revoke/partial-output сценарии сохраняют одну logical operation и не дают запрещённых disclosure/paid duplicates.
- AI Search serving generation и exact evidence проверены; Workspace external action/readback не подменён клиентским receipt; federation проверена независимым wire клиентом.
- Erasure/clean restore/rollback доказаны на disposable targets; obsolete grant/purged bytes не возвращаются.
- Fake/stale/wrong-target receipt и недостающие наблюдения отклоняются validator; fixture и live результаты различимы, каждый связан с exact SHA/target/config/time. Не писать LIVE_QUALIFIED, пока обязательная строка соответствующего контура не выполнена.
