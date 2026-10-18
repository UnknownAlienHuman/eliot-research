# Policy boundaries

Use [the selected architecture](../../docs/architecture/ELIOT_RESEARCH.md), not the old enterprise policy chain.
Owner authentication belongs at ingress. Connected clients retain actual project/operation permissions;
owner viewing permission never implies permission to send private content to an external model or client.
Enforce real disclosure, source membership and retention choices where those actions occur. Do not rerun
all policy families on every owner summary read or create qualification/proof snapshots for local calls.
Keep pure decisions small and typed, remove unselected branches with callers, and recheck mutable state
only at the affected disclosure/write boundary. Root instructions govern implementation and check timing.
