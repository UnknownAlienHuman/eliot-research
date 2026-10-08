# Primary writer qualification operator

`primary-writer-qualification-operator.mjs` installs one reviewed
`eliotr.backup-primary-writer-qualification.v1` authority. It is an operator
tool, not a Worker endpoint. It uses the existing Wrangler browser OAuth
credential in memory, reads the official Cloudflare Worker/version and R2
bucket APIs, then reads the owner-authenticated
`/api/v1/system/backup-primary/inventory` diagnostic. The diagnostic performs
the real `BACKUP_PARTS_BUCKET.list({ prefix: "backup-parts/" })` and D1
inventory reads. A plan field or local `verified` flag is never accepted as
the empty-prefix proof.

The operator has four modes:

```text
node infra/backup/primary-writer-qualification-operator.mjs --plan <reviewed-plan.json> --read
node infra/backup/primary-writer-qualification-operator.mjs --plan <reviewed-plan.json> --apply --confirm-live --deployment-proof <deployment-proof.json>
node infra/backup/primary-writer-qualification-operator.mjs --plan <reviewed-plan.json> --reconcile --operation-ref <operation-ref>
node infra/backup/primary-writer-qualification-operator.mjs --discover --context <reviewed-context.json> --deployment-proof <deployment-proof.json>
```

`--discover` is an acyclic read-only preparation mode. It requires a reviewed
context and the actual successful deployment receipt, then reads the official
100% Worker/version/binding, owner inventory, and D1 counts without requiring a
qualification plan, operation, owner admission, or policy decision. It emits
an ignored discovery receipt for review; it cannot install authority. No owner
admission or policy issuer is currently available, so discovery output must not
be converted into an apply plan until those typed artifacts exist.

`--read` writes a redacted readback under ignored `.eliotr-state/backup-primary-writer/`.
`--apply` repeats the live reads in the same invocation and performs only the
privileged D1 inserts for migration `0118`, followed by exact readback of the
immutable qualification, typed operation, and current pointer. It never creates
an R2 bucket, deploys a Worker, changes bindings, or writes through a product
route. The operation receipt is constructed as a successful receipt only after
the qualification and ACTIVE current pointer pass an exact readback and a
conditional D1 insert gate. A lost acknowledgement is UNKNOWN. Use
`--reconcile` for a read-only operation/qualification/current query; do not
rerun `--apply` for an UNKNOWN operation.

Apply requires a deployment-proof input containing only the successful
deployment receipt path. The operator follows that receipt's persisted
`build_evidence` references, recomputes the manifest and bundle file/body
digests, and reads the pinned generated config and raw entrypoint again before
matching them to the official active deployment identity. A client-supplied
digest or three unbound evidence paths are rejected. Existing non-identical,
DRAINING, or RETIRED current authority is an explicit unsupported rotation and
is rejected; this tool does not claim availability for an unqualified rotation.

The proof wrapper is therefore only:

```json
{
  "protocol": "eliotr.backup-primary-writer-deployment-proof.v1",
  "deployment_receipt_path": ".eliotr-state/cloudflare-deployment-receipt.json"
}
```

The first supported mode is `ISOLATED_NEW_BUCKET` with `NO_ACTIVE_ERASURE`:

- `backup_epoch`, `backup_epoch_receipt`, `backup_export_cut`, erasure rows,
  producer claims, and the reserved `backup-parts/` prefix must all be empty;
- the active Worker must be one 100% version with the reviewed account,
  deployment, version, etag, source/config/compiled pins, controller generation,
  and exact `BACKUP_PARTS_BUCKET` binding;
- the owner inventory readback must match the plan's bucket, binding, prefix,
  object count, and inventory digest;
- the D1 rows persist canonical typed OperationIntent, OperationAttempt, and
  OperationReceipt bytes with refs and digests.

`LEGACY_WRITERS_DRAINED` is reserved for a later operation. This tool rejects
it and does not infer retirement from an absent old binding or a caller digest.
Once a producer runs, the Worker runtime must resolve the current persisted
qualification by SELECT and re-read the exact live erasure fence, request SHA,
producer claims, export cuts, and primary prefix before composing the real O2
port. No synthetic ErasureFence is used for the zero-state bootstrap.
