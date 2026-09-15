# S67 — безопасный откат code/index без отката данных

База a2aca127; ER-26/24/38. Входы #197 (совместимость) и #244 (индексные generations). Restore #258 — другая операция, не предусловие разработки rollback.

## 1. Суть
Возврат старого Worker или индексного head не разрешает откатывать purge/policy/schema и resurrect отозванные данные. PWA-only continuity не доказывает upgrade/rollback backend.

## 2. Что сделать
В существующем deploy orchestrator реализовать проверяемый rollback выбранного точного build/index generation с readback. Сначала поддержать backend build, совместимый с текущей schema и сохранёнными handler generations; несовместимый откат отклонять до переключения.

## 3. Документация / grep
[Production plan §13](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md).
```sh
git grep -n -F 'Test Worker/index rollback independently from data restore.' -- docs/implementation/production-readiness-plan.md
```

## 4. Как сделать
Расширить existing deployment receipt/version readback и index expected-head switch. Проверить target code/schema/config/resource identities, current purge frontier и совместимость active runs. Исторический secret/config не восстанавливать по старому backup; использовать разрешённые текущие references. Не менять merged migrations, текущие source/Wiki/artifact heads или source ownership ради старого кода. Для несовместимого handler сохранить run и readable history, вывести конкретную причину/путь forward repair; не создавать replacement run. Native platform rollback — механизм, а не доказательство исправности приложения.

## 5. Критерии выполнения
- A→B→A на совместимой schema проходит с unchanged canonical heads/purge; активный совместимый run продолжает прежние checkpoints без повторных paid effects.
- Index B→A сохраняет exact resolver/current policy, deleted members не возвращаются в выдачу.
- Missing build, wrong resource/schema, несовместимый handler, stale CAS и lost ACK дают безопасное отказ/reaudit readback, не ложный успех.
- Есть local ordering tests, dry-run/readback и отдельный разрешённый native rollback receipt. Runbook содержит exact build identity и проверку результата, не кнопку «вернуть всё назад».
