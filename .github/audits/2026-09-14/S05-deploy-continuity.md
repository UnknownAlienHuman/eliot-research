# S05 — Continue Research across compatible deployments

Baseline: `a2aca1277b0edbbed04de66e0d44e383e1b815ef`. Owners: ER-24/26 and ER-13. Scope: deployment authority and Workflow currentness, not JWT redesign. This is an implementation assignment, not a completed fix.

## 1. Problem

`research-deployment-authority.mjs` retires the previous deployment generation, while `research_workflow_current` requires it to remain ACTIVE. Even a PWA-only change can therefore exclude an existing run from execution authority. A constant git ID or removal of all generation checks is not a valid correction.

## 2. Required change

Separate exact build identity for diagnostics/provenance from execution compatibility for continuing an existing run. The selected approach is a reproducible backend fingerprint, not a SHA whitelist or a new version manager. The first checkpoint recognizes identical backend execution inputs as compatible; it does not assume compatibility for unknown changes.

This is deliberately a PWA-only/identical-backend compatibility checkpoint, not a claim that arbitrary backend upgrades are safe. Versioned backend transitions and rollback require their own evidence under S67.

## 3. Documentation and exact search anchors

[Architecture, sections 7 and 7.7.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); [language contract, section 2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).

```sh
git grep -n -F 'The Investigation survives' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'research_workflow_current' -- infra/d1/core/migrations/0020_research_workflow_checkpoints.sql
git grep -n -F 'synchronizeResearchDeploymentAuthority' -- scripts
```

## 4. Implementation approach

1. In the existing deployment builder, fingerprint deterministic backend module bytes before build-ID substitution, compatibility date/flags, binding topology/resource identities, supported handler generations, applied SQL-schema manifest, and non-secret frozen configuration references. Exclude PWA assets, documentation, and build time. Do not hash or publish secret values; credential authority is checked separately.
2. Add the fingerprint to the existing deployment record/manifest as an additive field. Preserve `DEPLOYMENT_GENERATION` and original run/receipt bytes. Link the run's originating deployment to the current ACTIVE deployment through a verified equal fingerprint. Change only the deployment-currentness predicate; retain scope, purge, policy, principal, allowed-use, and cancellation predicates.
3. Dispatch using the recorded handler and execution provenance, not a replacement environment ID. New runs belong to the current build. Update `research-workflow.ts`, `research-session.ts`, the deployment synchronizer, and versioned status decoding consistently; a SQL-view-only patch is insufficient.
4. Backfill legacy `git-*` fingerprints only from retained or read-back exact deployed artifacts and configuration. Without that evidence, retain the run with an explicit incompatibility/migration-needed reason; read-only history remains available through #198/#199. Do not rewrite receipts or revive REVOKED authority.
5. A changed backend fingerprint prevents automatic continuation under this first checkpoint. Prove support for a specific old handler using versioned transition tests before authorizing that upgrade. Do not allow arbitrary schema changes. Rollback between identical execution inputs uses the same comparison. Migrations are additive.

## 5. Acceptance criteria

- [ ] A → PWA-only B → A preserves operation ID, checkpoints, and output hashes; status and subsequent steps work. Identical build inputs produce identical fingerprints on two builds.
- [ ] Handler/schema/resource/config-generation changes alter the fingerprint and do not silently continue unknown semantics; the run is retained.
- [ ] Legacy transition has an evidence-backed positive and an unknown-evidence negative; retired/revoked grants are not revived.
- [ ] Committed provider effects are not repeated; legitimate unexecuted stages may run under their ordinary budgets.
- [ ] Revoke, purge, and cancel work under both builds. Record local D1/R2/Workflow tests and exact SHA; native deployment/rollback qualification is a separate authorized live check.
