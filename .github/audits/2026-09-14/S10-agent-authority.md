# S10 — единое проектное делегирование агенту

База a2aca127; ER-03/13/24/30. Это выбранный контракт к реализации, не существующий API. S31/#223 реализует owner CRUD; S58/#250 и S98/#290 подключают отдельные import paths к той же authority. Их кодовая интеграция не является предусловием разработки этого authorizer.

## 1. Суть
`scope_read_policy` в 0011 и `createOwnerScopeAuthority` разрешают owner_pwa, а `project_owner` не выражает делегирование service principal. MCP logical label gemini-spark и реальная HTTP identity не взаимозаменяемы. Кроме того, исходные задания расходились по operations/namespace полям: нельзя позволить разным агентам создать несовместимые схемы grants.

## 2. Что сделать
Одна новая D1 Core таблица `project_client_grant`, одна strict DTO schema и один authorizer. Минимальные поля: grant_id, project_id, grantor_principal_ref, grantee (verified issuer/auth method/subject либо service Client ID), revision, ACTIVE/REVOKED, allowed_operations, ingest_namespace_ids, expires_at и optional existing spend_policy_ref. Уникальность одного logical grant на project+grantee; история/revoke/idempotency по существующему project mutation pattern. Секреты и произвольные роли не хранятся.

Словарь операций единый для S10/S31/S58/S98:
- Read/Research: catalog, query, run, status, report, evidence, cancel, recover.
- Импорт нормализованного bundle: ingest.bundle, реализуется S98.
- Workspace candidate capture/conversion/admission: workspace.admit, реализуется S58; paid conversion требует отдельной действующей spend authority.
- Только добавление разрешённого source к своему проекту: project.attach, реализуется S98. Это не rename/detach/изменение владельца.

Publication, erase, source-owner transfer и административные роли сюда не входят. ingest_namespace_ids по умолчанию []; пустой набор не означает wildcard. Поле не даёт read/query права на весь namespace: оно ограничивает только явно выданный import operation. Зарегистрированное имя операции само не означает реализованный handler; отсутствующий handler отвечает честным unsupported/not-ready, не success.

## 3. Документация / grep
[Канон §0/§19.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [owner scope authority](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/cloudflare-navigation/src/orientation-authority.ts).
```sh
git grep -n -F 'CREATE TABLE scope_read_policy' -- infra/d1/core/migrations/0011_owner_orientation.sql
git grep -n -F 'createOwnerScopeAuthority' -- packages/cloudflare-navigation/src/orientation-authority.ts
git grep -n -F '## 19.5. Projects and disclosure' -- docs/architecture/ELIOT_RESEARCH.md
```
[Access application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/): service identity из подписанного common_name, не пустого sub; issuer/audience/signature проверяются для конкретного endpoint.

## 4. Как сделать
Из AccessIdentity сохранить проверенную identity в request context одинаково для HTTP/MCP. Locator, введённый владельцем, не proof владения secret. Не использовать общий gemini-spark как авторизацию индивидуального агента и не переписывать legacy Workspace observations. Чтение последних требует существующего WorkspaceOwnerAuthorization и проверенной привязки к вызывающему actor.

Для маршрутов с явным project scope выбрать единственный grant по project+authenticated grantee. Для import путей без project path предлагается один transport locator `X-Eliotr-Client-Grant` (grant_id); он не credential, а указатель на запись, которую authorizer перечитывает и проверяет. Сохранять выбранный grant в operation context; ни header, ни tool argument не назначают principal или allowed_operations. Если project указан и в запросе, и в grant, несовпадение — отказ. Не объединять права нескольких grants автоматически.

Read/execution scope целиком должен укладываться в запрошенные atoms, project membership, current grantor policy, delegation operation/disclosure и purge. Out-of-scope запрос отклоняется, не молча усекается. При выдаче import права S31 дополнительно проверяет namespace writer/admission ceiling grantor; при применении проверить его повторно. Извлечь общую resolution/byte-read логику из owner-specific factory, а не подставить owner_pwa. Existing scope_access_grant хранит реального grantee, исходную delegation revision и frozen scope; current delegation проверяется заново, её расширение не расширяет уже frozen scope. Revoked grant блокирует derived uses; regrant не оживляет старую execution authority автоматически.

Модельный dispatch требует отдельно действующей spend policy/sponsor, не выводит её из права чтения. Public DTO strict/versioned, неизвестные операции/поля отклоняются. Общие contracts/migration/authorizer внедряются одним согласованным checkpoint, consumers используют imports из него; S58/S98 не копируют алгоритм или SQL-схему.

## 5. Критерии выполнения
- Реальный service actor согласован HTTP/MCP; forged common_name/issuer/audience и неподтверждённый logical label отказаны.
- Project A разрешён, B/GLOBAL/foreign atoms отказаны; нет silent scope truncation или union нескольких grants. Owner path сохранён.
- Operations/namespace набор одной DTO одинаков в owner CRUD, Research, normalized ingest и Workspace integration. Unknown operation и пустой namespace для import отказаны.
- Read-only не даёт model/write/attach; import не даёт namespace-wide read, rename/detach/erase/cutover. Spend sponsor проверен отдельно.
- Delegation/upstream policy revoke и membership change действуют на derived access; подмена transport grant locator не меняет identity и не даёт доступ к чужому capture/project.
- Additive migration, real D1/auth tests, CAS/replay/ceiling negatives и exact SHA. S31 отдельно доказывает owner-issued grant без ручного SQL; реализация source handlers S58/S98 не засчитывается по наличию имени в enum.
