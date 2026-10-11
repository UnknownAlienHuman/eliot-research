# S90 CLI intake and native generated Worker lifecycle

The existing budget CLI accepts the retained local startup observer's exact
records. It follows `artifact-readback.build.path` and `build.snapshot`; the files
need not share a directory. Source inputs must match the selected Git commit and
lockfile; every declared asset and the complete client directory must match bytes.
Symlinks, changed records, duplicate HTML ownership and omitted unobserved assets
are refused.

```text
node scripts/check-emitted-budgets.mjs --inspect-owner-web-startup \
  --source-tree <exact-observed-commit> --artifact-readback <readback.json> \
  --startup-observation <observation.json> [--startup-observation <another.json>] \
  --receipt <new-output-path>
```

This mode reads existing artifacts and observations without a build, browser or
native invocation. It keeps the Worker and combined release status
`NOT_MEASURED`, with exit 1. A measured root entry never grants an unobserved inbox,
complete module evaluation, live readiness or full S90 acceptance. Digests prove
byte integrity, not observer authentication. Output records contain digest/source
identities and repository-relative artifact names, not developer paths.

The usual `--owner-web` and `--owner-web --check-only` routes accept the same
`--artifact-readback` / repeated `--startup-observation` inputs only when their
source commit and build directory match the actual current build. A stored
`NOT_MEASURED` receipt stays unmeasured; observations do not upgrade it.

The generated Worker uses the existing installed Wrangler no-bundle dry-run.
Complete JS/Wasm module bytes and configuration must remain identical before and
after that child. Only an actual successful supported native process produces its
opaque local capability, bound to the exact report and module/config manifest.
Multipart gzip is neither reconstructed from JSON nor summed per module. A
persisted multipart receipt cannot restore that capability. A single JS module
can be checked against its own aggregate gzip bytes. Native raw totals must
reconcile with all emitted modules; rounding intervals that straddle the 4 MiB
ceiling remain unmeasured. The owner entry's 600 KiB ceiling remains unchanged.

The previous occurrence/network source qualification remains applicable. New
checks cover cross-directory intake, source/pointer/path/manifest refusal and
native capability refusal. The retained actual Research tuple is source
`264d7cf083cb73a72caa4e4e6d46795b4d7bafd5`, not a new build at the publication
commit. No older successful browser/build/native run is replayed by this source
checkpoint. Full native Wasm, combined S90, formatting readiness and release
acceptance remain pending their own affected checks.

After exact source review, one actual new-wrapper qualification on that retained
264d7cf0 pair passed using installed Wrangler 4.143.1: three unchanged JavaScript
modules, 7,972,541 aggregate raw bytes and native gzip display 1,543.02 KiB. The
display retains its rounding precision; it is not an exact integer gzip claim.
Nine actual capability refusals cover unissued/serialized tokens, omitted or
duplicated modules, changed digest, foreign path, altered report and another root.
All original artifact/source bytes and protected checkout state remained unchanged.
Wasm is absent from this pair. This qualifies the new wrapper on the named retained
pair and does not attest the later published product or complete S90/release.
