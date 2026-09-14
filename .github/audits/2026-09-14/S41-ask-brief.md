# S41 — ASK/BRIEF работают как продукты, не как переименованный REPORT

База a2aca127; ER-08/10/11/25. Inputs #227/#232; existing synthesis/audit/readers сохранить.

## 1. Суть
Ограниченный document-to-DRAFT REPORT уже работает. Это не доказывает grounded iterative ASK или BRIEF с условиями, расхождениями и неизвестными.

## 2. Что сделать
Два approved product profiles над тем же run engine. ASK: ответ, evidence-backed conclusions отдельно от inference/assumption, next questions. BRIEF: ключевые findings/numbers с единицами/условиями, позиции источников, disagreements/limitations/unknowns. Profile ref выбирается через #227; внутренние execution-product enum и публичные product names связать явным versioned mapping, не переименовывать старые enums.

## 3. Документация / grep
[Канон §7.12](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 7.12. Research products' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Existing installed prompt/output schemas и Artifact sections; every material statement сохраняет ClaimAuditItem/exact handles. Follow-up ASK ссылается на предыдущую inquiry/artifact revision и текущий разрешённый scope; не пересылает весь неограниченный chat и не принимает старый ответ как первичный источник. Без новых facts допустимо использовать уже verified evidence; новые sources после freeze проходят #232. PWA/MCP показывают тот же persisted result. Simple direct FAST_SEARCH по-прежнему не вызывает reasoning model.

## 5. Критерии выполнения
RU/EN ASK→follow-up сохраняют конкретные источники/неопределённость; BRIEF сохраняет units/conditions/negative findings. Число отсутствует в excerpt→unsupported, не invented. Scope change/reauth/restart не смешивают проекты; citations открывают записанную revision. Product outputs отличаются по contract, не только заголовком. Local model-controlled chain tests и late T3 real-generation acceptance отдельно, exact SHA.
