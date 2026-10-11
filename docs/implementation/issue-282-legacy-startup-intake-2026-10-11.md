# S90 served PWA startup intake

The default emitted-budget CLI accepts explicit startup evidence for the served
`apps/eliotr-pwa` graph:

```text
node scripts/check-emitted-budgets.mjs [--check-only] \
  --artifact-readback <readback.json> \
  --startup-observation <observation.json> [--startup-observation <another.json>]
```

The fresh build, its final receipt validation and retained `--check-only`
validation pass the same admitted observations to the existing PWA inspector.
Without those inputs, startup remains unmeasured. A stored `NOT_MEASURED`
receipt is not upgraded. Existing build commands, release thresholds and
security limits are unchanged.

The owner-web and served PWA intake use one scanner/admission implementation
with explicit artifact graph profiles. Each follows the exact build pointer,
source commit, observed source bytes and lockfile, full client manifest and
observation digests. Foreign graph artifacts, duplicate HTML ownership,
omitted assets, changed bytes and unsafe paths are refused. Owner-web candidate
evidence cannot satisfy the served legacy release gate.

These checks establish byte and source binding; digests do not authenticate the
observer. Source integration and bounded admission tests do not attest an actual
served PWA startup run, the combined S90 release gate or S96 runtime readiness.
