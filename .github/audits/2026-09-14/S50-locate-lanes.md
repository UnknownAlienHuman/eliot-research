# S50 — LOCATE с буквальным поиском, diversity и structural context

База a2aca127; ER-04/06/07/16/24; #201 подключает потерянный binding, #215 исправляет leading fallback, #240 structural resolution. Их не реализовывать повторно.

## 1. Суть
FAST_SEARCH/одна semantic lane не покрывают canonical LOCATE. Нужна composition уже имеющихся planner/lanes/fusion с управляемыми literal/context/rerank операциями и честным trace.

## 2. Что сделать
Существующий query endpoint/codec должен поддерживать LOCATE: IDENT/EXACT сначала, затем применимые LEX/SEM/LITERAL, dedup по canonical section, source-family diversity, selective rerank и authorized parent/neighbor expansion до exact resolver. ORIENT использует Atlas #241; VERIFY_EXACT сохраняет точный direct path. Public values/версии согласовать с existing QueryRequest schema, не переименовывать работающий FAST_SEARCH.

## 3. Документация / grep
[Канон §6.5–6.9](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 6.7. Query pipeline' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 6.9. Query rewriting' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Reuse packages/retrieval planner/lanes/fusion и Cloudflare adapters. Managed chunking/embeddings/rerank не переписывать. Raw query/literals/negations сохранить; rewrites off default, visible subqueries в trace. Rerank получает relevant bounded window, не первые символы файла; exact identifier/quotes не гонять через model и не терять из-за score. Active generation pinned, raw vector scores разных generations не смешивать. Каждый managed locator проходит canonical policy/residency/purge+exact bytes, timeout/absent lane явно degraded. ATOM/ARGUMENT/WIKI/ARTIFACT lanes подключаются в задачах соответствующих canonical stores; не создавать пустые success executors здесь.

## 5. Критерии выполнения
Exact ID/quote fixture даёт те же bytes без reasoning calls; vague query и literal-outside-leading-window находят expected sections. Same-source duplicates не вытесняют независимые sources. Rewrite/negative/unknown-lane/provider-outage корректно отражены в trace, no false absence. Actual query→R2 evidence→persisted trace tests, currentness/replay/SHA; measured Recall@20 квалифицируется позже на реальной generation.
