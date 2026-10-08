# Current restore admission operator

This path installs one reviewed, current permission for one exact `RESTORE_VERIFY` operation into the already migrated primary coordinator Core D1 database. Its target profile describes the isolated restore target and may name a different account, database, and failure domain. It does not create a public owner grant endpoint, start a restore, or qualify a restored controller for traffic.

## Authority boundary

Only the standalone operator installer writes the current profile and permission rows into the primary coordinator D1 database. Plan `account_id` and `database_id` pin that authority store and must equal `permission.primary.account_id` and `permission.primary.resources.core_database`; they do not select the isolated target. Wrangler browser OAuth pins `wrangler whoami` to the coordinator account, and the existing live usage admission runner must return its same-process capability before any D1 mutation. The usage capability is a platform-resource gate; the reviewed plan and privileged D1 installation are the restore authorization. `ADMITTED`, a plan hash, an account id, or a zero-cost claim alone never creates restore permission.

The plan pins the requester actor from trusted authenticated composition (`principal_ref`, credential generation, client class, verified Access method and issuer, and authentication validity), the complete versioned `RESTORE_VERIFY` intent, epoch and authenticated offsite-copy authority digest, primary account/resources/failure domain, the exact target profile and deployment/configuration digest, and the migration/purge frontier. The installer records its OAuth account and confirmed plan digest as operator provenance. These digest fields detect byte changes; they are not signatures.

The installer checks that migration `0115_backup_restore_current_admission.sql` and all five current-authority tables exist in the coordinator database. It stores the immutable target profile, permission, then request binding there, with exact readback after each insert and after the complete sequence. It records local Intent and Attempt state under ignored `.eliotr-state/backup-restore-admission/`. If a write or readback may have settled without a final receipt, that plan becomes `UNKNOWN`; later runs only read back and reconcile it. They never retry the same uncertain write. Profile and permission revocations are append-only in the same coordinator database and use a separate exact revocation plan.

The primary-coordinator verifier is read-only and repeatable, so the same permission can be checked before and after remote manifest reads. The restore store checks the exact binding in that coordinator database when atomically moving `ADMITTED` to `ATTEMPTING`; revocation, expiry, actor expiry, profile change, or loss of the shared erasure lease wins before target writes. Exact replay remains read-only and requires current coordinator authority. The authority tables are `NOT_A_BACKUP` and their physical presence is tied to migration 0115, so restoring an older epoch cannot revive a permission or target profile. Any separate target-side read re-admission remains unwired.

## Local reviewed plan

Create the plan under `.eliotr-state/backup-restore-admission/` from independently reviewed coordinator, target, actor, and copy evidence. Keep account-specific resource identifiers there; the checked-in schema contains no live account defaults. The plan must satisfy [restore-admission-install-plan.schema.json](./restore-admission-install-plan.schema.json). Its `account_id`/`database_id` select the primary coordinator authority store; `target_profile` independently pins the isolated target. `target_profile.configuration_sha256` is the reviewed digest of the exact deployed configuration; the plan author must verify that digest and the deployment/profile identity before approval.

The operator computes and displays a SHA-256 over the canonical plan object. Review all plan fields and copy that digest for the second command argument. For example, after the source is installed and the coordinator database already has migration 0115:

```powershell
node infra/backup/restore-admission-operator.mjs --plan .eliotr-state/backup-restore-admission/<reviewed-plan>.json
node infra/backup/restore-admission-operator.mjs --plan .eliotr-state/backup-restore-admission/<reviewed-plan>.json --confirm-live --confirm-plan <displayed-plan-sha256>
```

The first invocation is local plan validation only; it accepts synthetic IDs and creates no authority. The second invocation is the explicit live installation boundary and can write only the target-profile metadata, permission, and binding represented by that exact plan into the pinned primary coordinator database. This source checkpoint runs no live command, chooses no real Cloudflare account, installs no migration 0115, and issues no live permission.

## Revoking current authority

To revoke one exact profile revision or permission revision, prepare a coordinator-bound plan matching [restore-admission-revocation-plan.schema.json](./restore-admission-revocation-plan.schema.json). The plan account/database identify the primary coordinator D1 containing the authority row; the profile's target account may differ. The operator verifies the authority exists in that pinned coordinator database, appends one immutable revocation row, and requires exact readback. Use a distinct `operation_ref` per reviewed revocation. The first invocation prints the plan digest without contacting Cloudflare; the live invocation requires the same explicit confirmation as installation:

```powershell
node infra/backup/restore-admission-operator.mjs --plan .eliotr-state/backup-restore-admission/<reviewed-revocation>.json
node infra/backup/restore-admission-operator.mjs --plan .eliotr-state/backup-restore-admission/<reviewed-revocation>.json --confirm-live --confirm-plan <displayed-plan-sha256>
```

An uncertain revocation write is reconciled by readback only. It is never blindly repeated. Revocation is an independent guarded operator action; source installation does not execute it.

## Composition limit

The current repository has no production Core/O3 caller that constructs this `RestoreAdmissionContext` from `AuthenticatedRequestContext` and a validated Access identity. The verifier and store are strict source components, and the public O2 restore port remains fail-closed. Any future caller must source the actor from server-authenticated context rather than request-body fields, read current authority from the primary coordinator, establish any separate target-side read re-admission, pass the full current intent revision and exact profile, and preserve the existing `RESTORED_UNQUALIFIED` / `traffic_ready: false` boundary. A restored installation's copied grant metadata is inert; only a fresh operator installation into the primary coordinator database can create current permission.
