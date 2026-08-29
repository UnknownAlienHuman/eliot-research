# Implementation status is executable

The architecture describes the final system; the repository also contains intentional fail-closed
scaffolds. [`implementation-status.json`](implementation-status.json) is the machine-readable inventory
of those contours. A file is not implemented merely because it compiles or exports the final type.

States:

- `SCAFFOLD_FAIL_CLOSED` — contract or port exists, but execution throws or returns an explicit
  pending response and cannot mutate canonical state.
- `IN_PROGRESS` — an owned work packet is active; merge still requires its negative acceptance case.
- `IMPLEMENTED_NOT_LIVE` — deterministic and recorded-fixture gates pass, but a required Cloudflare,
  Google, provider, recovery, or workload round trip has not produced a live receipt.
- `LIVE_QUALIFIED` — the implementation and its named live gate have a retained receipt.

`pnpm check:implementation-status` fails when a sentinel is unregistered or a registry entry no longer
matches the file. Removing a sentinel is therefore an explicit implementation event, not cosmetic
cleanup. The committer must update the entry and attach the completion evidence in the same change.
