# S86 — Rust family: erasure closure и terminal admissibility

База a2aca127; ER-28/40. Target `eliotr-erasure-core`; actual deletion adapters из #255 не переносить в Rust. Полная identity/policy semantics из #270/#273.

## 1. Суть
PURGED допустим только по полной проверенной closure. Языковая миграция не должна заменить evidence of absence на количество successful requests.

## 2. Что сделать
Перенести чистые closure normalization/identity matching, hold/retention conflict и terminal-completion decision. Вход — expected managed locations + observed exact absence/blocked records + current purge/ownership facts; выход — typed complete/blocked/pending решение существующего контракта.

## 3. Документация / grep
[Launch09 K4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md).
```sh
git grep -n -F 'K4.erasure exact closure' -- docs/implementation/launch-prs/09-rust.md
```

## 4. Как сделать
Использовать текущие erasure schemas и coordinator decisions как effect-free функции. Scope/domain/object/version совпадают точно; duplicate receipt не заменяет missing member. Переданные observations получены TS adapters, а не неподписанным клиентским утверждением. Hold/review date/expiry проверяются относительно injected time. Purge ledger append/absence fetch/delete остаются в D1/TS; Rust не hard-delete и не создаёт новую очередь. Не менять предыдущие tombstones/receipts для достижения parity.

## 5. Критерии выполнения
- Full closure/partial/missing/duplicate/wrong-domain/wrong-version/retention-lock cases совпадают TS/native/Wasm.
- Поздний новый dependency делает прежнюю completion evidence недостаточной; no resurrection/foreign deletion.
- Mutation снятия одной closure проверки обнаруживается; existing #255 purge/restart/hold tests сохранены.
- Pure crate без I/O/clock, применимые Rust gates проходят; exact SHA/fixtures/results и последующий S89 caller switch отдельно.
