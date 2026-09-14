# S52 — generation A обслуживает поиск, пока B не доказана и не переключена

База a2aca127; ER-05/16/38. Existing managed generation registry/provisioners required by canon; не удалять и не переписывать AI Search internals.

## 1. Суть
uploadAndPoll или Queue ACK не доказывают completeness/activation. Reindex и обычное индексирование должны исходить из canonical admitted sources, а не preseeded index fixture.

## 2. Что сделать
Закрыть source admission→outbox→D1 IDENT/LEX+managed projection→per-channel readiness и A→shadow B→verified expected-head switch→rollback A. Реализовать недостающую связь existing stores/consumer/promoter, не вторую registry.

## 3. Документация / grep
[Канон §6.4.2, §19.10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 6.4.2. Embedding generation migration' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Проекция — stable sections/context headers/maps; source in multiple projects создаёт только предусмотренные projection copies внутри разрешённой residency. Freeze item manifest/count/digests и generation config. Пока B неполна, A остаётся serving, queries pin A. B switch лишь после exact readback, completeness и golden/latency/cost evidence по существующим policies. No raw vector-score mixing. Failed/cancelled migration не переключает head; concurrent promotions CAS. Updates/purge во время build учитываются через current watermark/deny checks до activation, не оставляют erased influence. Старые generations хранить по существующему rollback policy, не бесконечно.

## 5. Критерии выполнения
Фактически импортированные sources находят IDENT/LEX/SEM, stale/partial channel явно degraded. Incomplete/foreign item B никогда ACTIVE; lost upload/switch ACK/restart converge, один head winner. A queries продолжаются во время B; rollback сохраняет текущий purge frontier. Local storage+controlled platform lifecycle tests/SHA, реальные native AI Search item/readback/promotion/latency receipts после разрешённого staging. Новые cap/finance tools не нужны.
