# R05 — Native ожидание external-agent result и безопасное восстановление

**Статус:** документационный PR-задание. Код/SQL/production не изменены.
**База:** `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`, проверка 2026-10-07.
**Не дубликат:** закрытый #207 реализовал прежний recover API. Здесь новый ограниченный участок: waiting/wake transport external task. #209 остаётся владельцем общего first-cause vocabulary, #256 — delivery/outbox.

## 1. Что читать

- [Архитектура §7.7, особенно 7.7.1–7.7.2](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/docs/architecture/ELIOT_RESEARCH.md): W2/W3, native Workflow и ResearchSession не владеют научной истинностью.
- [Cloudflare Events: Wait / Send / Event timing](https://developers.cloudflare.com/workflows/build/events-and-parameters/). `waitForEvent` и `sendEvent` уже существуют; событие до соответствующего wait буферизуется после создания instance. Это не гарантия атомарности с D1 и не отмена проверки результата.
- [Cloudflare Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/): deterministic replay, side effects внутри steps, неизменяемые входы.
- [Native wrapper Eliot](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-workflows/src/research-workflow-step-execution.ts): `executeResearchWorkflowNativeSteps`.
- [Task authority](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-workflows/src/external-agent-task-store.ts): `ExternalAgentTaskStore`.
- [Producer/consumer](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-research-branches/src/research-external-branch-analysis.ts): `taskBody`, `consumeResult`, handler/recover pairing.

## 2. Результат

Нормальное ожидание агента не маскируется под ошибку с ручным restart. Workflow ждёт компактное событие, но читает результат и подтверждает права через D1/R2. Исторический uncertain model effect не повторяется. Canonical W2 receipt и first/latest failure lineage сохраняются.

## 3. CODE — ограниченная цепочка

1. В `packages/cloudflare-workflows/src/external-agent-task-store.ts` и существующем delivery path сохранять result и delivery intent атомарно, используя текущий outbox. Потерянный ACK записи reconciles по прежним task/request/result identities; второй task не создаётся.
2. В `packages/cloudflare-workspace-mcp/src/mcp-external-agent-task.ts` заменить normal-path ручной recover wake на delivery compact notification через существующий dispatcher. Сам MCP callback не вызывает повторную модель. Обычный recover API оставить для совместимости/диагностики.
3. В native orchestration (`packages/cloudflare-research-runtime/src/research-workflow-application.ts`, `packages/cloudflare-workflows/src/research-workflow-step-execution.ts`) отделить publish, wait и consume. `step.waitForEvent` не прятать внутрь произвольного replayable handler callback; native step topology должна оставаться явной и versioned.
4. Payload события содержит только task ID и result digest. Тип события строить из фиксированного префикса и task-request SHA; до 100 символов, только letters/digits/hyphen/underscore. Не использовать dotted protocol name как event type.
5. До wait прочитать уже committed result. После wake заново проверить grant, scope/currentness, cancellation, lease/result identity и bytes. Событие не разрешает выполнить чужой task и не удостоверяет result digest само по себе.
6. Timeout ловить отдельно от corrupt/denied errors: выполнить один bounded authoritative readback, затем честный waiting/blocked/uncertain outcome по существующему контракту. Не писать бесконечный polling loop. Если нового work нет, не расходовать новый provider budget.
7. Early/duplicate/late events безопасны благодаря exact task binding и readback. Outbox retry повторяет уведомление, не работу агента. Отсутствующий результат после события — не успех.

## 4. Что упрощать и что НЕ удалять

Удаляем дублирующий normal-path wake/restart transport, а не canonical `ExternalAgentTaskStore`, grant/lease checks, outbox или W2 stage receipt.

Для затронутой стадии различить локально verified no-effect, ожидаемый результат, committed result и unknown external effect. Не включать глобально retries всем 18 стадиям и не удалять attempt ledger по одному названию PURE_COMPUTE. Любое дальнейшее упрощение executor требует отдельного доказательства воспроизводимости результата и сохранения audit/authority/retention semantics.

Cloudflare memoization не превращает произвольный внешний HTTP/model call в exactly-once. Подтверждённый внешний результат можно прочитать повторно; неизвестную отправку нельзя повторить без provider idempotency/readback.

## 5. DOCS и migrations

Уточнить §7.7 и существующий failure-model: нормальное WAITING отличается от `WORKFLOW_EFFECT_UNCERTAIN`; event — notification, D1/R2 — authority. Добавить effect/wait mapping только для затронутого handler generation, не новый универсальный реестр.

Если outbox event schema или ограничения D1 нужно расширить — новая forward migration с номером, выбранным после актуального main. Не редактировать старые миграции и не резервировать отменённую 0121. Исторический production-run 11/18 не запускать повторно для этой задачи.

## 6. Приёмка

- Result committed до wait, во время wait и после timeout: каждый путь потребляет один exact result без нового task/model call.
- Потерянный result ACK / sendEvent ACK / duplicate callback / native restart не удваивают платные эффекты.
- Foreign task/digest, revoked grant, expired lease, cancellation, purged evidence и malformed event не переходят к успешному settlement.
- Failure до внешней отправки отличается от unknown после неё; first cause не заменяется бюджетной ошибкой.
- Старые handler generations/recover requests читаются прежним способом. Новый wait step не меняет replay-последовательность уже начатого старого instance.
- Нет полного task/result/evidence payload в событии, нет bearer URL или raw source в логах.

## 7. Проверки / зависимости

Независим от UI и managed-search rewrite. Общие codecs/SQL этой задачи меняет один integrator; #325 может одновременно менять branch model semantics, но не `external-agent-task-store` и MCP wake.

Code-first: `pnpm exec tsc -b packages/cloudflare-workflows/tsconfig.json packages/cloudflare-workspace-mcp/tsconfig.json packages/cloudflare-research-runtime/tsconfig.json --pretty false`; scoped ESLint по изменённым файлам; при SQL — `pnpm d1:depth`. Использовать существующие recovery/external-task native fixtures после сборки. Не подменять native wait тестом локальной Promise.

Все implementation/compiler/behavioral/native результаты этого задания пока PENDING. Нет deployment, paid calls, backup, новой Queue/K2 и GitHub-комментариев.
