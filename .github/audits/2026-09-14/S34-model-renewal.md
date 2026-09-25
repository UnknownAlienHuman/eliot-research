# S34 — Complete the existing model-proof renewal path

Baseline: `a2aca127`; ER-16/24/26. Renewal code already exists; do not reimplement it. Source basis: the current gap register and research-runtime-configuration.

## 1. Problem

Retained owner runs succeeded, but automatic qualification renewal was not accepted on the Worker without ELIOTR_MODEL_GATEWAY_READ_TOKEN. Model-proof expiry, pricing/policy expiry, browser JWT lifetime, and deployment changes are distinct causes. A new financial subsystem is outside the owner's current scope.

## 2. Required change

Complete readiness → lazy renewal → exact native-route readback → new proof → first model dispatch. Verify installation of distinct Run and Read credentials through existing runtime/deployment tooling and diagnose missing, forbidden, and revoked credentials clearly.

## 3. Documentation and exact search anchors

[Architecture 8.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); [runtime configuration](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/research-runtime-configuration.md).

```sh
git grep -n -F '## 8.5. Generation change gate' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'ELIOTR_MODEL_GATEWAY_READ_TOKEN' -- docs/implementation/research-runtime-configuration.md apps/eliotr-core/src
```

## 4. Implementation approach

Reuse research-owner-qualification-renewal, research-model-qualification-renewal, and the configured native Dynamic Route. Concurrent initial runs share one renewal keyed by route/configuration identity. Neither status GET nor login requalifies the model automatically. Bind the resulting proof to the actual model/prompt/schema; a different model does not inherit it.

Missing Read credentials produce a precise configuration action, not a hidden fallback or application-managed account-admin token creation. Reconcile UNKNOWN effects through the existing attempt. Model-proof renewal cannot renew pricing or upstream policy. Saved reports/evidence remain readable under valid read authority even when model credentials are missing. Secrets never enter plans, R2, or Git.

## 5. Acceptance criteria

- [ ] A fresh proof causes zero renewal calls; expiry with concurrent runs causes one authorized renewal; same-key replay returns the same proof.
- [ ] Read 401/403/revocation, changed route, UNKNOWN, and expired policy remain distinguishable and cause no blind paid retries.
- [ ] Saved report/evidence reading remains available under valid read permission.
- [ ] Controlled-provider/D1 integration is proven locally; a subsequent authorized native round trip is recorded separately, not claimed in advance.
- [ ] Record exact SHA, calls by operation kind, and secret-free receipts.
