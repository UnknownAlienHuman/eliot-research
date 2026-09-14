# S46 — DEEP_RESEARCH как законченная композиция, не новый агент

База a2aca127; ER-08/09/10/11; uses #227–#232 и #214. Только product composition поверх этих checkpoint-ов.

## 1. Суть
18 завершённых steps или модель FRONTIER не дают E2/E3 исследования. DEEP требует явной процедуры, альтернатив, controlled acquisition, freeze/audit/debts/coverage.

## 2. Что сделать
Связать approved DEEP_RESEARCH profile с существующим Workflow: protocol/portfolio/branches/acquisition/counter/reconcile/freeze/synthesis/audit/materialization. Разделить selected model capability, execution product и required Evidence Grade в request/status/report. Не реализовывать ещё один lead agent loop.

## 3. Документация / grep
[Канон §7.12 и §8](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'An E2/E3 Investigation with explicit protocol' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Profile compilation #227 назначает обязательные branches/verifiers; каждая использует existing bounded-context/W3 и source policies. Corpus-only и corpus-plus-web — разные allowed routes. После freeze никакого silent self-improving rerun; дополнительный запрос регистрируется как debt/reopen. Зафиксированные stop/deadline/cancel прекращают новый расход, не выбрасывают полезный partial result. Context handoff/restart читает W1/R2, не summary предыдущего агента. Missing independence/verifier не исправлять lowered grade или словом validated. Existing real synthesis и claim audit сохраняются.

## 5. Критерии выполнения
Два независимых source families+counter case проходит ожидаемые E2 obligations; E3-confirmatory case требует registration/verifier #230. Один vendor/unknown denominator выдаёт честный partial/inconclusive result с next probe, не fabricated E2/E3. Long-run recovery, provider switch только по явной версии, model spend по прежней policy. В одном actual Workflow выполнены все требуемые результаты и открываются citations; tests/SHA отдельно от поздних real-model quality measures.
