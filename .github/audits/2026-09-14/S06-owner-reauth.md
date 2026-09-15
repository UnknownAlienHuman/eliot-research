# S06 — Read existing Research history after signing in again

Baseline: `a2aca127`; finding F02. Independent of S05: the JWT changes while the deployment stays unchanged.

## 1. Problem

Access derives `credential_generation` from kid/iat. `readResearchRunStatus` supplies the new credential to `loadHeldResearchScope`, while the run retains its original credential. A new session for the same principal must not make that principal's history appear foreign. Issuing a JWT does not itself delete a SQL-view row; do not repeat that inaccurate audit formulation.

## 2. Required change

Allow a new valid owner session to read that owner's existing run status and history. Separate current read authorization from immutable execution provenance. Do not redesign the whole JWT system or rewrite historical receipts. Long-running execution authorization is a separate S33 concern.

## 3. Documentation and exact search anchors

[Architecture, section 7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'The Investigation survives' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'readResearchRunStatus' -- apps/eliotr-core/src/research-session.ts
git grep -n -F 'reauthorizeOwnerHistoricalScope' -- packages/cloudflare-navigation/src
```

## 4. Implementation approach

Use the verified current identity/policy and existing reauthorization mechanism in status/history readers. Keep the original run credential as provenance. Matching an operation ID alone grants no access. Test the same principal with a different iat/kid, a different principal, and an explicitly REVOKED grant. Do not mask the issue by extending TTL, making credential generation constant, or removing SQL fencing.

## 5. Acceptance criteria

- [ ] Two valid owner JWTs for the same principal read the same run and checkpoints.
- [ ] A foreign principal, expired JWT, and active revocation are denied without disclosure.
- [ ] Reauthorization invokes no model, creates no second run, and changes no historical hash.
- [ ] Reading history needs neither manual SQL nor manual UI-based expiry extensions.
- [ ] Add actual status/history HTTP and D1 integration regressions; record exact implementation SHA and results.
