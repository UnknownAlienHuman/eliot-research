# S31 — подключить и отключить агента без ручного SQL

База a2aca127; ER-21/24/25. Вход — схема/authorizer S10/#202, не завершённая live-приёмка всей темы. Это задание на новый интерфейс, не утверждение о существующих endpoints. Перепроверка исправила ошибочный второй URL namespace `/api/v1/projects`: действующие проекты находятся в `/api/v1/research/projects`.

## 1. Суть
Grant, вставленный вручную в тестовую D1, не доказывает возможность подключить клиента. Владелец должен выдать, проверить и отозвать разрешение через API/PWA, без собственного OAuth-сервера и без второй модели прав.

## 2. Что сделать
Добавить owner-only операции строго под существующим project namespace:

| Метод | Предлагаемый путь | Содержание |
|---|---|---|
| GET | `/api/v1/research/projects/:project_id/client-grants` | Разрешения этого проекта; никаких secret values. |
| PUT | `/api/v1/research/projects/:project_id/client-grants/:grant_id` | Создать/заменить явное разрешение с expected_revision. |
| DELETE | тот же item path | Отозвать разрешение с expected_revision, сохранив tombstone. |

PUT body: grantee identity locator, allowed_operations, ingest_namespace_ids (по умолчанию []), expires_at, optional spend_policy_ref, expected_revision. Для новой записи expected_revision=0. Project/grantor/state берутся сервером, не из body. DELETE body: только expected_revision. Для обеих mutations один Idempotency-Key из заголовка нормализуется в существующую внутреннюю idempotency identity; противоречащий ключ из body не принимается. Ответ item: grant_id/project_id/revision/state, nonsensitive grantee locator, действующие операции/namespace refs и expires_at. Не возвращать owner/model credentials.

Схема полей и словарь операций импортируются из S10. S58/#250 и S98/#290 используют её же: workspace.admit, ingest.bundle и project.attach не отдельные grant tables. Read-only разрешение по умолчанию не включает ни одну из этих мутаций. Connections получает маленькую форму выдачи/отзыва и отдельную проверку scoped чтения без платной модели.

## 3. Документация / grep
[Канон §19.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [текущие маршруты](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/interfaces/src/routes.ts), [project API](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/interfaces/src/project-owner-api.ts).
```sh
git grep -n -F '## 19.5. Projects and disclosure' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '/api/v1/research/projects' -- packages/interfaces/src/routes.ts
```
[Официальные Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/): Client ID/Secret — учётные данные Cloudflare, а не пароль, создаваемый этим приложением.

## 4. Как сделать
Переиспользовать project_owner, project-mutation CAS/receipt и authorizer S10. Проверять право grantor на проект и каждое разрешаемое действие. Для ingest.bundle/workspace.admit — дополнительно текущую namespace admission/write policy каждого ingest_namespace_id; пустой список не означает любой namespace. Для paid operation — существующую spend policy и её разрешённого sponsor. Не усекать неправомерную выдачу до «разрешённой части» молча: отклонить весь запрос без writes. Grantor не может через клиента выдать больше прав, чем имеет сам.

Новый Client ID допустимо настроить до первого подключения, но это лишь заданный владельцем locator. Статус «клиент проверен» появляется только после настоящего подписанного service запроса и проверки issuer/audience/identity. Приложение не обязано иметь management-token Cloudflare, чтобы создать проектное разрешение. Ввод Client ID сам по себе не доказывает наличие или владение service secret.

Повтор PUT с тем же ключом и содержимым возвращает ту же revision/receipt. Изменённое содержимое под тем же ключом — конфликт; stale expected_revision — конфликт без частичной записи. DELETE сохраняет REVOKED; повтор не создаёт новую revision и не воскрешает grant. Последующее повторное разрешение требует явной новой owner mutation и новой revision, но не оживляет старые execution grants автоматически. В UI не записывать Client Secret в localStorage или таблицу; настройку внешнего Access policy не обходить.

## 5. Критерии выполнения
- Чистая D1 → owner API/PWA выдаёт read grant → service читает проект A, не B; никаких preseeded grant rows.
- GET/PUT/DELETE используют один `/api/v1/research/projects` namespace и общую схему S10; неизвестные операции/поля отказаны.
- Право чтения не разрешает run/ingest/attach. Запрошенный namespace или расход вне grantor ceiling отклоняется целиком до effects.
- Configured Client ID не называется проверенным до подписанного round trip. Неверный issuer/audience/actor, CSRF, чужой проект/grant и stale CAS отказаны.
- UI revoke блокирует новые действия и derived grants; duplicate/regrant/late-response cases не восстанавливают прежние полномочия.
- Existing browser и HTTP/D1 tests, exact implementation SHA и реальные результаты. Живая настройка service credentials — отдельная внешняя операция, не результат создания этого PR.
