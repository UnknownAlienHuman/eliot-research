# Historical Drive Exchange REST checkpoint

Drive Exchange is not selected by the current product architecture. Current work keeps the selected `gemini-mcp`
and explicit task/result paths; it does not require finishing the old Google Sheet/Drive Exchange transport.
See the [implementation plan](backend-entrypoints.md), [release/schema transitions](production-readiness-plan.md)
and [security checklist](security-checklist.md).

The existing bounded REST/serializer code may remain temporarily while real callers, deployed configuration and
retained data are inventoried. It is not authority to activate `DRIVE_EXCHANGE`, add OAuth UI/provisioning, restore
G1–G8/ER checkpoints or preserve the whole connector indefinitely. A future explicit product decision may reuse a
small operation after rechecking current Google APIs and threat boundaries; it must not revive the old platform by
default.

The original checkpoint remains in
[Git history](https://github.com/UnknownAlienHuman/eliot-research/blob/5dec2fae1a86b2a7cf7bb00703b6976665aab847/docs/implementation/drive-rest.md).
