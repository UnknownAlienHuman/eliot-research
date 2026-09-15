# S93 — T2/T3: проверить качество, а не только факт ответа

База a2aca127; ER-23/27. Existing Golden corpus GC-009–012 и assertions сохранить. Большая качественная приёмка идёт после завершения соответствующего кода; её fixtures можно готовить заранее.

## 1. Суть
Один успешный run на двух документах не доказывает полноту большого корпуса, корректный semantic retrieval, research reasoning и устойчивость противоречий.

## 2. Что сделать
Расширить existing adjudicated corpus и runner по продуктам LOCATE/ASK/BRIEF/COMPARE/HYPOTHESIS_REVIEW/FACT_CHECK/PROJECT_VS_LITERATURE_AUDIT/DEEP/REPORT; измерить отдельные показатели и проверить канонические thresholds, не одну «общую точность».

## 3. Документация / grep
[Production plan Phase9](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md), канон§19.2–19.5/19.8.
```sh
git grep -n -F '## 11. Phase 9 — build and adjudicate the real T2/T3 corpus' -- docs/implementation/production-readiness-plan.md
```

## 4. Как сделать
Размечать независимые source spans, expected constraints/denominator, acceptable claims/limitations и negative collapse cases до запуска кандидата. Включить RU/EN, code/table/units, long/mixed/conversation exports, contradictory versions, answer beyond first sections, missing native maps, no-answer, injected instructions, shared families и scopes больше первой страницы. Ground truth не генерировать проверяемой моделью из её ответа. Использовать разрешённые обезличенные/синтетические источники с указанным происхождением, реальные документы только с правом использования. Разделить tuning и holdout; фиксировать hashes/model/prompt/parser/index generations, число запросов, ошибки и повторяемость stochastic run. Порог из канона применить к соответствующей метрике; исходный Recall@20≥0.90 не переименовывать в 100% ответов. Accepted citation resolution и forbidden collapse отдельные строгие проверки. Controlled-provider tests не заменяют actual model/index quality.

## 5. Критерии выполнения
- Per-product отчёт содержит denominator/sample size, retrieval recall, exact byte/citation validity, support/contra handling, false positives/negatives, abstention/coverage и cost/latency там, где измерены.
- Нет accepted unsupported claims/forbidden collapses; sampled no-hit не complete absence. Известные failing cases остаются в отчёте и блокируют соответствующую qualification.
- Golden fixtures replay на прошлой/новой generation; плохой кандидат не promoted, rollback сохраняет проверенную generation.
- Actual provider/index прогон выполнен после разрешённого deployment/бюджета; unexecuted cells явно NOT_EXECUTED. Команды, exact SHA/config/corpus и retained results, без выдуманной статистики.
