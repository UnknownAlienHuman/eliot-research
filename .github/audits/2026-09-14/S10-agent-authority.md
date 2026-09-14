# S10 — project-scoped делегирование агенту

База `a2aca1277b0edbbed04de66e0d44e383e1b815ef`; ER-03/13/24/30. Контракт ниже — выбранное решение задания, ещё не существующий API. Управление разрешением владельцем выделяется отдельным заданием S31.

## 1. Суть
`0011_owner_orientation.sql` ограничивает scope_read_policy классом owner_pwa; `createOwnerScopeAuthority` также отказывает trusted_agent и проверяет project_owner. Простого повторного использования owner grants недостаточно. В MCP service actor сейчас назван gemini-spark, а HTTP использует verified Client ID: без единой привязки это разные principals.

## 2. Что сделать
Добавить узкое проектное делегирование, не роль владельца. **Выбранное хранилище:** одна новая таблица `project_client_grant` в D1 Core; existing scope_read_policy остаётся верхней границей прав выдающего владельца, existing scope_access_grant — результатом разрешения конкретного frozen scope. Новая таблица нужна именно потому, что существующая owner-only policy не выражает project+service ограничения.

Минимальные поля предлагаемой записи: grant_id, project_id, grantor_principal_ref, verified grantee identity (issuer/authentication method/subject или service Client ID), revision, ACTIVE/REVOKED, allowed_operations, expires_at и optional existing spend_policy_ref. Уникальность logical grant, CAS revision и durable idempotency — по существующему pattern project-owner service. Никаких групп/ролей/иерархий RBAC.

## 3. Документация / grep
[Канон §0 и §19.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'Trusted agents and optional client adapters use the direct semantic API.' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'CREATE TABLE scope_read_policy' -- infra/d1/core/migrations/0011_owner_orientation.sql
git grep -n -F 'createOwnerScopeAuthority' -- packages/cloudflare-navigation/src/orientation-authority.ts
```
[Cloudflare application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/), проверено 2026-09-14: service identity берётся из подписанного common_name, не пустого sub; user identity из проверенного subject. Audience каждого HTTP/MCP endpoint проверяется отдельно.

## 4. Как сделать
1. Из AccessIdentity сохранить реальную проверенную identity в общем authorizer. Не использовать общий gemini-spark как proof индивидуального агента. Legacy candidate observations остаются неизменными; их чтение использует existing explicit Workspace owner binding, не автоматическую массовую alias-миграцию.
2. Effective scope = запрошенное множество ∩ project membership ∩ действующие права grantor ∩ делегированные operations/disclosure. Запрос вне scope отклонять, не молча расширять/усекать. Для UNION/INTERSECT/EXCEPT авторизовать все участвующие atoms; один grant не открывает GLOBAL_LIBRARY.
3. Извлечь общую resolution/byte-read логику из owner-specific factory; owner authorizer сохранить отдельным. Frozen grant записать на реального grantee с ссылкой на delegation revision; grantor — provenance/ceiling, не impersonated request principal. Каждое source/result чтение и платная dispatch повторно проверяют delegation, membership, upstream policy, purge и allowed operation. Revoke блокирует и уже issued derived grants.
4. Начальный operation set: catalog/query/run/status/report/evidence/cancel/recover; не publication/erase/source-owner transfer. Run требует отдельно действующую существующую spend policy, read-only доступ её не подразумевает. Выполнять только модельные расходы, которые ею уже разрешены; новый accounting не нужен.

## 5. Критерии выполнения
- Реальный service JWT через HTTP и тот же проверенный actor через MCP нормализуются согласованно; forged issuer/audience/common_name и legacy label без verified identity отказаны.
- PROJECT A разрешён, PROJECT B/GLOBAL и чужие atoms отказаны; owner path не меняется. Membership change и revoke grantor/grantee действуют на ранее созданные grants.
- Read-only delegation не запускает платную модель; run attribution остаётся service, spend sponsor проверен явно.
- Migration и D1 tests проверяют CAS/idempotency/revoke, полномочия grantor и отсутствие побочных данных при отказе. Завершение этого kernel не выдаётся за подключение пользователя: S31 обеспечивает выдачу/отзыв без ручного SQL.
- Exact SHA/команды/результаты; секретов в записи/Git/browser нет. Runtime product code реализовывать в main; этот PR хранит только задание.
