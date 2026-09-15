# S91 — реальные D1 authority transactions вместо ложной SQLite-приёмки

База a2aca127; F14/F15/F16, ER-13/27. S04/#196 покрывает Project/Wiki; этот checkpoint закрывает остальные active transaction families, сохраняя быстрые pure SQLite fixtures.

## 1. Суть
node:sqlite полезен для unit tests, но не доказывает D1 limits/runtime behavior. Схема, которая успешно мигрировалась, ещё может падать на первом конкретном INSERT/UPDATE.

## 2. Что сделать
В existing Workers test harness добавить actual-service transaction coverage для ingest/admission/owner grants, scope/currentness, outbox/inbox, W1/W2/W3, index promotion, publication/dependencies, erasure и backup. Реестр проверок — существующие packet tests; не новая тестовая платформа.

## 3. Документация / grep
[Language§7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), [Execution contract§4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).
```sh
git grep -n -F '## 7. SQL authority contract' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
```

## 4. Как сделать
По public mutating service определить emitted SQL family и existing test. Если уже выполняется на workerd-D1 — переиспользовать, не копировать. Для остальных запускать реальные migration chain и actual service, проверяя canonical row/head/outbox до/после. Fresh DB и upgrade с предыдущей поддерживаемой schema должны сходиться; номера/историю migrations не переписывать. Negative: unknown/invalid shapes, stale CAS, concurrent winner, lost ACK/readback, current policy/purge race, max payload при D1 expression/statement bindings. Сложные JSON shape-предикаты, не нужные для atomic authority, можно упростить общей structural validation, но final identity/revision/policy/purge/immutable guards не убирать. Различие TS/SQL само по себе не exploit: показать supported writer reachability, как в #217.

## 5. Критерии выполнения
- Каждая active authority transaction family имеет real-D1 commit и отказ с неизменным предшествующим state/outbox; отсутствующие families перечислены, не замолчаны.
- D1 depth/parameter/batch ограничения ловятся до deployment, тест не вызывает DatabaseSync вместо D1.
- После malformed/partial migration readiness закрыт; repeated/lost-ACK settlement не повторяет authority write.
- Fast pure tests сохранены; actual runtime suites проходят Linux/Windows где применимо. Exact command/SHA/family→test mapping; no success from migration compile alone.
