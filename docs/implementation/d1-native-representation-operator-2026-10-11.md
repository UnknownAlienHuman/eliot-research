# D1 native migration representation, 2026-10-11

This backend operator checkpoint addresses an observed remote D1 parsing failure.
It does not complete S92, qualify a release, or change historical migrations.
The original failed intent `cc9e8049-780b-4701-b840-544bd08f4e28` remains UNKNOWN
and must never be applied again.

## Observed boundary

Installed Wrangler 4.143.1 constructs each migration request from the entire
file plus its own `d1_migrations` INSERT. The remote command normalizes line
endings and posts that script to `/query`; the local path splits statements.
Consequently a local splitter/SQLite pass did not qualify the remote request.
A bounded native read-only probe rejected a bare trigger-body CASE with code
7500 and admitted the parenthesized form with no database change. That probe
was representative; it did not execute the nine pending migrations.

## Versioned operation

`eliotr.cloudflare-d1-migration-intent.v4` retains all v3 account/database,
original config/file/full-bundle pins, schema-probe groups, observed-row scan
bounds, risk review, deadline and receipt/reconciliation fences. It adds exactly:

```json
{
  "migration_transport": {
    "protocol": "eliotr.d1-native-trigger-case.v1",
    "migration_hashes": [
      { "name": "0001_example.sql", "sha256": "<effective file SHA-256>" }
    ],
    "local_migration_bundle_sha256": "<complete effective stream SHA-256>"
  }
}
```

The entries are the exact ordered approved pending suffix. Original
`migration_hashes` and `local_migration_bundle_sha256` still identify immutable
repository SQL. The effective complete stream includes an unchanged prefix.
The shared quote/comment-aware tokenizer provides source spans. The projector
inserts only parentheses around original depth-zero CASE expressions inside
CREATE TRIGGER bodies; it preserves other bytes, including literals, comments,
BOM, Unicode and line endings. Malformed or non-lossless input fails closed.
The unchanged schema/risk classifier processes the effective SQL. Legacy
v1/v2/v3 and raw SQL still reject unparenthesized trigger-body CASE.

Before the effect, the operator exclusively materializes one per-intent mirror
under `.eliotr-state/d1-native-migrations/`. It retains original migration names,
canonical relative directories and byte-identical generated config. It verifies
source/effective file hashes, full membership, full-bundle and config hashes,
path ownership and original-source stability. The mirror remains for forensics.

The operation invokes the ordinary installed, repository-pinned Wrangler CLI
through Node from the mirror Core directory. Its command remains
`d1 migrations apply <database-name> --remote --config wrangler.deploy.jsonc`.
Wrangler owns discovery, script assembly and ledger bookkeeping. The mirror
does not need another package manifest. No raw SQL apply, manual ledger INSERT,
historical SQL rewrite or dependency patch is a production repair.

The native Node command uses `shell: false`, preserving the executable, CLI,
argument and working-directory paths with spaces. Legacy pnpm invocation retains
its existing Windows shell path. A separate actual child-process regression
checks spaced paths/raw arguments, committed output followed by a nonzero exit,
and cancellation before start. The launcher still distinguishes unstarted
failure from started uncertainty; these fixtures do not call Wrangler or D1.

The v4 receipt binds the same transport object to the original intent digest.
A timeout or lost acknowledgement preserves UNKNOWN; a later call reconciles
the ledger/schema and cannot apply the same intent again. A changed source,
config, transport or saved receipt fails its existing approval fences.

## Complete deployment catalogue

Deployment accepts an explicit `--migration-intent-file <repository-file>`.
The full expected catalogue producer reads and pins that strict v4 intent,
verifies the original account/config/source/effective bindings, and materializes
both Core and Search streams in a fresh local mirror. Only the selected approved
suffix is projected. Normal local Wrangler creates the complete catalogue.
The producer rechecks original sources, config, intent and both mirrored streams
before returning the result. Expectations are never taken from the live target.

The expected application manifest remains v1 and retains the original source
bundle identities. Provenance v2 adds strict `migration_representation` containing
the complete intent and its canonical digest, the exact raw intent-file pin,
and both effective stream entries/bundle digests/byte counts. Build-evidence
validation reproduces those effective pins from the captured original files.
The raw SQL catalogue comparison remains exact.

The existing deployment bridge produces the catalogue before its supported
assets-only config normalization. It retains the original materialization config
and pin; the migration intent is compared with that original pin. Its schema
gate accepts provenance v2 through the same deterministic source validator and
still verifies the full catalogue and assets-only config transition.

## Retained local evidence and remaining acceptance

The new preparation executed all 129 original Core migrations and five Search
migrations as whole assembled/normalized Wrangler scripts with its native
bookkeeping, using SQLite 3.51.2. It projected only nine approved pending files
and generated 47 effective schema probes. Historical SQL remained byte-identical.
The explicit local native producer then completed Core/Search migration commands
and full catalogue reads. Its complete expected catalogues contain 1,050 and 26
objects, including the local runtime's `_cf_METADATA` table. The independent
source-only SQLite projection contains 1,049 and 25 application source objects;
the bootstrap difference is explicit and remains in the production catalogue
gate. The native commands were not repeated to repair that verifier expectation.

A subsequent complete remote SELECT-only baseline exposes a remaining catalogue
qualification gap. The remote platform has `_cf_KV`, whereas the local producer
has `_cf_METADATA`. Three existing Core definitions (`mcp_client_diagnostic_challenge`,
`research_model_spend_admission`, `research_workflow_current`) also differ in raw
SQL comments/whitespace outside the pending migration seams. Their retained
ordered nontrivia lexemes match, but that diagnostic is not a substitute for
the exact raw catalogue gate. No source-derived remote serialization/platform
projection has been qualified. Therefore this checkpoint is not ready for a
remote migration effect or release; changing expectations from live observations
or silently excluding platform objects is not accepted.

Eleven focused control-plane groups verify plan-only admission, real isolated
SQLite effect/readback boundaries, exact replay, uncertain effect, committed
lost ACK, source/transport/receipt tampering, full catalogue provenance, config/
intent/source drift and explicit CLI input. Controlled process/API boundaries
are disclosed; these tests are not native Cloudflare effects.

The helper regression retains eleven passing projector/transport/real-filesystem
groups from its first executable run, including actual Windows junction refusal.
The sole failed structural-input example was corrected and passed independently;
the eleven successful groups were not repeated. A prior syntax failure and both
original author reports remain retained. Final helper diagnostics passed. These
are local representation/mirror checks, not remote D1 qualification.

Actual remote acceptance requires a fresh reviewed v4 intent, current identity,
complete pending ledger, exact initial schema and scan readbacks, normal apply,
complete final ledger/effective probes and full application catalogue equality.
The original UNKNOWN intent is excluded. Local evidence and the representative
native CASE probe do not replace those readbacks or S92/release acceptance.

References: [ADR-0009](../adr/0009-control-plane-deployment-and-runtime-cost-authority.md),
[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/),
[D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/),
[workers-sdk discussion 15690](https://github.com/cloudflare/workers-sdk/issues/15690).
