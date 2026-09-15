# S81 — Rust family: policy/disclosure/residency decisions

База a2aca127; ER-03/40. Target `eliotr-policy`/`eliotr-residency` по языковому контракту; один shared pure policy input, не независимые повторные авторизации. Принятые #202/#261/#262 semantics обязательны.

## 1. Суть
Правильная сериализация policy не проверяет её применение. TS→Rust перенос должен сохранить порядок запретов, taint/effect ceilings, retention и ограничения model/client disclosure.

## 2. Что сделать
Перенести чистый fixed-order evaluator, ObjectResidencyKey admissibility/reuse decision и существующее deterministic Budget Governor решение. Native Gateway requests, reservations/D1, JWT verification и encryption I/O остаются TS/платформе.

## 3. Документация / grep
[ER-03](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-03-policy-disclosure-and-injection-boundary.md), [Language§3/§10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F 'Implement fixed-order policy evaluation' -- docs/agent-work/ER-03-policy-disclosure-and-injection-boundary.md
```

## 4. Как сделать
Вход — validated explicit facts: principal/source/task/client/inference/retention/license/purge, receipt references, observed time, usage/quote. Сохранять existing numeric units, no float-rounding cost drift. Unknown load-bearing inputs fail closed. Viewer permit не усиливает model/client permit; receipt-based declassification не заменять boolean из request. Одинаковый content hash в разных residency/key/retention доменах не разрешает co-residency. Effective grant сохраняет issuer/grantor/grantee различие. Версионированные fixtures запускают один decision на TS/native/Wasm; no network, clock, global state или криптографическое доверие непроверенному input. Budget exhaustion не блокирует permitted exact evidence access.

## 5. Критерии выполнения
- Положительные/отрицательные matrix cases всех policy axes совпадают по decision/reason/order/receipt identity; no stronger Rust result.
- Cross-residency/key reuse, hidden inference disclosure, late revoke и quote overflow/missing context отказаны; viewer-only и budget-stop evidence reads корректны.
- Property/mutation tests ловят удаление любого load-bearing запрета; pure Rust gates проходят.
- Existing SQL transactional enforcement сохраняется; runtime shadow/promotion S88/S89 отдельно. Exact fixtures/callers/SHA, не новый policy framework.
