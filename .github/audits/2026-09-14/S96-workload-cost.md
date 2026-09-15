# S96 — T6: измеренные capacity, latency и расходы

База a2aca127; ER-35/17/26. Inputs: attested staging #286, instrumentation #263, build measurements #282 и работоспособные продуктовые пути. Harness можно написать до live-параметров; живую нагрузку выполнять только на разрешённой цели и бюджете.

## 1. Суть
Большой объём исходников не доказывает плохую runtime-производительность, а наличие мощностей Cloudflare не устраняет D1 contention, бессмысленные model calls или очереди повторов. Нужны реальные per-operation measurements.

## 2. Что сделать
Воспроизвести канонический workload: 5/20/50 read agents, 5 interactive sessions, 10 queued ingest/projection jobs и 2 concurrent long Research Workflows. Отдельно измерить дешёвые read/open, model-backed run, indexing и upgrade/recovery; проверить overload, не тестировать бесконечно до случайного зелёного прогона.

## 3. Документация / grep
[Production readiness Phase13](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md).
```sh
git grep -n -F '## 15. Phase 13 — execute T6 workload and performance qualification' -- docs/implementation/production-readiness-plan.md
```

## 4. Как сделать
Использовать existing workload/probe tools; внешний load driver не является вторым backend. Входы фиксируют build/config/corpus, concurrency mix, duration/warmup, repetitions, allowed maximum spend и stop condition; значения получены от оператора/действующего профиля, не выдуманы. Считать p50/p95/p99 по успешным и ошибочным операциям отдельно, throughput, D1 conflicts/queue lag, R2/AI Search latency, Workflow checkpoints/DO reconnect и memory. Cold/warm отдельно; source/result size и cache-hit ratio известны. External unknown effects не возобновлять ради измерения. Usage берётся из actual receipts/provider reporting; estimated cost обозначать estimate, bill — отдельно когда доступен. Нормативные targets #282 сохранить; не подставлять vendor maximum как целевой SLO. Rust vs TS сравнивать одинаковую family/input и один эффект. Overload отвечает bounded retryable state с backoff, не теряет already-admitted jobs и не усиливает coverage/disposition.

## 5. Критерии выполнения
- Есть воспроизводимый отчёт по каждому workload/operation с samples, percentiles/errors, CPU/memory/throughput/usage/cost и условиями опыта, не одиночный средний показатель.
- Прошли канонические bundle/startup/PWA bounds и применимые p95/SLO/spend цели выбранного профиля; неизвестная цель/неизмеренный показатель явно не принят.
- Overload/cancel/restart не создают unbounded buffers/loops/duplicate paid calls; очередь восстанавливается, authorized exact evidence доступен при model-budget stop.
- Выявленные bottlenecks направлены в owning existing task с before/after измерением; никакого повышения норматива ради PASS. Live execution и первый фактический месячный счёт не подменяются локальной симуляцией. Exact SHA/команды/receipts сохранены.
