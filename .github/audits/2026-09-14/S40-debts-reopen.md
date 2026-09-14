# S40 — terminal disposition, долги и явное переоткрытие исследования

База a2aca127; ER-08/10/21; inputs #227/#228/#229. Reuse existing coverage/freeze/ledger decisions.

## 1. Суть
ENGINE_COMPLETED не закрывает inquiry. Долги должны иметь next probe, а найденные после freeze материалы не могут незаметно изменить старый отчёт. Это новое исследование ревизии, не repair/recovery старого run.

## 2. Что сделать
Связать persisted ResearchDebt с obligations/claims и terminal decision; обеспечить explicit reopen с новой Investigation/EvidenceFreeze revision и audit только изменившегося material. Proposed POST `/api/v1/research/investigations/:id/reopen`: expected_revision, reason, admitted source revision refs и optional approved protocol ref; existing Idempotency-Key. Ответ связывает прежний artifact, новую investigation revision и новый execution operation ID. Repeated same-key reopen не создаёт третью revision.

## 3. Документация / grep
[Канон §7.9–7.11](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 7.10. Research debts' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 7.11. Terminal dispositions and reopen' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
У каждого unresolved обязательства сохранить kind/owner/blocking effect/next probe/review condition/expiry и evidence refs. Waiver — отдельная explicit authority receipt, не доказательство поддержки. Через existing pure decision functions вычислять ровно9 CompletionDisposition; никакого десятого FAILED/BUDGET code как уверенного результата. Unknown denominator запрещает absence claim, но не автоматически любой узкий supported answer: сверять фактически заявленный scope и required obligations. Reopen проходит fresh authorization и W1 CAS, новой freeze включает только разрешённые source revisions и перепроверяет affected claims/debts/coverage. Старые labels/bytes/receipt refs неизменны. Из UI/MCP возвращать history/next action через existing run/artifact surfaces, без второй системы задач.

## 5. Критерии выполнения
Полный supported narrow case, complete-scope no-match, sampled no-match, failed acquisition, policy denial, budget stop и unresolved contradiction дают ожидаемый канонический outcome/next probe. Post-freeze insertion без reopen отказана. Explicit reopen создаёт одну новую revision/run, а #207 recovery не создаёт её; old artifact читается по исходным hashes. Wrong verifier/waiver, stale CAS, foreign source и duplicate request безопасны. Actual ledger→Workflow→API tests/SHA; model response не назначает сам конечный authoritative статус.
