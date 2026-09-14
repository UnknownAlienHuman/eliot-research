# S36 — сохраняемый вопрос, гипотезы и состав доказательств

База a2aca127; ER-08/10, после #227. Одна W1 planning-state операция, не graph database.

## 1. Суть
Без QuestionGraph/HypothesisCard/SourcePortfolio исследование не различает подзадачи, альтернативы и реальную независимость источников. Число retrieved chunks не заменяет этот состав.

## 2. Что сделать
Из approved protocol/obligations сохранить versioned question graph, необходимые hypothesis cards и SourcePortfolio с required/missing source classes и lineage/family. В graph связи — question/dependency, не свободные модельные causal edges. Для lookup пустой hypothesis set допустим и не требует LLM.

## 3. Документация / grep
[Канон §7.5–7.6 и Slice4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 7.5. SourcePortfolio and coverage denominator' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 7.6. HypothesisCard' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Расширить existing Investigation ledger commands/schema, reuse existing reference/residency primitives и W1 revision CAS. SourcePortfolio строить только из admitted source refs, отдельные незахваченные candidates перечислять как missing/acquisition tasks. Family identity не выводить только из URL/domain или количества providers: retained lineage, same-origin duplicates и неизвестная независимость должны быть видны. Hypothesis статус обновляется evidence+named verifier, не произвольным model score. Запись question graph, cards и portfolio имеет единую связанную W1 revision/readback; restart не реконструирует её из summary lead-агента. Branch handler читает именно этот persisted input.

## 5. Критерии выполнения
Два вопроса с общей предпосылкой имеют связанный graph, rival hypotheses не исчезают; десять копий одного источника не считаются десятью независимыми подтверждениями. Missing required class остаётся явным долгом. Foreign/unadmitted ref, циклическая dependency без допустимой semantics, stale CAS и retry не создают несогласованную revision. Exact ledger/API readback и factory integration tests с SHA; внешние графовые сервисы не добавляются.
