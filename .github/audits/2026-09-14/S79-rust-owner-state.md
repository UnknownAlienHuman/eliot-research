# S79 — Rust family: owner lifecycle и cutover

База a2aca127; ER-02/40/13. Вход — исправленный TypeScript domain и S70/#262 cases; identity primitives S78/#270. Target из языкового контракта: `eliotr-state-machines`; не новый сервис.

## 1. Суть
Byte parity owner-token не проверяет разрешённость перехода владельца. Нужна чистая Rust authority для lifecycle/fence/cutover, сохраняя transactional CAS в SQL.

## 2. Что сделать
Перенести только чистое решение: observed owner/incarnation/fence + proposed command + bilateral receipt facts → typed transition/denial. Source acquisition, D1 writes и R2 transfer остаются TypeScript adapters.

## 3. Документация / grep
[Launch09 K3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md), [Language§10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F 'K3.owner lifecycle/cutover' -- docs/implementation/launch-prs/09-rust.md
```

## 4. Как сделать
Extract actual accepted domain decision, перечислить states/commands из существующих schemas, а не придумывать новый enum. Вход содержит все observed facts и время явно; Rust не читает сеть/clock/DB. Использовать общие canonical fixtures и общий Wasm envelope, никакого самостоятельного parser/receipt schema. Compare TS/native/Wasm outcomes включая exact denial codes. После pure decision SQL ещё проверяет current row/CAS, поэтому успешное чистое решение не является commit receipt. Новое поле требует versioned fixture; known TS defect исправить и проверить до объявления паритета.

## 5. Критерии выполнения
- Valid bilateral transfer/initialization/retire cases имеют одинаковые transition/IDs/error outcomes на TS/native/Wasm.
- Unilateral receipt, stale fence/incarnation, changed set/view, replay другого command и попытка resurrection отказаны.
- Property/mutation test ловит разрешение двух owners/пропущенный fence; существующие D1 race tests сохраняются.
- Pure crate проходит fmt/clippy/nextest/deny/coverage применимых existing gates; no I/O/unsafe. Runtime promotion и удаление TS — S89, не заявляются этим checkpoint; exact SHA.
