# S58 — Workspace export → разрешённый capture → conversion → admission

База a2aca127; ER-36/37/21/24. Вход — общий authorizer/schema S10/#202 и owner issuance S31/#223; не требуется готовность всего Research. Это doc-only задание. Повторная проверка нашла пропущенное звено: `workspace.admission` принимает готовые capture_id/conversion_operation_id, но обслуживающие их raw capture/read/conversion маршруты сейчас owner-only. Одного изменения последнего admission endpoint недостаточно.

## 1. Суть
MCP connection, клиентский receipt и даже разрешённый admission не означают, что service-клиент способен передать и преобразовать файл. Нельзя добиться зелёного end-to-end теста подготовкой capture через привилегированный owner fixture за сценой.

## 2. Что сделать
Завершить один существующий путь для selected gemini-mcp:
`Drive export/read официальным connector → plan/observation v2 → raw capture/read → Markdown conversion → workspace admission/status → SourceRevision/readiness`.

Подключить project_client_grant с workspace.admit и явными ingest_namespace_ids ко всем необходимым звеньям, не только последнему. Нормализованный machine bundle S98 — самостоятельный путь; он не заменяет proof raw Workspace pipeline. Повторно importer/конвертер не писать.

## 3. Документация / grep
[ADR-0006](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/adr/0006-google-external-transport-profiles.md), [Workspace service](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/apps/eliotr-core/src/workspace-candidate-admission.ts), [raw transport](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/cloudflare-raw-ingest/src/raw-capture-http.ts).
```sh
git grep -n -F 'does not receive Google credentials' -- docs/adr/0006-google-external-transport-profiles.md
git grep -n -F 'parseRawFileCaptureRequest' -- packages/cloudflare-raw-ingest/src/raw-capture-http.ts
git grep -n -F 'WorkspaceCandidateAdmissionRawNormalizedPort' -- apps/eliotr-core/src/workspace-candidate-admission.ts
```

## 4. Как сделать
**Transport:** сохранить existing raw routes и upload headers: Content-Length, Content-Type, Idempotency-Key, x-eliotr-original-file-name, x-eliotr-content-sha256, x-eliotr-source-namespace-id, а для source update — пару target-source/expected-head. Для service обязательны явный namespace и выбранный X-Eliotr-Client-Grant из S10. Owner-запрос без delegation остаётся совместимым. Не вводить второй uploader или upload-ticket service.

**Workspace binding:** перед capture service указывает существующую observation через предлагаемый locator `X-Eliotr-Workspace-Observation-Id`. Это не proof: сервер восстанавливает plan/observation по существующему candidate store, проверяет доступ authenticated actor, WorkspaceOwnerAuthorization, транспорт/план, digest/length экспортированных bytes и namespace ceiling. Для legacy observation сохраняется исходная logical identity и отдельная owner authorization; static gemini-spark сам не авторизует нового клиента. Если binding нельзя доказать, capture не разрешается.

**Storage/dispatch:** generalized raw capture, read, conversion и admission получают один типизированный авторизованный context с настоящим service principal, grant/observation binding и разрешённым namespace. Context создаётся только серверным authorizer; его нельзя передать как JSON от клиента или получить заменой client_class на owner_pwa. Связь capture с actor/observation/grant фиксируется в существующих immutable metadata/admission bindings; требуется additive migration, если нынешний формат не хранит достаточную связь. Исторические receipts не переписывать. Каждый последующий read/convert/admit/status восстанавливает эту связь из сохранённых данных и повторно проверяет текущие права, а не доверяет вновь присланному namespace.

**Расходы и приёмка:** workspace.admit само по себе не разрешает оплату модели. Если managed conversion требует spend authority, проверить существующую policy/reservation; отказ не маскировать повторной owner-конверсией. Original bytes immutable, converted bytes проходят действующую qualification, координаты не выдумываются. Caller receipt остаётся untrusted observation; byte readback доказывает принятый Eliot payload, но не автоматически факт Google действия. Само Google I/O выполняет отдельно авторизованный официальный connector; Worker не получает Google OAuth secrets и не создаёт custom OAuth/Cloud project.

**Recovery:** partial upload, loss of response, conversion UNKNOWN и repeated admission используют исходные IDs. Не повторять неизвестный платный conversion/Google action вслепую. Новый source не прикрепляется автоматически к любому проекту: project.attach — отдельное разрешённое действие S98 над тем же project grant. Новую source identity не создавать ради обхода conflict.

## 5. Критерии выполнения
- End-to-end начинается без готового capture/конверсии: owner API выдаёт grant, service сам передаёт bytes, конвертирует, проходит admission и читает status. За сценой нет owner JWT, прямого INSERT или owner-only вызова.
- Один экспорт даёт exact original capture hash и одну admitted revision/outbox; readback, повтор/restart/lost ACK не создают duplicates.
- Reader-only grant, неизвестная/чужая observation, подмена grant/namespace/capture, altered bytes, revoke между upload и commit, expired policy и недостаточный conversion budget отказаны в соответствующем звене.
- Stored grant/observation binding не может быть заменён заголовком при следующем запросе. Grant расширение не изменяет старую capture provenance; текущие запреты действуют.
- Старый owner raw-upload/admission путь проходит regression; локальная application HTTP/D1/R2 проверка отделена от actual Antigravity/Spark export/readback. Unverified external action не называется LIVE_QUALIFIED.
- Exact SHA, команды и наблюдённые identities/outcomes; без Google/provider secrets в Git/PWA/logs и без второго import framework.
