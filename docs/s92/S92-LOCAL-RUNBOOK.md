# S92 local acceptance runbook

Baseline: `origin/main @ 8db894c6`. S92 passport: PR #292 → EXECUTION-STEPS-03
(S78–S97). This runbook covers the **setup track only**: INPUT.json,
compile, local runtime, command sequence. Scenario modules (92.1–92.6)
were delivered in `e5c8ec47` and registered in `9c1e4788`. Reconciled against
`main @ 4c897429` on 2026-10-01. Their permitted
`BLOCKED`/`NOT_EXECUTED` outcomes are not full acceptance.

## 0. Prereqs

- Real checkout with `pnpm install` (do NOT run local commands from a
  symlink-node_modules worktree: pnpm refuses the symlinked modules dir,
  `tsc -b` emits with spurious `zod` resolution errors).
- `node scripts/configure-research-runtime.mjs --help` works anywhere
  (no build needed). A real compile needs
  `apps/eliotr-core/dist/research-owner-runtime-config.js`:
  `pnpm exec tsc -b apps/eliotr-core` first.

## 1. INPUT.json → compiled runtime configuration

Draft (D1(a) local-disabled, all placeholders resolved, no secrets):
`docs/s92/s92-INPUT.draft.json` (this directory).

Local-draft decisions (owner replaces every `local-draft-*` value with
installed identities before real S92):

- **D1(a)**: model endpoint local-disabled. `scripts/lib/local-launch.mjs`
  already defaults `AI_GATEWAY_REASONING_URL` to
  `https://example.invalid/local-disabled` for local runs — model calls
  fail closed. S92 proves configuration, readiness, and fail-closed paths
  only; no live model response is claimed.
- **D2**: routes must be in `APPLICATION_MODEL_ROUTES`
  (`packages/platform-cloudflare/src/model-gateway.ts`). Draft uses
  `dynamic/eliotr-strong` (SYNTHESIZE), `dynamic/eliotr-audit-verifier`
  (AUDIT_CLAIMS), `dynamic/eliotr-balanced` (ANALYZE_BRANCHES,
  COUNTER_SEARCH). Route/pricing generations are placeholders —
  `local-draft-route-v1`, `local-draft-pricing-snapshot-v1`, etc.
- **D3**: `request_timeout_ms` 60000 (≤ 300000); `max_input_bytes` /
  `max_output_bytes` ≤ 262144 (SYNTHESIZE 65536/16384, others 32768/8192);
  `model_profile.max_context_bytes` = 65536 = SYNTHESIZE max_input_bytes.
- **D4**: `reasoning_effort: "low"` everywhere (GLM defaults to maximum
  reasoning; short document work needs explicit low).
- **D5**: `output_format: "json_schema"` (default; local-disabled has no
  provider constraint).
- **D6/D7**: verifier `local-draft-verifier-v1` (in `allowed_verifier_refs`,
  also in `model_profile.policy.allowed_verifier_refs`); audit policy with
  one required dimension; normalization section_ref
  `{id: "local-draft-normalization-section", revision: 1}`.
- **D8**: quotes are explicit owner approval — draft sets all USD to 0
  (no spend) with small expected counts; `confidence: 0.5`.
- **D9**: spend uses the template variant
  (`eliotr.research-owner-spend-template.v1`); credential/policy authority
  generations bind from the authenticated owner session at runtime.
  `principal_ref: "local-draft-owner-principal"` matches in spend and
  report admission.
- **D10**: artifact policy `kind: "research_report"`, markdown export,
  one section contract; `statement_labels` keys equal the contract's
  `required_claim_kinds`, all `"UNRESOLVED"`.
- **D11**: `semantic.roles` is **deleted** from the draft.
  `createResearchOwnerSemanticConfiguration` (exact-key validation in
  `apps/eliotr-core/src/research-owner-semantic-config.ts`) rejects unknown
  keys (`... contains unsupported fields`) — re-verified at 8db894c6; the
  INPUT-side roles wiring has not landed even though server-side S37
  role admission did. Server keeps fail-closed behavior
  (`model.roles` not passed).
- **D12**: residency `access_domain_id` = owner principal; the runtime
  rechecks namespace readability at admission — INPUT.json does not prove
  it.

Cross-constraints enforced by the compiler (all hold in the draft):
SYNTHESIZE deployment canonically equals the model profile deployment
(digest-pinned); `report.admission_policy.principal_ref/client_class`
equal the spend policy's; disclosure ceilings equal and both
`allowed_use` include `"research"`; verifier permitted by the profile;
nothing outlives `model_profile.expires_at` (`2027-10-01T00:00:00.000Z`);
every compiled var ≤ 65536 bytes.

Compile (writes `.eliotr-state/research-runtime.json`, mode 0600,
preserves existing workspace/namespace vars; does NOT call a model or
deploy):

```bash
node scripts/configure-research-runtime.mjs /path/to/s92-INPUT.draft.json
# dry-run to a scratch path (worktree stays clean):
node scripts/configure-research-runtime.mjs /path/to/s92-INPUT.draft.json --output /tmp/s92-draft-compiled.json
```

Validation result (2026-10-01, real compiler at 8db894c6,
`docs/s92/s92-INPUT.draft.json` → /tmp): exit 0,
`protocol: eliotr.research-runtime.v1`, 7 vars
(`ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON`,
`ELIOTR_MODEL_PROFILE_DEFINITION_JSON`,
`ELIOTR_MODEL_PROFILE_PROVENANCE_REF`,
`ELIOTR_MODEL_SPEND_POLICY_JSON`,
`ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF`,
`ELIOTR_RESEARCH_REPORT_CONFIG_JSON`,
`ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF`), all ≤ 65536 bytes,
zero `__DECISION_REQUIRED` remaining, synthesis deployment digest ==
profile deployment digest. Negative check: re-adding `semantic.roles`
fails closed at 8db894c6 (`semantic configuration contains unsupported
fields`), so D11 stays in force.

