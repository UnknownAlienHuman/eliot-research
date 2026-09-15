# S71 — наблюдаемость, понятные отказы и штатные spend controls

База a2aca127; ER-17/26. Опирается на ошибки S17/#209 и findings S68/#260, но instrumentation самостоятельных путей не ждёт всю систему.

## 1. Суть
Health READY означает только доступность проверенных компонентов, не качество Research. Пользователь должен отличать недоступную модель, заблокированную политику, stale индекс, DLQ и застрявший run без прямого SQL.

## 2. Что сделать
Заполнить существующие content-free metrics/health/readiness: latency, conflicts, outbox age, retries/DLQ, индексная generation/readiness, citation failures, model/transport degradation, erasure deadlines, usage/cost. Связать их с единым existing Connections/details и доступным alert sink; не строить отдельный monitoring backend.

## 3. Документация / grep
[Production readiness, Phase12](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md).
```sh
git grep -n -F '## 14. Phase 12 — establish observability, SLOs and spend controls' -- docs/implementation/production-readiness-plan.md
```

## 4. Как сделать
Переиспользовать `packages/platform-cloudflare/src/observability.ts`, Analytics Engine binding, health/diagnostic readers, native AI Gateway limits и имеющийся Budget Governor. Результат измерения указывает operation kind/generation/trace и длительность, но не prompt/source/private path/credential. Сохранить 100% наблюдение security/erasure/DEEP/AUDIT/REPORT failures по канону; обычную sampling policy не выдавать за полноту. SLO измерять для отдельных продуктов, не среднее всего Worker. Missing telemetry/sink явно unknown/degraded, не zero errors. Никакого нового финансового продукта: существующие usage/reservations/readback лишь сделать наблюдаемыми. Budget exhaustion оставляет разрешённые exact/open/trace операции доступными.

## 5. Критерии выполнения
- Инъекции auth/model/index/Queue/erasure failures дают правильный origin/trace и действие владельцу, не требуют SQL для диагноза.
- Телеметрия различает unknown от zero; настроенный sink реально получает тестовое уведомление, отсутствие sink не скрыто.
- Log/metric scanning fixtures не находят секретов/source/prompts; расходы согласованы с existing receipts, повтор не удваивает их.
- Read-only evidence работает при исчерпанном модельном бюджете. Actual storage/HTTP metric tests, отдельный sink/native limit receipt, exact SHA.
