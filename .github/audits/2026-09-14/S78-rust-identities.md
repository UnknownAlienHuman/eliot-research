# S78 — завершить M2 canonical/identity parity, не переписывая готовое

База a2aca127; F26, ER-40/01/00. Cargo workspace уже имеет canonical/test-vectors/kernel-wasm. K1 owner-token и K2a scope identity считаются исходным принятым материалом, не новой задачей. Production switch — отдельный S89.

## 1. Суть
CI-only Rust и наличие векторов не доказывают, что все production-critical identity families имеют проверенный byte-identical Rust path. Нельзя переносить сырые баги TS как норму или менять старые hashes при дедупликации.

## 2. Что сделать
Закрыть оставшиеся named K2b families через существующие модули/fixtures: canonical-body, stable-id, cutover serialization, ObjectResidencyKey, ingest/projection identities и фактически используемые evidence/manifest/publication/federation identities. Делать по одной family за implementation checkpoint; это конечный перечень проверки M2, не разрешение на массовую перепись.

## 3. Документация / grep
[Launch09](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md), [Language §8.3/§10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F 'K2b — remaining M2 identity/serialization parity' -- docs/implementation/launch-prs/09-rust.md
```

## 4. Как сделать
Reconcile actual `crates/eliotr-canonical`, existing fixtures и TS callers, включая изменения #220/#269. Один независимый fixture corpus запускается через TS/native/Wasm; golden bytes не вычисляются тем же тестируемым serializer. Для canonical-body.v1 — заявленный safe-integer subset и ECMAScript UTF-16 key ordering; не навязывать этот subset всем другим wire records. Проверять UTF-8/escapes/surrogates/astral keys/null/-0/границы, exact typed errors, domain-separated stable IDs. Не добавлять новый JSON parser per family. Оставшиеся mutation survivors учитывать совместно с #176, не создавать вторую mutation-систему. Изменение норматива/ошибки TS — versioned decision до переключения persisted identity.

## 5. Критерии выполнения
- Для каждой реально используемой identity family есть конкретный TS caller, Rust function и corpus/result; byte/hash/ID/error parity на native и compiled Wasm.
- K1/K2a и старые сохранённые fixture digests не регрессируют; malformed/oversized/foreign identity не принимается.
- Critical mutation/escape/order negative обнаруживается; coverage не заменяет семантическую проверку. `pnpm rust:check` и existing Rust deep gates применимы.
- Всё остаётся effect-free, production TS authority пока не удаляется. Таблица family→caller→fixture→receipt хранится в существующем Launch09/ER40, не новом реестре; exact SHA/results.
