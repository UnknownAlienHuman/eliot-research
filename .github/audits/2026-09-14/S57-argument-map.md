# S57 — ArgumentMap с source spans, не свободный GraphRAG

База a2aca127; ER-32/06/10; inputs qualified maps #240, atoms #248 где нужны. Не нужно ждать всех unrelated product PR.

## 1. Суть
Граф keywords/co-occurrences не объясняет аргумент и не доказывает causal relation. Канон требует source-local problem→premises→evidence→claims→limitations/objections.

## 2. Что сделать
Закончить existing ArgumentMap contracts/ports и persist relation ledger: node/edge identities, source revision, exact support spans, precision class, unresolved objections. Подключить ARGUMENT navigation/retrieval к authorized readers, не отдельную graph DB.

## 3. Документация / grep
[Канон §5.4, §6.11](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 5.4. ArgumentMap' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'No graph database in v1.' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Reuse D1 relation ledger + immutable graph view in existing stores. Native/deterministic/parser-derived/model-candidate/human-reviewed precision сохраняется отдельно; model-inferred edge не становится source-native assertion. Edges должны указывать на source passages и distinguish author reasoning versus external validation. Cross-source link требует разрешения обоих источников и явной lineage, не evidence independence из количества nodes. Same trigger/revision/extractor generation idempotent, full-source blanket distillation не запускать. Purge/update invalidation связывается с #247; view expansion имеет bounded authorized traversal и не уходит в бесконечный cycle.

## 5. Критерии выполнения
Claim/premise/objection/alternative fixture восстанавливает исходный аргумент и exact spans. Co-occurrence→causal, recommendation→decision, fake/foreign edge и cropped negation отказаны либо остаются unaccepted model candidates. Cyclic/oversized expansion ограничивается существующими byte/step budgets без whole-corpus load. ARGUMENT query и navigation не выдают graph edge за final truth; actual storage/replay/purge tests/SHA.
