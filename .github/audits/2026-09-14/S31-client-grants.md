# S31 — Connect and revoke an agent without manual SQL

Baseline: `a2aca127`; ER-21/24/25. Requires S10/#202's schema/authorizer, not the whole subsystem's future live qualification. These are proposed endpoints. The earlier incorrect /api/v1/projects namespace was corrected: existing projects use /api/v1/research/projects.

## 1. Problem

A grant inserted directly into a test database does not prove that the owner can connect a client. The owner must issue, verify, and revoke access through API/PWA without a custom OAuth server or a second permissions model.

## 2. Required change

Add owner-only operations under the existing project namespace:

| Method | Proposed path | Behavior |
|---|---|---|
| GET | `/api/v1/research/projects/:project_id/client-grants` | List this project's grants without secrets. |
| PUT | `/api/v1/research/projects/:project_id/client-grants/:grant_id` | Create/replace an explicit grant using expected_revision. |
| DELETE | The same item path | Revoke using expected_revision and retain a tombstone. |

PUT body: grantee identity locator, allowed_operations, ingest_namespace_ids (default []), expires_at, optional spend_policy_ref, and expected_revision. Creation uses expected_revision=0. The server selects project/grantor/state; they are not body-controlled. DELETE body contains only expected_revision. Both mutations normalize the Idempotency-Key header into the existing internal identity; conflicting body keys fail. Item responses contain grant_id/project_id/revision/state, non-secret grantee locator, effective operations/namespace references, and expiry, never owner/model credentials.

Import field definitions and operation vocabulary from S10. S58/#250 and S98/#290 use the same schema; workspace.admit, ingest.bundle, and project.attach do not introduce separate grant tables. Read-only defaults include none of these mutations. Add a small Connections grant/revoke form and an independent scoped-read connection check that invokes no paid model.

## 3. Documentation and exact search anchors

[Architecture 19.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [routes](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/interfaces/src/routes.ts), and [project API](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/interfaces/src/project-owner-api.ts).

```sh
git grep -n -F '## 19.5. Projects and disclosure' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '/api/v1/research/projects' -- packages/interfaces/src/routes.ts
```

[Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/): Client ID/Secret are Cloudflare credentials, not passwords created by this application.

## 4. Implementation approach

Reuse project_owner, project-mutation CAS/receipts, and S10's authorizer. Check the grantor's project rights and every requested operation. Import permissions additionally require current namespace-admission/write authority for each named namespace; empty never means wildcard. Paid operations require a permitted existing spend sponsor/policy. Reject an overprivileged request as a whole without writes rather than silently truncating it to permissible rights.

An owner may configure a Client ID before its first connection, but this only stores a locator. A verified-client status requires an actual signed request with validated issuer/audience/identity. Creating an application project grant does not require a Cloudflare management token; entered Client ID alone does not prove a service secret exists or is possessed.

Identical key/body replays return the same revision/receipt. Changed-body reuse and stale expected_revision conflict without partial writes. DELETE retains REVOKED; replay neither adds a revision nor revives access. Regrant requires a new explicit owner mutation/revision and must not revive old execution grants automatically. Never put a Client Secret in the UI's persistent storage or grant table; do not bypass external Access policy.

## 5. Acceptance criteria

- [ ] Clean D1 → owner API/PWA issues read access → service reads A, not B, without preseeded grant rows.
- [ ] All routes use the same project namespace and S10 schema; unknown fields/operations fail.
- [ ] Read-only grants cannot run models/import/attach. Excess namespace/spend requests fail entirely before effects.
- [ ] Configured is not verified until a signed round trip. Invalid issuer/audience/actor, CSRF, foreign project/grant, and stale CAS fail.
- [ ] UI revocation blocks new and derived uses; duplicate/regrant/late-response cases cannot restore old rights.
- [ ] Record real browser/HTTP/D1 results and exact SHA. Live service-credential provisioning is a separate authorized external action.
