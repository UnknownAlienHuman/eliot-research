# Historical R05 external-task qualification — 2026-10-09

This file recorded local native tests and diagnosis for an `external-wait.v1` generation in the old 18-stage
research executor. It is not a requirement to preserve that handler generation, its migration predicates or the
private receipt programme.

The selected connected-agent/task path keeps the useful invariant:

```text
one immutable task payload
→ one canonical task result
→ settle/wake the same admitted run/attempt
```

Duplicate/lost acknowledgements reconcile through that canonical result; cancellation/revocation prevents new work;
Workflow pause or transport delivery is not permission to allocate another business effect. Current owners are the
selected task/result services, [MCP boundary](gemini-spark-mcp.md), [failure handling](failure-model.md) and
[execution retirement](workflow-checkpoints.md).

When new ordinary/deep execution replaces the old graph, settle real active external waits and remove obsolete
handler generations, stage predicates, migrations/readers and exclusive fixtures. Do not copy Miniflare-internal
pause strings or dated compatibility observations into a new runtime contract.

The original qualification and diagnostic diary remains in
[Git history](https://github.com/UnknownAlienHuman/eliot-research/blob/79a38b379eb7410413a2f9f615a9e681228cafd9/docs/implementation/r05-local-native-qualification-2026-10-09.md).
