# S10 — One project-scoped agent delegation contract

Baseline: `a2aca127`; ER-03/13/24/30. This is the selected contract to implement, not an existing API. S31/#223 implements owner CRUD; S58/#250 and S98/#290 connect their import paths to this same authority. Their later integration is not a prerequisite for developing the authorizer.

## 1. Problem

Migration 0011's `scope_read_policy` and `createOwnerScopeAuthority` admit owner_pwa, while `project_owner` does not represent service-principal delegation. The MCP logical label gemini-spark is not interchangeable with a verified HTTP identity. Earlier assignments also disagreed about operation and namespace fields; independent incompatible grant schemas must not result.

## 2. Required change

Introduce one D1 Core `project_client_grant` table, one strict DTO schema, and one authorizer. Minimum fields: grant_id, project_id, grantor_principal_ref, grantee (verified issuer/authentication method/subject or service Client ID), revision, ACTIVE/REVOKED state, allowed_operations, ingest_namespace_ids, expires_at, and optional existing spend_policy_ref. Use one logical grant per project+grantee and the existing project-mutation patterns for history, revocation, CAS, and idempotency. Store no secrets or arbitrary roles.

Use the same operation vocabulary in S10/S31/S58/S98:

- Research/read: catalog, query, run, status, report, evidence, cancel, recover.
- `ingest.bundle`: normalized-bundle ingestion, implemented by S98.
- `workspace.admit`: Workspace candidate capture/conversion/admission, implemented by S58. Paid conversion requires separate current spend authority.
- `project.attach`: add authorized sources to the delegated project, implemented by S98. It does not permit rename, detach, or ownership changes.

Publication, erasure, source-owner transfer, and administrative roles are excluded. `ingest_namespace_ids` defaults to []; empty never means wildcard. It restricts explicitly granted import operations, not read/query access to an entire namespace. Registering an operation name does not implement its handler: missing handlers report unsupported/not-ready, not success.

## 3. Documentation and exact search anchors

[Architecture, sections 0 and 19.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); [owner scope authority](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/cloudflare-navigation/src/orientation-authority.ts).

```sh
git grep -n -F 'CREATE TABLE scope_read_policy' -- infra/d1/core/migrations/0011_owner_orientation.sql
git grep -n -F 'createOwnerScopeAuthority' -- packages/cloudflare-navigation/src/orientation-authority.ts
git grep -n -F '## 19.5. Projects and disclosure' -- docs/architecture/ELIOT_RESEARCH.md
```

[Access application-token reference](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/): use signed service identity, not an empty user sub; validate issuer, audience, and signature for the endpoint. Preserve the existing verified-identity adapter rather than trusting a caller-supplied claim.

## 4. Implementation approach

Carry the verified AccessIdentity into request context consistently for HTTP/MCP. An owner-entered locator is not proof of possession of its secret. Do not authorize individual agents through the shared gemini-spark label or rewrite legacy Workspace observations. Reading those observations still requires existing WorkspaceOwnerAuthorization and a verified caller binding.

For explicit project scopes, select the unique grant by project+authenticated grantee. For import routes without a project path, use the proposed non-secret `X-Eliotr-Client-Grant` header containing grant_id. It is a lookup key, never a credential. Re-read and authorize the referenced record, retain it in operation context, and reject disagreement between request and grant projects. Headers/tool arguments cannot assign the principal or permissions. Do not automatically union several grants.

The complete requested read/execution scope must satisfy authorized atoms, project membership, current grantor policy, delegated operation/disclosure, and purge state. Reject out-of-scope requests rather than silently truncating them. S31 checks the grantor's namespace-writer/admission ceiling before issuing import rights; recheck it on use. Extract shared resolution/byte-reading from the owner-specific factory rather than impersonating owner_pwa.

Store the actual grantee, originating delegation revision, and frozen scope in existing scope_access_grant. Recheck current delegation; its expansion does not expand a previously frozen scope. Revocation blocks derived uses, and regranting must not automatically revive old execution authority.

Model dispatch separately validates the existing spend policy/sponsor. Read permission implies no spend permission. Use strict versioned DTOs and reject unknown fields/operations. Integrate shared contracts, migration, and authorizer coherently; S58/S98 import this contract instead of copying its algorithm or SQL schema.

## 5. Acceptance criteria

- [ ] The same real service actor is represented consistently across HTTP/MCP; forged common_name/issuer/audience and unverified logical labels fail.
- [ ] Project A is allowed; B/GLOBAL/foreign atoms fail. No silent truncation or automatic grant union; the owner path remains valid.
- [ ] Owner CRUD, Research, bundle ingestion, and Workspace use one DTO vocabulary. Unknown operations and an empty import namespace set fail.
- [ ] Read-only permits no model/write/attach; import permits no namespace-wide reading, rename/detach/erase/cutover. Spend sponsor is checked separately.
- [ ] Delegation/upstream-policy revocation and membership changes affect derived access; substituting a grant locator cannot change identity or authorize another capture/project.
- [ ] Add additive-migration, real D1/auth, CAS/replay, and ceiling-negative tests; record exact SHA. S31 separately proves owner-issued grants without manual SQL, and S58/S98 must prove actual handlers rather than enum membership.
