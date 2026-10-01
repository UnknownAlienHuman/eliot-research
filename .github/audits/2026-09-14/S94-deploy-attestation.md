# S94 — Attest the exact build and resources for the first complete staging deployment

Baseline `a2aca127`; ER-26/27/00. Writing this assignment does not authorize deployment. The first complete attempt requires implemented selected-profile code and applicable #210/#281/#282/#284 local evidence, not its own future T4/T6 receipts.

## 1. Problem

Git SHA, Cloudflare version ID, schema generation, and visible PWA assets are different identities. Resource inventory or a successful deployment command does not establish the intended application, bindings, or assets.

## 2. Required change

Complete the existing deployment orchestrator's preflight→exact build→additive migrations→private staging deployment→independent version/binding/schema/assets/Wasm readback. Bind the deployment receipt to the tested tree and selected transport configuration.

## 3. Documentation and exact search anchors

[Production plan Phase 7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md); [Execution contract section 6](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).
```sh
git grep -n -F '## 9. Phase 7 — provision a real staging environment' -- docs/implementation/production-readiness-plan.md
```

## 4. Implementation approach

Reuse deploy-cloudflare.mjs, preflight/deployment verification, canonical resources.json, and Wrangler configuration. Do not bypass the orchestrator or create another deployment tool. First test negative readback/ordering cases locally.

Live execution requires an approved target: account/resource identities, hostname/jurisdiction, secret references, budget, and permission for disposable data. A staging label alone does not prove isolation from serving production resources. Verify the actual target. Protect all private-data routes with Access; never include secret values in receipts.

Independently verify every required D1/R2/Queue/DLQ/DO/Workflow/AI binding, static-asset marker, and Wasm digest rather than just listing resources. Missing required implementation blocks the complete deployment; missing results of future staging tests must not create a circular prerequisite.

## 5. Acceptance criteria

- [ ] Wrong target/version/binding, incomplete migration, configuration drift, and fake-positive health responses cannot yield a successful deployment receipt.
- [ ] Actual deployed code/assets/schema/Wasm match the exact tested commit/tree/config; private access is protected and production data is untouched.
- [ ] Local preflight/dry-run/ordering/negative tests pass; only an authorized live run supplies the staging receipt, identities, and cleanup/rollback reference.
- [ ] S93/S95/S96 follow staging. Until required acceptance passes, do not declare production-ready. Missing live credentials or approval remains localized, not a blocker to unrelated local development.
