# R00 / S17 — Сохранить причину отказа до status/readback

Статус: IMPLEMENTATION TASK, документационный draft. Ни runtime, ни SQL этим файлом не исправлены. Проверено 2026-10-08 на `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`. Продолжает [#209](https://github.com/UnknownAlienHuman/eliot-research/pull/209); не заменяет исходные S17 criteria и доставленную migration 0083. Старую planning-ветку не вливать как implementation: код строится от актуального main.

## 1. Читать

- [failure-model.md](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/docs/implementation/failure-model.md), затем архитектуру §§7.7–7.9 — W2, freeze и claim audit.
- [workflow-failure-protocol.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-workflows/src/workflow-failure-protocol.ts): `WORKFLOW_FAILURE_CODES`, `WorkflowFailureSchema`.
- [failures.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-workflows/src/failures.ts): `workflowFailure`, `recordWorkflowFailure`, `retainWorkflowFailure`.
- [research-evidence-freeze.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-research-branches/src/research-evidence-freeze.ts): `EvidenceFreezeStageErrorCode`, `EvidenceFreezeStageError`.
- [resolver.ts — resolveCitationSet](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-evidence/src/resolver.ts#L449-L548).
- [0112_workflow_failure_shape_alignment.sql](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/infra/d1/core/migrations/0112_workflow_failure_shape_alignment.sql), плюс все последующие определения затрагиваемых triggers. 0112 читать, не редактировать.

## 2. Подтверждённая проблема и требуемый результат

Пять собственных freeze-кодов отсутствуют в общем словаре. `workflowFailure` заменяет неизвестный STAGE/RECOVERY code на `WORKFLOW_EFFECT_UNCERTAIN`. Отдельно `resolveCitationSet` превращает любое исключение resolveHandle в rejected entry; инфраструктурный сбой может затем выглядеть как неверные evidence.

Результат: INPUT_INVALID, SCOPE_STALE, EVIDENCE_INVALID, AUTHORITY_INVALID и SETTLEMENT_UNCERTAIN доходят до безопасного status с сохранением первого отказа. «Не удалось проверить» не становится «проверено и неверно». Это не установление причины исторического live-инцидента 11/18.

## 3. CODE — два checkpoint одного владельца

### A. Согласовать vocabulary и persistence

В `packages/cloudflare-workflows/src/workflow-failure-protocol.ts` добавить именно существующие пять кодов `EVIDENCE_FREEZE_*`, без нового универсального Error framework. `WorkflowFailureSchema` сохраняет strict shape, phase/stage правила, предел диагностики и существующее ограничение retryable.

Новой forward migration в `infra/d1/core/migrations/` обновить действующие проверки:
`research_workflow_first_failure_json_shape`, `research_workflow_latest_failure_json_shape`, `research_workflow_attempt_failure_shape`. Номер выбрать после обновления main; не изменять 0083/0112 и не возобновлять отменённые backup migrations. Сохранить проверку JSON keys, 1024-byte ceiling, phase/stage/retryable, first-write и authority guards. Проверить последующие consumers/constraints по точным полям, а не только один trigger.

`workflowFailure`, `recordWorkflowFailure`, `retainWorkflowFailure` остаются единственным общим путём. Не обходить privacy guard рекурсивным чтением cause, stack, provider payload или произвольного getter. Сохранить reconciliation после потерянного write ACK и COALESCE для first failure. В `packages/cloudflare-research-runtime/src/research-run-failure.ts` проверить реальный status reader, не создавать вторую таблицу диагностики.

### B. Различить неверный handle и невозможность проверки

В `packages/cloudflare-evidence/src/resolver.ts` перед rejected.push явно классифицировать outcome. Заведомо неразрешимый/невалидный handle может остаться rejected с существующим reason. Отзыв общей scope/authorization прекращает операцию; transient storage и unknown errors выходят типизированной неопределённостью, а не evidence-invalid rejection.

Не заявлять rollback: до ошибки отдельные valid resolution receipts уже могли сохраниться. Они сохраняются, но incomplete citation set не даёт успешного freeze. В freeze consumer сохранить исходную категорию; не превращать любую upstream неопределённость в `EVIDENCE_FREEZE_EVIDENCE_INVALID`. Не менять идентичность уже committed receipts и не переигрывать модель.

## 4. DOCS, функции и донор

Уточнить `docs/implementation/failure-model.md`: invalid evidence / authorization stale / verification unavailable — разные исходы; first cause и latest consequence различаются. В existing status/gap entry отметить только реально завершённые checkpoints. Никаких новых audit-комментариев или параллельных status registries.

Основной донор здесь — собственные `recordWorkflowFailure` и `retainWorkflowFailure`, уже умеющие bounded retention и lost-ACK readback. Cloudflare [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) использовать для границы durable steps, но не импортировать отдельный workflow engine. Сохранённая ошибка не разрешает retry неизвестного внешнего эффекта. Reuse важнее нового SDK.

## 5. Приёмка

- Каждый из пяти leaf errors сохраняется через actual stage → workflowFailure → D1 → status, не превращается в общий UNKNOWN.
- Следующий budget/cancellation failure не заменяет first_failure; отсутствие диагностического readback не выдаётся за durable retention.
- Known invalid handle, revoked scope и временный отказ R2/D1 имеют разные outcomes. Частично сохранённые valid receipts не дают all-resolved.
- TypeScript vocabulary и все действующие SQL validators принимают одинаковые допустимые codes и отвергают неизвестные keys/codes, неверные phase/stage, oversized JSON и несогласованный retryable.
- Исторические JSON/receipts читаются; чужие principal/credential/deployment не могут изменить failure state. Ни секреты, ни excerpt, ни raw cause не выходят в UI/log.

Во время реализации: compilation затронутых packages, scoped ESLint и `pnpm d1:depth` по текущему scoped-verification.md. После assembly расширить существующие failure/evidence-freeze/native-workflow fixtures перечисленными отрицательными случаями. В этом задании compiler, behavioral и native результаты — PENDING; production не запускался.

## 6. Зависимости и исключения

Независим от AI Search #324/#320. Общие failure files и migration интегрирует один владелец; R03/#325 и R05/#326 используют его итоговый vocabulary. Полный recovery redesign сюда не входит. #293/#294 сохраняют свои SQL-target/grant-storage обязательства; этот PR их не закрывает.

Нет deployment, paid calls, replay исторического uncertain run, backup, переименования CompletionDisposition или автоматического включения retries. Перед кодом сверить новые owner instructions, current main и существующую paused queue; документационный PR сам её не активирует.
