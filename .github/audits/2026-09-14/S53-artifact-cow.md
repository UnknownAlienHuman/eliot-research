# S53 — REPORT редактируется по секциям, а не целиком заново

База a2aca127; ER-11/13/24. Existing artifact compiler/section stores/draft readers и Markdown export существуют; интегрировать недостающее, не новый report engine.

## 1. Суть
Сохранение одного DRAFT body не доказывает ArtifactSpec→section tree→reconciliation→ArtifactRevision. One-section change не должно регенерировать весь отчёт.

## 2. Что сделать
Завершить REPORT profile и COW section lifecycle: planned sections, per-section EvidenceLedger/verification/dependencies, deterministic assembly и versioned exports. Изменяется одна секция B, A/C сохраняют IDs/bytes там, где их evidence/context остаются действительными.

## 3. Документация / grep
[Канон §9.1–9.3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 9.2. Copy-on-write section tree' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Reuse immutable R2 section/revision/manifest and D1 expected-head+outbox. Section identity включает content/dependencies/residency; одинаковый текст не разрешает cross-domain key/ciphertext reuse. Сначала R2 write+exact readback, затем guarded CAS: нет cross-service transaction. Reconcile terminology/units/cross-section assumptions через existing verification pipeline; если B меняет premise A, A требует revalidation, не слепого reuse по body hash. Missing section/failed audit сохраняет DRAFT с limitations, не complete report. Existing export формируется из canonical tree и не становится единственным state; lost response rereads previous object/head. Предлагаемый section edit API должен reuse ArtifactSpec/ref/version contracts и expected_revision, не передавать model keys в PWA.

## 5. Критерии выполнения
Three-section report→B edit: A/C byte-identical refs и no unnecessary model calls, B новая revision с audit; deterministic export воспроизводим. Changed dependency заставляет targeted revalidation. Concurrent edits/CAS loser/lost R2 ACK/partial assembly не публикуют broken head. Revoke/purge/residency checks before commit/read, historical retained лишь пока policy допускает. Real storage/API tests, per-section call counts/hashes и exact SHA.
