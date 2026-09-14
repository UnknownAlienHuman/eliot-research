# S35 — вопрос становится сохраняемым протоколом и обязательствами

База a2aca127; ER-08/09/10/21. Reuse `research-session.ts`, research protocol-freeze, existing Investigation ledger/contracts. Не заменять готовую W1 authority.

## 1. Суть
Название PLAN/COMPILE_OBLIGATIONS и технические checkpoint bytes не задают реальную процедуру. Сначала нужен versioned protocol, однозначно связанный с вопросом, требуемым rigor и выходным продуктом.

## 2. Что сделать
В run-specific versioned request добавить ссылку на установленный InquiryProtocolProfile (`inquiry_protocol_ref` — proposed additive field, не произвольный JSON из клиента). Старый запрос сохраняет прежний E0 exploratory default. В existing W1 persist: query/intended artifact, selected profile revision, grade, lane, source_mode, coverage goal, budget/stop rule и InquiryObligations с dependencies/verifier/certificate kind. Model suggestions остаются candidates; определяющие policy/verifier поля берутся из установленного профиля.

## 3. Документация / grep
[Канон §7.2–7.4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 7.2. InquiryProtocolProfile' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 7.4. Inquiry obligations and acceptance certificates' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Decode strict v1/v2 в существующем run API; request identity включает profile ref/revision, нельзя replay с другим profile под тем же key. При первичном freeze получить authority, затем через existing W1 commands/CAS сохранить план, без новых task graph services. Интерпретация и compile могут быть объединены как дешёвая deterministic стадия, но её результат должен реально содержать obligations. Missing approved protocol/verifier — typed blocked obligation/next probe, не success. Scope/grade нельзя поменять во время исследования незаметно. Справочник выбранных профилей — существующая config/contracts, не второй registry. Профиль source_mode corpus_only не выполняет сеть. Новый expensive planning call, если нужен, проходит существующий W3 один раз; простой lookup не обязан вызывать planning LLM.

## 5. Критерии выполнения
Вопросы lookup/evidence-review/architecture-decision дают разные проверяемые obligations и один immutable profile binding. Повтор/restart сохраняют план; изменённый profile/query конфликтует. Чужой verifier, unknown fields, недопустимый grade/source route не принимаются; checkpoint сам не выдаёт ACCEPTED certificate. W1/D1+HTTP tests, exact SHA, прежний owner loop без регрессии. Остальные products используют этот контракт, не создают свой параллельный planner.
