# S56 — selective EvidenceAtoms, PaperProfile и project-document profile

База a2aca127; ER-32/10/39. Existing distillation/argument contracts/ports и exact resolver переиспользовать, нового graph/vector store не требуется.

## 1. Суть
Навигационные summary не сохраняют modality/conditions и не могут заменить exact source-local propositions. Полный LLM проход по всем абзацам при ingest запрещён каноном.

## 2. Что сделать
Подключить только перечисленные в каноне triggers к existing extraction/admission path: core source, active inquiry, repeated retrieval, comparison/audit/report, suspected contradiction, accepted dependency, explicit owner request. Persist EvidenceAtom со span/hash/handle, polarity/modality/units/conditions/population/time/extractor generation. PaperProfile и project-document profile сохраняют разные semantic fields по §§5.6–5.7.

## 3. Документация / grep
[Канон §5.5–5.7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 5.5. EvidenceAtom' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'Full LLM compilation of every paragraph at ingest is prohibited.' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Model candidate→deterministic strict schema+exact Evidence resolution→current scope/purge/residency→existing canonical write/outbox. Number/verbatim должны реально присутствовать; model cannot mint evidence ID. Scientific observations/inferences/recommendations/later review claims раздельны; project requirement/decision/implementation statement не взаимозаменяемы. ID содержит source/extractor/semantic identity и нужную residency, repeat trigger не оплачивает повторно тот же settled extraction. ATOM lane читает лишь admitted atoms с актуальными source refs и не считает derived atom независимым source. Rejected candidate сохраняется как отказ/diagnostic, не индексируется как fact.

## 5. Критерии выполнения
Recommendation→decision, hypothesis→finding, wrong unit/negation/population/time, fake span/foreign scope negatives отвергнуты. Positive paper/project atoms открывают exact source bytes; repeated trigger/restart converges. Ordinary unrelated ingest делает0 atom LLM calls; purge блокирует atom/ATOM retrieval. Actual source→trigger→candidate→admission→query tests, shared golden cases, exact SHA и measured quality позже.
