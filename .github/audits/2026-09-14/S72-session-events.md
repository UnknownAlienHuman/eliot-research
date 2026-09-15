# S72 — Complete durable progress, WebSocket reconnect, and hibernation

Baseline: `a2aca127`; ER-09/24/25. Existing ResearchSession is a presentation component, not a second executor. Reuse DO cancellation S16/#208 and current run authorization #198/#202.

## 1. Problem

The internal DO returns SESSION_WEBSOCKET_PENDING. Status polling alone does not demonstrate persist-before-notify, hibernation, or cursor-based recovery across client sessions.

## 2. Required change

Complete bounded event transport over D1 checkpoints/change events. Proposed endpoint: GET `/api/v1/research/run/:workflow_id/events` with WebSocket Upgrade and an optional after-cursor. Reuse a compatible existing endpoint if already introduced; do not add a duplicate. Keep ordinary status GET as fallback.

## 3. Documentation and exact search anchors

[Architecture, section 7.7.1](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '### 7.7.1. ResearchSession Durable Object' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Route using verified principal and investigation/run identity. Validate current read authority on connection and delivery; do not put bearer credentials in query strings. Frames contain existing operation/sequence/stage/state and references, not complete source/model bodies. Replay comes from D1 checkpoints/change receipts; outbox notification follows commit.

Bind cursors to principal/run/authorized scope. Expired cursors require explicit resync, not a false empty history. DO state contains connections/cursors/pending approvals, not canonical knowledge. Use the pinned runtime's native hibernation API instead of a custom WebSocket broker. Slow consumers receive bounded resync/closure behavior rather than an unlimited queue. Newly authorized sessions continue through current grants; revocation prevents further disclosure and closes the stream.

## 5. Acceptance criteria

- [ ] Disconnect/eviction/restart/lost notification recovers committed events in order; repeated events are idempotent and never create new runs.
- [ ] No event is advertised before its canonical commit; late notifications cannot override CANCELLED or disclose revoked data.
- [ ] Foreign/stale cursors fail; hibernation preserves recoverability. The architecture's frame ≤64 KiB and live DO-state ≤256 KiB bounds hold.
- [ ] PWA and headless observations converge with status API state.
- [ ] Record local Worker/DO tests, exact SHA, and separate actual hibernation evidence.
