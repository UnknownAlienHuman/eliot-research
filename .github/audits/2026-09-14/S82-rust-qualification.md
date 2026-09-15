# S82 — Rust family: SourceAdmission и qualification

База a2aca127; ER-29/40. Target `eliotr-qualification`/contract-core; native `eliotr-bundle-cli` только как тонкая offline-обвязка. Опирается на реальные format/admission cases #239/#262, не повторяет external parsing.

## 1. Суть
Parser success не доказывает admission, координаты или assurance. Перенос в Rust должен сохранить текущие typed ограничения и candidate-only состояние до канонического commit.

## 2. Что сделать
Перенести deterministic candidate/normalized manifest validation, qualification/precision lowering, ownership/residency admission decision. Дать native offline bundle verifier над той же логикой; его успешный результат не выдаёт grants и не создаёт SourceRevision.

## 3. Документация / grep
[ER-29](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-29-source-acquisition-admission-and-qualification.md), [Language ownership matrix](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F 'Absent mappings lower precision.' -- docs/agent-work/ER-29-source-acquisition-admission-and-qualification.md
```

## 4. Как сделать
Reuse current strict source/library schemas, domain/source-admission.ts и qualification.ts; canonical parser/IDs из S78. Pure Rust получает verified byte identities и bounded metadata, не сам читает D1/R2/Google. Hash больших native files считывать streaming в CLI adapter, а domain rules оставить effect-free. Managed conversion/OCR/PDF остаются внешними и TS bindings, не переносить движок в Worker. Unknown load-bearing fields, missing cutover receipt и mismatched coordinate map дают прежние typed outcome. Native tool возвращает bounded machine-readable report/exit status, не пишет credentials/содержание документа в лог.

## 5. Критерии выполнения
- TS/native/Wasm одинаково принимают/карантинируют/отклоняют valid, corrupt, partial, absent-map, foreign-owner, wrong-residency и unknown-field corpus.
- Наличие Markdown не превращается в native-page accuracy; кандидаты не admitted автоматически.
- CLI positive/negative/repeated invocation проверен Windows/Linux, не мутирует bundle и не выполняет remote calls.
- Existing Rust gates/fixtures и actual ingress tests сохранены, pure code без I/O; runtime promotion отдельно. Exact SHA/результаты.
