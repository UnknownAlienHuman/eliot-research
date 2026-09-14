# S44 — FACT_CHECK проверяет все входные утверждения

База a2aca127; ER-10/11/21; #227/#232. Existing claim audit работает для generated REPORT; не писать второй auditor.

## 1. Суть
Проверка generated claims не равна продукту проверки заданного человеком текста. Нельзя незаметно пропустить неудобное утверждение или заменить его более слабым.

## 2. Что сделать
Approved FACT_CHECK profile: сохранить original input text/hash и mapping каждого выделенного claim к original region, затем существующий retrieval→freeze→claim-audit→artifact. Отчёт для каждого claim содержит ровно канонический verdict, support/counterevidence, scope/precision и объяснение невыясненного.

## 3. Документация / grep
[Канон §7.9/§7.12/§19.3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'source may genuinely contain the required evidence' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Claim splitting — candidate transformation с сохраняемой original-span mapping; server выдаёт IDs и проверяет полный input coverage. Original input — предмет проверки, не свидетельство собственной истинности. Reuse existing AUDIT_CLAIMS schema/handler и exact resolver; отдельно source_satisfies_requirement и supplied_excerpt_supports_requirement. Cropped negation, stitched quote, wrong unit/population/version и unknown denominator не исправлять красивым paraphrase. Disputed claim не голосуется большинством моделей. Preserve raw input during normalization; no new public verdict enums.

## 5. Критерии выполнения
Набор из пяти claims даёт SUPPORTED/PARTIALLY_SUPPORTED/UNSUPPORTED/CONTRADICTED/NOT_VERIFIABLE_IN_SCOPE без потерянных input spans. Correct document+wrong excerpt не SUPPORTED; fake citation rejected. Model candidate deletion/rewriting input claim обнаруживается. Resume/replay сохраняет mapping и audit receipts. API→artifact/citation tests+SHA; real nuance quality отдельно, не заменять её controlled labels.
