# S54 — accepted artifact и Wiki promotion без подмены доказательств

База a2aca127; ER-10/11/12/13/24; #245 COW и existing Wiki publisher. Saved DRAFT и ручная публикация Wiki уже есть; accepted REPORT semantics остаются open.

## 1. Суть
Кнопка Publish, completed model audit или owner edit сами по себе не делают material statements SOURCE_SUPPORTED. Нужен реальный publication barrier и корректные D0–D3 правила.

## 2. Что сделать
Подключить current freeze/section verification/claim support/disclosure/dependency checks к существующему accepted artifact head commit. Wiki/Draft Inbox: D0 deterministic; D1 только explicit project AutoPromotionPolicy+exact handles+no conflict+independent verifier; D2 verifier+owner/policy committer; D3 named authority only.

## 3. Документация / grep
[Канон §9.3/§9.5–9.6/§19.6](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 9.6. Draft Inbox without owner bottleneck' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Existing artifact/wiki ports and D1 head/CAS/outbox; R2 immutable body readback before head. Все accepted factual claims имеют exact support, а inference/hypothesis/contested/unresolved/recommendation labels сохраняют собственный смысл и не становятся facts. Inherited audit owner-edited body не поддерживает новые statements. Recheck policy/purge/current freeze and expected head в mutation, не только раньше в UI. Rejected publication сохраняет draft и понятные причины. Автопромоция идёт тем же publisher, не обходной SQL/cron; допускаемый D1 verifier не тот же автор, просто объявленный independent. Не добавлять новые financial/policy features сверх existing scope.

## 5. Критерии выполнения
Accepted citation resolution100%; cropped hedge/negation, stitched quote, missing number, stale freeze, revoked grant и purge during CAS не принимаются. D0/D1 positive, absent policy/verifier negative, D2/D3 auto-promotion forbidden. Concurrent publishers один победитель; lost response/readback не создаёт две heads. Manual published hypothesis допустима как hypothesis, не fake supported fact. Actual API/D1/R2 publication/reader tests и SHA; no success from fixture counts alone.
