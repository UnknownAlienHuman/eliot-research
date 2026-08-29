# Release checklist

## Source and contracts

- [ ] Work packet scope respected; no overlapping agent ownership.
- [ ] Protocol/generation changes have fixtures and compatibility notes.
- [ ] Exactly nine `CompletionDisposition` values remain.
- [ ] No forbidden dependency or reverse package import.

## Verification

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm check`
- [ ] `pnpm build:pwa`
- [ ] `pnpm cf:types`
- [ ] `pnpm cf:dry-run`
- [ ] compressed Worker ≤ 4 MiB; PWA initial JS ≤ 600 KiB gzip.
- [ ] affected T0–T5 suites passed; required T4 live fixtures retained.

## Platform

- [ ] Desired resources provisioned without mutating immutable generation settings in place.
- [ ] D1 migrations are additive and applied before incompatible reader/writer activation.
- [ ] AI Search generation complete, read back, and T2 validated before expected-head switch.
- [ ] secrets/config exist in target environment; no secret appears in config or logs.
- [ ] budget quote/reservation and Cloudflare spend limits active.

## Deployment

- [ ] dry-run artifact inspected for imports, bindings, startup and size.
- [ ] deploy generation recorded.
- [ ] migrations applied and verified.
- [ ] health/capability/readback smoke tests pass.
- [ ] SLO/metrics visible and DLQ empty.
- [ ] rollback target retained and tested.

Release is blocked by unresolved citation failures, forbidden Golden Corpus collapse, schema drift,
partial generation exposure, cross-domain dedup/key reuse, or an overdue erasure case without review date.