## 2. Local acceptance command sequence (passport Done-clause)

Run in this order. `local:prepare` forwards the compiled
`.eliotr-state/research-runtime.json` into the local Wrangler config —
steps 1–6 are only meaningful for research scenarios **after** the
compile in §1.

| # | Command | Proves | Needs compiled INPUT.json |
|---|---------|--------|---------------------------|
| 1 | `pnpm local:prepare` | PWA builds; D1 migrations apply to local miniflare CORE_DB/SEARCH_DB; local wrangler config written with forwarded server config; local-only `.dev.vars` (Access settings only — provider/deployment settings forbidden) | Yes, for research scenarios (runs without it, but semantic/model config is then absent) |
| 2 | `pnpm local:dev` | Local Worker boots under miniflare; long-running — keep it up for interactive inspection | Yes (uses the prepared config) |
| 3 | `pnpm local:smoke` | Smoke probes against the prepared local runtime pass | Yes |
| 4 | `pnpm test:local-launch` | Launch gate: Worker boots, bindings present, migrations current | Yes |
| 5 | `pnpm test:local-owner` | Owner flows: `local-owner.mjs` owner session, read policy, namespace admission, async execution | Yes |
| 6 | `pnpm test:owner-e2e` (B) | Browser harness: `tests/integration/browser/library.spec.ts` + `raw-file-browser.test.mjs` via `node --test`. **This is where S92 scenarios 92.1–92.6 land** as named scenario functions with real `node:test` assertions — each reached by the real runner, no new browser framework | Yes |
| 7 | `pnpm cf:types` | Wrangler types generate cleanly for `@eliotr/core` | No |
| 8 | `pnpm build` | Full workspace build (`pnpm -r --if-present build`) | No |
| 9 | `pnpm cf:dry-run` | PWA build + `wrangler deploy --dry-run` for `@eliotr/core`: bundle validates without deploying | No |
| 10 | full F = `pnpm test` | Full gate: `test:provisioners` + `test:root` (vitest) + `test:worker`; final local acceptance | Research parts need the compiled config |

Done-clause bar: one build/schema/config, true owner/API-issued grants,
actual app/storage/Queue/DO/Wasm, same allowed IDs/hashes/dispositions,
zero repeated completed effects. `local:documents` does not exist
(passport: "No local:documents"). Controlled external tests do not
establish native/live behavior. Unexecuted checks stay PENDING, never PASS.

## 3. D1(b) variant - verify the existing real-gateway profile before execution

The committed draft selects D1(a). This is a local test-mode choice, not
evidence that the owner has never selected a provider or installed a token.
[research-runtime-configuration.md](../implementation/research-runtime-configuration.md)
records the owner's 2026-09-13 OpenRouter `thinkingmachines/inkling:free`
selection under BYOK alias `default`, the approved Cloudflare
`@cf/zai-org/glm-5.3-flash` fallback with explicit `reasoning_effort: "low"`,
HTTP transport deployment at `cb4d6ae`, and subsequent installation of
`ELIOTR_MODEL_GATEWAY_TOKEN`. Do not ask the owner to repeat those choices
or provide the secret value. Historical installation is not current
secret/profile/qualification readback or authorization for a new paid run.

`owner-inkling-free-v1` names that provider configuration/profile; it is
not an `ApplicationModelRoute`. [ADR-0007 section 2](../adr/0007-external-agents-and-cloudflare-evolution.md)
and `packages/platform-cloudflare/src/model-gateway.ts` distinguish
replaceable provider/model fingerprints from the ten `dynamic/eliotr-*`
application roles. Populate each deployment's `route_ref` with its existing
application role and exact installed `route_version`, prompt/schema/parameter
and pricing generations. Read the installed provider mapping separately.
Do not insert a provider-profile ID into `route_ref`, extend the role
allow-list to admit that ID, or invent new generations to make INPUT compile.

Before actual D1(b) execution:

1. Read back the approved target and existing HTTP transport/secret **metadata**
   through the authorized operator session. Reuse the installed secret; only
   confirmed absence/revocation requires an operator repair. Keep all secret
   values out of INPUT.json, vars, argv, receipts and repository text.
2. Verify current ACTIVE model profile, qualification proof, installed
   application-role mappings, pricing, evidence scope and spend admission.
   The setup compiler validates shape and relationships; it does not install
   or qualify a profile. If immutable semantic revisions are selected, use
   the delivered S29 installer/store (`0097`) and verify the reference/digest;
   do not mix that identity with the legacy JSON vars.
3. Use the existing real HTTP model transport under the approved runtime
   configuration. Local launch currently overrides the reasoning endpoint
   with `local-disabled`; there is no local fake model gateway. Any change
   to that test mode must preserve explicit target/configuration and denial
   behavior. A previously deployed Worker is not automatically the current
   S92 or S94 attested build.
4. Retain applicable data permission, allowed disclosure and maximum spend /
   stop rules before provider/index calls. Missing current input is a precise
   execution prerequisite, not a new provider-selection question. Do not
   replay an unknown paid effect or promote from HTTP success alone.

Until this current-generation execution evidence exists, live-model assertions
remain `NOT_EXECUTED`; D1(a)'s configuration/readiness/denial
results remain valid within their stated local scope. D1(b) by itself does not
satisfy S93 quality, S95 native/security or S96 measured-cost acceptance.
