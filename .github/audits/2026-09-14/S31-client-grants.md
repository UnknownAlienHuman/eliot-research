# S31 — подключить и отключить агента без ручного SQL

База a2aca127; ER-21/24/25, prerequisite #202 (project_client_grant). Это proposed contract, не существующие endpoints.

## 1. Суть
Авторизация, проверенная на заранее вставленном fixture, не даёт владельцу подключить настоящего клиента. Нужен маленький законченный grant-management loop, не собственный OAuth server.

## 2. Что сделать
В existing project API добавить GET `/api/v1/projects/:project_id/client-grants`, PUT `/api/v1/projects/:project_id/client-grants/:grant_id`, DELETE того же ресурса. PUT: verified grantee locator, allowed_operations, expires_at, optional existing spend_policy_ref, expected_revision; для нового grant expected_revision=0. DELETE: expected_revision. Все mutations используют existing Idempotency-Key. Ответ: grant_id/project_id/revision/state/effective_operations/expires_at без secrets. В Connections добавить выбор проекта, Client ID/проверенного actor, операции и revoke.

## 3. Документация / grep
[Канон §19.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [S10](https://github.com/UnknownAlienHuman/eliot-research/pull/202).
```sh
git grep -n -F '## 19.5. Projects and disclosure' -- docs/architecture/ELIOT_RESEARCH.md
```
[Официальные Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), проверено 2026-09-14: клиентские credentials — Cloudflare Client ID/Secret; приложение не должно создавать собственный пароль.

## 4. Как сделать
Переиспользовать project_owner проверку, D1 CAS и authorizer #202. Grantor берётся из HTTP owner identity, project из path; чужой owner не может делегировать. Не добавлять grantee в project_owner. Секрет Access хранится только в защищённой конфигурации клиента, не в UI/таблице/Git. В UI вводится несекретный Client ID или actor_ref из действующей диагностики. Повтор PUT с прежними bytes возвращает ту же revision; changed-body same-key конфликтует. DELETE сохраняет REVOKED tombstone, повтор не воскрешает grant. Документировать пример headless запроса с environment placeholders и режим проверки catalog без платного run. Service Auth policy Access настраивается штатно для каждого выбранного endpoint; приложение не обходит её.

## 5. Критерии выполнения
- Чистая база: owner создаёт проектное разрешение через API/PWA; реальный локально подписанный service JWT читает A, не B, без ручных D1 insert.
- Revoke через UI немедленно блокирует прежние запросы/derived grants; повтор и stale revision безопасны.
- Read-only grant не разрешает run; выдача paid permission проверяет существующую spend policy, не создаёт новую систему цен.
- Неверный issuer/audience/owner, CSRF и чужой grant_id отказаны. Secrets отсутствуют в responses/logs/storage PWA.
- Existing browser + HTTP/D1 tests, exact implementation SHA, commands/results. Создание реального Cloudflare token не выполняется этим planning PR и требует штатной авторизации аккаунта.
