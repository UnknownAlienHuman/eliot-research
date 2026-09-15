# S98 — machine bundle ingest и явное добавление source в проект

База a2aca127; ER-24/29/14. Входы: S10/#202 common grant, S31/#223 owner issuance и действующий normalized-bundle importer. Это задание, не реализованный маршрут. S58/#250 отдельно обслуживает Workspace raw export/conversion; обычный machine ingest не требует Google.

## 1. Суть
Read/query/run API недостаточен без добавления источника. В прежнем паспорте project.attach оставался решением «если понадобится», хотя для полного source→project→research цикла нужно определить его поведение заранее. Import permission не должен превращаться в общее право редактировать проект или source ownership.

## 2. Что сделать
Замкнуть existing bundle discover/prepare/parts/file-complete/commit/status/recovery для service с ingest.bundle и явными ingest_namespace_ids. Затем отдельным авторизованным действием project.attach прикрепить admitted source к проекту. Обе операции используют project_client_grant и DTO S10, не создают собственные таблицы разрешений.

Выбранный attach interface: существующий `PUT /api/v1/research/projects/:project_id` и существующий UpdateProjectRequest — title, source_ids, expected_revision, idempotency_key. Для service с project.attach разрешено только монотонное добавление source IDs: title неизменен, ни один текущий source не удаляется, owner/project metadata не меняются. Другие project mutations остаются owner-only. Новый `/projects` namespace или ещё один membership API не нужен.

## 3. Документация / grep
[Маршруты](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/interfaces/src/routes.ts), [точный UpdateProjectRequest](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/interfaces/src/project-owner-api.ts), [project service](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/apps/eliotr-core/src/project-owner-service.ts), [ER-29](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-29-source-acquisition-admission-and-qualification.md).
```sh
git grep -n -F '/api/v1/ingest/bundles/prepare' -- packages/interfaces/src/routes.ts
git grep -n -F 'export interface UpdateProjectRequest' -- packages/interfaces/src/project-owner-api.ts
```

## 4. Как сделать
**Ingest:** использовать выбранный transport grant locator X-Eliotr-Client-Grant из S10; это не credential. Сравнить verified caller, grant project, namespace из bundle, current grantor writer/admission policy и owner generation до upload и перед commit. Пустой namespace set не wildcard. Capture/bundle операции сохраняют выбранный grant/actor/namespace; последующий status/recovery не может заменить их новым header. Делегат не становится mutable owner. Проверить существующие schema/storage ограничения principal/client_class: если они owner-only, обобщить caller boundary и применить необходимую additive migration; запрещено подставлять owner context для обхода.

**Attach:** обычный PUT декодируется тем же DTO. Для service получить текущий project head/memberships и сравнить expected_revision; разрешить только unchanged title и superset текущего source set. Каждый добавляемый source должен быть уже admitted, доступен grantor и находиться в разрешённом ingest namespace с допустимой residency/disclosure. Проверка project.attach не требует, чтобы новый source уже состоял в проекте — это сделало бы добавление невозможным; она проверяет отдельный namespace/source ceiling. При этом read/query по namespace не выдаётся: после успешного CAS новый source становится членом проекта, а новый query фиксирует новый scope. Исторические runs сохраняют прежний member set.

Переиспользовать project service и его guarded CAS/membership/outbox transaction. Не копировать SQL update в новый сервис. Проверять монотонность и source permissions при фактическом settlement, не только до внешнего await. Запрос на rename/detach/foreign source отклоняется целиком; не удалять запрещённые поля из body молча. На concurrent project edit вернуть штатный conflict, не перезаписать head. Повтор с исходным idempotency key возвращает прежний receipt и не создаёт новую temporal membership.

Normalized bundle проходит existing quality/admission/residency и точный byte readback. Offline preprocessing не является admission proof. Partial uploads не входят в retrieval/model context. Unknown conversion или внешнее действие не повторять под новой identity. Paid preprocessing и source-owner cutover не разрешены автоматически ни ingest.bundle, ни project.attach.

## 5. Критерии выполнения
- Clean database: owner API выдаёт явные ingest.bundle/project.attach/catalog/query/run права; independent service импортирует источник, выполняет разрешённый PUT attach, затем query/run/citation без browser cookies/Google/manual SQL.
- Ровно одна admitted revision/outbox и ожидаемая membership revision; repeated upload/attach/lost ACK/restart не дублируют source или temporal membership.
- Reader-only grant, wrong namespace, revoked owner/delegation, changed source owner, wrong bytes/maps, stale source/project head и недопустимая residency отказаны до canonical commit.
- Service rename/detach/изменение metadata, добавление чужого либо неadmitted source отвергаются целиком. Source, ещё не состоящий в проекте, успешно добавляется при наличии именно attach permission и namespace ceiling.
- Query до attach не видит новый source; после attach получает новый scoped результат; старый run/history не расширяется задним числом.
- Actual HTTP/D1/R2 tests, owner-regression, пример существующего wire DTO, exact SHA и результаты. Наличие enum operation не считается реализацией этого пути.
