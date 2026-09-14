# S14 — подтверждённая отмена обычного run

База a2aca127; ER-09/21/24. Предлагаемый API, не уже существующий. EXHAUSTIVE_JOB не менять.

## 1. Суть
Закрытие вкладки и внутренний DO cancel не дают завершённой публичной отмены research.run. Native engine stop не равен канонической отмене.

## 2. Что сделать
Добавить POST `/api/v1/research/run/:workflow_id/cancel` с existing Idempotency-Key, пустым JSON `{}` (неизвестные поля отказаны). Идентичность цели — path+verified principal+action+key. Ответ HTTP200 — существующий ResearchRunStatus после сохранённой CANCELLED; HTTP409 — уже канонически ENGINE_COMPLETED; HTTP503 retryable — settlement не подтверждён. GET существующего status остаётся путём сверки. Repeated cancel уже CANCELLED возвращает200 без новых effects. Новое значение CompletionDisposition не вводится.

## 3. Документация / grep
[Канон §7.7.2, §7.11](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'Each stage checks cancellation and budget' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 7.11. Terminal dispositions and reopen' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
ROUTES/HTTP/research service вызывают existing monotone executor.cancel и W2 receipt readback; не добавлять отдельный cancellation ledger при наличии текущей записи. Доступ: owner собственного run либо явное cancel в #202; чужой/отсутствующий run дают одинаковый404, некорректный body400, отозванные права403 по действующей error policy.

D1 сериализует cancel-versus-complete: победивший terminal outcome неизменяем. После канонического CANCELLED выполнить native stop best effort, сохранив безопасную диагностику; его timeout не отменяет подтверждённый D1 outcome. Если D1 ACK потерян, сначала читать тот же receipt, не возвращать fabricated CANCELLED. Поздний model output можно сохранить в attempt accounting, но не публиковать и не запускать следующую стадию. До каждой dispatch проверить D1 cancellation.

S15/#207 использует соседний POST `/api/v1/research/run/:workflow_id/recover` с тем же пустым body, Idempotency-Key и существующим status response. Recovery отказан после канонического CANCELLED; ни один endpoint не создаёт replacement run. UI/MCP-кнопки — S32, не второй механизм.

## 5. Критерии выполнения
- Before-start, between-stages, in-flight-model cancel→200 с persisted CANCELLED; новые provider effects отсутствуют, уже отправленный вызов не изображается физически отменённым без proof.
- Complete-first→409, cancel-first→неизменный CANCELLED; повтор/restart/lost ACK не дают второй cancel effect и не воскрешают run.
- GET показывает тот же outcome; native stop failure не превращается в ложную потерю канонической отмены.
- Foreign/expired/revoked requests и CSRF отказаны до effects; forged body principal игнорировать нельзя, он должен быть rejected как unknown field.
- Real-local HTTP/D1/R2 race tests, исправляющий SHA, команды и результаты; live native stop проверяется отдельно на разрешённом target.
