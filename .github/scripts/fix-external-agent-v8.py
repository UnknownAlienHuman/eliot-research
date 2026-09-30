from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}")
    file.write_text(text.replace(old, new), encoding="utf-8")


replace_once(
    "infra/d1/core/migrations/0086_external_agent_task_payload.sql",
    "length(CAST(payload_json AS BLOB)) BETWEEN 1 AND 524288",
    "length(CAST(payload_json AS BLOB)) BETWEEN 1 AND 98304",
)
replace_once(
    "packages/cloudflare-workflows/src/external-agent-task-payload.ts",
    "const MAX_PAYLOAD_BYTES = 512 * 1024;",
    "// MCP emits structuredContent plus a JSON text fallback; keep the task payload below the safe combined envelope.\nconst MAX_PAYLOAD_BYTES = 96 * 1024;",
)
replace_once(
    "packages/cloudflare-workflows/src/external-agent-task-payload.ts",
    """  const recorded = await validateRow(row);
  if (recorded.payload_sha256 !== payloadSha || recorded.expires_at !== expiresAt ||
      externalTaskCanonical(recorded.envelope, MAX_PAYLOAD_BYTES, "Recorded external task payload") !== payloadJson) {
    fail("EXTERNAL_AGENT_TASK_CONFLICT", 409, "External task payload conflicts with its recorded identity");
  }
  return recorded;
""",
    """  const recorded = await validateRow(row);
  // A lost publication ACK must reuse the first immutable deadline. Replays may neither extend nor shorten it.
  if (recorded.payload_sha256 !== payloadSha ||
      externalTaskCanonical(recorded.envelope, MAX_PAYLOAD_BYTES, "Recorded external task payload") !== payloadJson) {
    fail("EXTERNAL_AGENT_TASK_CONFLICT", 409, "External task payload conflicts with its recorded identity");
  }
  return recorded;
""",
)
replace_once(
    "packages/cloudflare-research/src/research-external-branch-analysis.ts",
    "const INLINE_EXCERPT_BUDGET_BYTES = 320 * 1024;",
    "// Evidence text is reopened through the current evidence authority; task pull remains safely below the MCP response ceiling.\nconst INLINE_EXCERPT_BUDGET_BYTES = 0;",
)
replace_once(
    "packages/cloudflare-research/src/research-external-branch-analysis.ts",
    '!grant.allowed_operations.includes("run") || !grant.allowed_operations.includes("recover") ||',
    '!grant.allowed_operations.includes("run") || !grant.allowed_operations.includes("recover") ||\n      !grant.allowed_operations.includes("evidence") ||',
)
replace_once(
    "packages/cloudflare-research/src/research-external-branch-analysis.ts",
    'rules: ["admitted_evidence_only", "external_findings_are_candidates", "server_derives_checkpoint"],',
    'rules: ["admitted_evidence_only", "open_handles_with_bounded_ranges",\n      "external_findings_are_candidates", "server_derives_checkpoint"],',
)
replace_once(
    "apps/eliotr-core/src/research-external-agent-routing.ts",
    '!grant.allowed_operations.includes("run") || !grant.allowed_operations.includes("recover") ||',
    '!grant.allowed_operations.includes("run") || !grant.allowed_operations.includes("recover") ||\n      !grant.allowed_operations.includes("evidence") ||',
)
replace_once(
    "apps/eliotr-core/src/research-session.ts",
    """      if (handlerGeneration === SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION &&
          (delegated === undefined || !delegated.lease.grant.allowed_operations.includes("recover"))) {
        fail("RESEARCH_AUTHORITY_STALE",
          "Computer-agent Research requires the same grant revision to authorize run and recover", 403);
      }
""",
    """      if (handlerGeneration === SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION &&
          (delegated === undefined || !delegated.lease.grant.allowed_operations.includes("recover") ||
            !delegated.lease.grant.allowed_operations.includes("evidence"))) {
        fail("RESEARCH_AUTHORITY_STALE",
          "Computer-agent Research requires the same grant revision to authorize run, recover and evidence", 403);
      }
""",
)
replace_once(
    "docs/adr/0007-external-agents-and-cloudflare-evolution.md",
    "the same grant revision must authorize both `run` and `recover`.",
    "the same grant revision must authorize `run`, `recover` and `evidence`.",
)
replace_once(
    "docs/adr/0007-external-agents-and-cloudflare-evolution.md",
    "The payload contains the frozen question graph and admitted evidence. Callback identity and",
    "The bounded payload contains the frozen question graph and admitted evidence handles. Larger exact excerpts are reopened through current evidence authority with bounded ranges. Callback identity and",
)
replace_once(
    "docs/implementation/muse-operator-runbook.md",
    """1. Start `eliotr_run` under the agent's exact project grant. At Stage 8 the workflow publishes an immutable
   `RESEARCH_BRANCH_ANALYSIS` payload bound to the exact W2 attempt, request digest, project and historical
   grant revision. The initial workflow execution intentionally remains STARTED/uncertain while the agent works.
""",
    """1. Start `eliotr_run` under the agent's exact project grant. The same immutable grant revision must authorize
   `run`, `recover` and `evidence`. At Stage 8 the workflow publishes a `RESEARCH_BRANCH_ANALYSIS` payload
   bound to the exact W2 attempt, request digest, project and historical grant revision. The initial workflow
   execution intentionally remains STARTED/uncertain while the agent works.
""",
)
replace_once(
    "docs/implementation/muse-operator-runbook.md",
    """   The response includes `task_kind`, `task_expires_at`, `payload_sha256` and the full payload. It returns
   the slot's same unexpired lease after an uncertain response or reconnect, and `task: null` when none is
   available. Independent slots may claim distinct tasks. A lease is pinned to the credential generation
   that claimed it; rotated credentials cannot inherit it.
""",
    """   The response includes `task_kind`, `task_expires_at`, `payload_sha256` and the bounded handle-first payload.
   Reopen exact evidence with `eliotr_open` in bounded byte ranges; do not expect task pull to duplicate large
   excerpts. Pull returns the slot's same unexpired lease after an uncertain response or reconnect, and
   `task: null` when none is available. Independent slots may claim distinct tasks. A lease is pinned to the
   credential generation that claimed it; rotated credentials cannot inherit it.
""",
)
