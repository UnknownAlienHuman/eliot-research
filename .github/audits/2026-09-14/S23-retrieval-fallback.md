# S23 — отделить fallback начала документов от релевантного поиска

База `a2aca127`; F07. SEM wiring решается в S09/#201; не дублировать его здесь.

## 1. Суть
`selectedDocumentFallbackCandidates` выбирает ранние секции по normalized_start_byte и выдаёт их как LEX candidates при отсутствии прямых совпадений. Bytes настоящие, но их релевантность вопросу этим не доказана.

## 2. Что сделать
Сделать fallback явно ограниченной ориентацией, не ложным lexical hit. Проверить, что он не вытесняет реальные SEM/exact результаты и не поддерживает completeness/absence claims.

## 3. Документация
[Канон §0, §6.12 и §7.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'One top-k RAG pass' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 6.12. Retrieval trace' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'selectedDocumentFallbackCandidates' -- apps/eliotr-core/src
```

## 4. Как сделать
Использовать существующий `selected_document_fallback` metadata и retrieval trace; не создавать второй search engine. Добавить небольшой размеченный fixture: ответ в конце, противоречие вне первых секций, релевантная секция только через SEM. Сравнить direct retrieval и fallback в сборке EvidencePack. При недостатке evidence выдавать честный ограниченный ответ/next probe, не уверенный вывод из intro. Сохранять scope и exact resolver.

## 5. Критерии выполнения
- По trace/result различимы реальный hit и fallback orientation.
- Релевантный SEM/exact фрагмент не вытеснен произвольным intro.
- Ответ/контрпример в tail fixture не заменён утверждением об отсутствии.
- Unknown/sampled coverage остаётся честным; нет whole-corpus buffering или blanket model calls.
- Измерения fixture до/после, tests и exact SHA приведены; нет выдуманного live Recall score.
