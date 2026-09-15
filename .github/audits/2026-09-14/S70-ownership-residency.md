# S70 — source ownership, residency и явные snapshot imports

База a2aca127; ER-02/03/14/29/30. Приоритет интеграционной проверки существующих механизмов, не новый ownership service.

## 1. Суть
Общий документ двух проектов не означает двух mutable owners; одинаковые bytes не разрешают dedup между разными ключами/retention/disclosure. Unsaved editor content нельзя сохранять неявно.

## 2. Что сделать
Через существующий normalized-bundle/ingest API закончить и проверить три границы одного SourceRevision admission: exact origin owner/view, complete ObjectResidencyKey, отдельный двусторонний source.owner-cutover.v1 при передаче владельца.

## 3. Документация / grep
[Канон v29.1](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [ER-29](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-29-source-acquisition-admission-and-qualification.md).
```sh
git grep -n -F 'Submit unsaved editor bytes without explicit snapshot origin/view/policy receipt' -- docs/agent-work/ER-29-source-acquisition-admission-and-qualification.md
git grep -n -F 'source.owner-cutover.v1' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Переиспользовать ownership/cutover domain, admission service и existing bundle schema. Ordinary external import сохраняет external owner lineage; becoming mutable owner требует настоящие prior/new owner authorizations и exact source-set/view binding, не флаг. После cutover старые writer/fence credentials не меняют источник. Проверять residency до reuse object/key; один проектный membership не даёт раскрытие данных. Explicit unsaved snapshot записывает отдельную revision/view только при заданной разрешённой операции, не следит за буфером автоматически. Recovery после частичного cutover продолжает прежнюю identity, не допускает двух ACTIVE owners.

## 5. Критерии выполнения
- Shared-source two-project fixture сохраняет одну canonical identity и проверяемые разные permissions.
- Foreign unilateral cutover, stale owner, mismatched revision set, cross-residency equal-byte reuse и unsaved-without-consent отказаны до write.
- Bilateral authorized cutover сходится при lost ACK/restart к одному владельцу; old writer отказан; historical revisions/receipts сохраняются.
- Actual ingest/D1/R2 tests используют текущие contract fixtures; отсутствующий external peer receipt не подменяется assertion. Exact SHA/результаты и тип precision/disclosure записаны.
