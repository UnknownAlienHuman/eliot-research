# S22 — реальный counter-search внутри выбранного корпуса

База `a2aca127`; F06. Детализация #92, не реализация всех исследовательских продуктов сразу.

## 1. Суть
COUNTER_SEARCH сейчас может закончиться техническим checkpoint без поиска опровержений. Для протокола, требующего counterevidence, это незавершённая функция; отметка 18/18 не закрывает её.

## 2. Что сделать
Реализовать одну corpus-only ветвь контрпоиска через существующий retrieval и evidence ledger до FREEZE_EVIDENCE. Не добавлять web crawler, swarm framework или второй Workflow.

## 3. Документация
[ELIOT_RESEARCH §7.2, §7.8, §7.9](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'counter_search_required:' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 7.8. Research branches' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
В existing stage factory подключить handler, который читает frozen protocol и сформулированный предмет проверки, ищет в разрешённом corpus и разрешает кандидатов в exact EvidenceHandles. Использовать текущую отмену/бюджет. Сохранить найденные counterevidence и неуспешные проверки в существующей модели; Synthesis/Audit должны получить этот материал после reconciliation/freeze. Не навязывать counter-search простому lookup, где protocol его не требует. Его успех сам по себе не делает E2/E3.

## 5. Критерии выполнения
- Fixture с явным противоречащим источником даёт counterevidence в freeze и итоговом audit/report.
- Опровержение вне leading sections действительно найдено, а не заранее подставлено.
- No-hit в sampled scope не превращается в доказанное отсутствие опровержений.
- Foreign/purged hits и budget/cancel обработаны; replay не повторяет сохранённый этап.
- Проверен реальный stage chain с D1/R2; незавершённые прочие stages не объявлены выполненными.
