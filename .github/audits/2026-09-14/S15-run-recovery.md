# S15 — восстановить run без повторного оплаченного синтеза

База a2aca127; ER-09/21/24. Proposed API согласован с #206. Это задание, не готовый endpoint.

## 1. Суть
После committed SYNTHESIZE временный read failure в VERIFY должен восстанавливаться в том же run. Общий счётчик оплаченных вызовов не обязан оставаться прежним: ещё не выполненный AUDIT_CLAIMS законно вызывается впервые. Не допускать дублей уже исполненного и не отключать необходимый аудит ради теста.

## 2. Что сделать
POST `/api/v1/research/run/:workflow_id/recover`, body `{}`, existing Idempotency-Key. Ответ200 — existing ResearchRunStatus, когда канонический outcome/восстановленный ACTIVE подтверждён; 503 retryable — ещё неопределённое settlement; 409 — canonical CANCELLED, incompatible state или недоказуемый повтор UNKNOWN provider effect. Already completed→200 с прежним статусом, без запуска. Foreign/missing→одинаковый404, revoked403, malformed/unknown input fields400. Endpoint создаётся в существующем run service, не новый job engine.

## 3. Документация / grep
[Канон §7.7.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [Execution contract §3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).
```sh
git grep -n -F 'A lost ACK is UNKNOWN' -- docs/implementation/launch-prs/execution-contract.md
git grep -n -F 'recoverStartedAttempt' -- apps/eliotr-core/src packages/cloudflare-research/src packages/cloudflare-research-stages/src
```
[Cloudflare Workers API](https://developers.cloudflare.com/workflows/build/workers-api/), проверено2026-09-14: native resume применим к paused, restart сбрасывает state, restart-from-step сохраняет прошлые результаты. Проверить точную API-форму по закреплённым runtime/types, не обновлять зависимости молча.

## 4. Как сделать
Проверить owner либо explicit recover grant #202. Переиспользовать W2/W3 attempt state и recoverStartedAttempt. Прежде native lifecycle action читать канонический current attempt/output/receipt и classify: safe read retry, recorded output recovery, UNKNOWN upstream. Одновременные recover запросы выбирают один recovery action через существующую attempt/CAS дисциплину; два restart одновременно не допускаются. Повтор Idempotency-Key возвращает текущий подтверждённый outcome прежнего action, не новый run.

Native engine status выбирает подходящий lifecycle вызов; D1/R2 остаются authoritative, ранее committed stages восстанавливаются из receipts без model calls даже при очистке native intermediate state. Recovery не снимает revoke/cancel, не меняет scope/freeze/handler или operation ID. Для несовместимого deployment использовать результат #197; истечение authority обрабатывает отдельный S33. Новые следующие model stages проходят прежнюю spend policy/quote/reservation, не новый финансовый контур.

## 5. Критерии выполнения
- Fixture: до read failure SYNTHESIZE=1 committed/AUDIT=0; qualification/config фиксированы. После recovery SYNTHESIZE=1 с тем же hash/receipt, AUDIT=1 со своей штатной reservation, тот же run до законного результата.
- Concurrent/repeated recovery и lost ACK не повторяют synthesis/audit/restart effects; completed recovery повторно не оплачивается.
- UNKNOWN provider effect остаётся unresolved до доказуемого readback. Invalid/cancelled/revoked/corrupt state не превращается в transient retry.
- Недостаточный бюджет на ещё не начатый audit даёт штатный ограниченный outcome; audit не пропускается ради completion.
- Persisted D1/R2 rows/objects, HTTP tests, exact SHA и результаты. Native Cloudflare lifecycle acceptance после разрешённого deployment отдельно от controlled-provider tests. S32 выводит те же действия в PWA/MCP.
