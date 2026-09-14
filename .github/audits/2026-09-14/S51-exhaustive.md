# S51 — EXHAUSTIVE действительно проходит весь frozen scope

База a2aca127; ER-04/07/09/30. Existing exhaustive-workflow-service, durable shard/cursor paths и cancel/status уже есть; дописывать только недостающий end-to-end loop.

## 1. Суть
Top-k no-hit не доказывает отсутствие. Полный scan должен учесть каждый eligible source/section, включая результаты за первой страницей и совпадения на границе чтения.

## 2. Что сделать
Admitted source→existing outbox/projection→EXHAUSTIVE_JOB→все shards→reconciled denominator→result artifact→status/open. Отсутствие разрешается только при complete authoritative scope, все остальные случаи явно partial/unknown.

## 3. Документация / grep
[Канон §6.10 и §19.4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 6.10. Exhaustive operations' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Reuse immutable scope/shard manifest/cursors, exact R2 scanner и Workflow checkpoint. Не использовать reranking/LLM для исключения denominator members. Streaming UTF-8/literal scan сохраняет overlap на границах ranges, canonical offsets и deterministic dedup. Reconcile проверяет уникальные shard identities, expected source set, failed/omitted shards и manifest hashes до COMPLETE_SCOPE. Сборка большого результата в R2, HTTP возвращает handles/cursor, не весь корпус в памяти. Existing cancellation и real currentness проверяются между порциями. Catalog pagination не может превратиться в denominator без доказанной последней страницы.

## 5. Критерии выполнения
Совпадение после top-k/page и на границе UTF-8 range найдено; independent oracle даёт100% exact all-occurrence recall на fixture. Missing/duplicate/failed shard не даёт complete; restart/lost ACK сходятся без двойных counts. Purge/revoke/deadline/cancel не produce false absence. Actual imported corpus+D1/R2/Workflow/API tests, compact result readback и SHA. Existing schema/profile bound не повышать произвольным числом: larger logical scopes отдельный S80.
