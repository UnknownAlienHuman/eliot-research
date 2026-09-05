# Launch 07 — Drive and selected Google transport

Status: queued draft, unclaimed. Dependency: #89 for canonical import/admission. Owners ER-18/19/20/36,
ER-17 Access and ER-24/26 composition/setup; ER-25 narrow connector-status UI integration.
Read their packets, `packages/google-drive-exchange`, `apps/eliotr-core/src/gemini-mcp.ts`, existing
Google schemas/provisioners and the architecture's external-transport experiment limits.

## Small sequential checkpoints

- [ ] G1. Audit the actual selected transport/profile and choose exactly one active production owner.
  Preserve the other disabled; do not add another SDK/MCP daemon or silently broaden an experiment.
  Verify current official API/CLI behavior before adapting pinned integration code.
- [ ] G2. Complete exact schema provisioning and generation activation with intent, attempt, receipt,
  readback and reconciliation. A successful Google HTTP response is transport observation only.
- [ ] G3. Implement bounded append/export/import using stable IDs/hashes, never row positions. Freeze
  exact candidate bytes in canonical storage and send import through #89 admission; Google cannot grant
  scope membership, overwrite canonical evidence or promote itself into trusted research state.
- [ ] G4. Finish cursor reconciliation, reconnect and historical-row tamper detection. Retry/lost ACK,
  reordered/deleted/edited rows and revision drift must not duplicate canonical import or hide gaps.
- [ ] G5. Implement secure credential lifecycle: encrypted refresh-token storage where applicable,
  revocation/rotation/expiry and explicit REAUTH_REQUIRED without deleting canonical artifacts. Keep
  secrets/content out of logs and client errors. External side effects still require ordinary approval.
- [ ] G6. Wire connector state and allowed owner workflows; test MCP initialize/list/call and exact
  principal/client-ID boundaries, no browser-originated service-token escalation or reverse authority.
- [ ] G7. Add local deterministic and recorded transport regressions, RU/EN/code/table round-trip and
  outage/reconnect/cursor/tamper negatives; prepare disposable real Workspace/Drive/gcloud readback
  scripts for the complete staging trial without executing or claiming them during implementation.

One bounded adapter/cursor/schema checkpoint plus a negative test per commit. Existing ER ownership
and public protocol generations remain authoritative. Dependencies on external credentials must be
reported as unmet setup, not replaced with mock success. No full Google SDK in the Worker.

## Completion

All selected transport code and owner flows work locally with controlled external boundaries; record
that test scope exactly. Require repository/Rust gates, strict Worker tests, local boot and exact-head
CI. Keep draft until G1–G7 code checks pass. Actual account mutations, OAuth reconnect and signed MCP
receipts remain NOT_EXECUTED until the complete authorized staging trial. Update status/gaps and retain
one transport owner. No partial Cloudflare development deployment.
