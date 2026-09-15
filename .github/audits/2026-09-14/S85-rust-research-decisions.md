# S85 — Rust family: Research freeze/acceptance/reopen/publication decisions

База a2aca127; ER-08/10/11/12/40. Target `eliotr-research-core` с existing state/coverage primitives. Принятые protocol/obligations #227/#230/#232 и publication #246 — актуальный reference, не старые deterministic placeholders.

## 1. Суть
Rust port должен переносить содержательные решения, а не закреплять фиктивное «18 шагов = готовое исследование». Named-verifier acceptance и authorizing publication не могут назначаться моделью.

## 2. Что сделать
Перенести чистые W1 transitions, freeze lineage/claim-audit acceptance, terminal disposition/reopen и D0–D3 publication admission. Выполнение моделей, Workflow step, D1 CAS и R2 publication остаются TypeScript.

## 3. Документация / grep
[Launch09 K4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md), [канон§7.4/§7.11/§9.6](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'K4.research freeze/audit/completion' -- docs/implementation/launch-prs/09-rust.md
```

## 4. Как сделать
Явный input включает current W1 revision, registered protocol/lanes, obligations, named verifier certificates, exact evidence/freeze refs, debts, requested transition и policy observations. Caller prose/confidence не authority. Сохранить девять existing dispositions и reasons/next probes, exploratory/confirmatory separation. Post-exposure rule change — deviation/reopen, не незаметная правка. Publication edited content не наследует старую проверку. Из pure decision возвращать предложение события/typed refusal; SQL окончательно проверяет неизменившуюся authority при commit. Не создавать новый Workflow engine, review system или language-specific alternate API.

## 5. Критерии выполнения
- TS/native/Wasm совпадают для всех legal W1 transitions, nine terminal cases, required-verifier/waiver/grade и D0–D3 decisions.
- Technical checkpoint/self-approval, post-freeze evidence mutation, post-exposure metric change, missing material claim support и stale publication отказаны.
- Cancel/reopen не стирают прошлые receipts; currentness/history fixes сохраняются.
- Mutation/state-machine properties обнаруживают пропущенную проверку; existing product-chain tests после S89, pure Rust gates/fixtures/SHA. До promotion TS остаётся единственным исполняемым решением.
