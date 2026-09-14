# S60 — federation submit запускает разрешённую реальную работу

База a2aca127; ER-22/41/24. Перечитан federation-service.ts: reserve/read/cancel, manifests/bundles/changes interfaces существуют. Не объявлять семь операций фиктивными; доказать/замкнуть execution side.

## 1. Суть
Принятый job и готовые storage ports не равны выполненному research.pack/run/report. Completion внешнего transport не должен усиливать внутренний disposition.

## 2. Что сделать
Existing federation reserve+outbox→dispatcher→уже реализованный retrieval/Research executor→immutable evidence/result bundle→terminal receipt→status/result/range. cancel связан с каноническим run cancel, не только внешним статусом. Никакого нового Workflow/engine и клиентской DB зависимости.

## 3. Документация / grep
[Канон §11–11.1 и §19.11](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 11.1. Execution choices' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 19.11. Federation' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Reuse FederationSubmission/AuthorityBinding, D1 job/manifests и R2 bundle stores; accepted job/outbox atomic, duplicate delivery reconciles deterministic execution identity. Manifest pins requester/server/bridge/client fence/scope/disclosure/retention; URL/auth alone не разрешает sources. research.pack не вызывает ненужную synthesis; требуемая audited pack процедура отражается отдельно. Delegated query/run authorizer общий механизм, но federation-specific fence/manifest checks не заменять generic project grant. Model output возвращается synthesis_candidate, никогда не записывается в client canonical memory. Состояния transport+exact9 CompletionDisposition ортогональны; cancelled/partial/unknown корректно передаются. Missing configuration не считать отсутствием implementation и наоборот.

## 5. Критерии выполнения
Independent HTTP submit на admitted corpus запускает actual internal job, result refs/bytes и disposition совпадают. Duplicate/lost submit ACK/Queue redelivery/restart не удваивают работу. Cancel до/во время/после completion и revoked manifest безопасны. Source-only pack не оплачивает synthesis; final public bundle не сильнее внутреннего результата. Actual D1/R2/executor tests+SHA, live independent peer qualification в S61/финальной приёмке.
