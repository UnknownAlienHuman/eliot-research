from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new), encoding="utf-8")


replace_once(
    "infra/d1/core/migrations/0086_external_agent_task_payload.sql",
    """    AND julianday(p.created_at)<=julianday(t.created_at)
    AND julianday(t.created_at)<=julianday(p.created_at,'+5 minutes')
    AND julianday(p.expires_at)<=julianday(g.expires_at)
""",
    """    AND julianday(p.created_at)<=julianday(t.created_at)
    AND julianday(t.created_at)<=julianday(p.expires_at)
    AND julianday(p.expires_at)<=julianday(g.expires_at)
""",
)

replace_once(
    "packages/cloudflare-research/src/research-external-branch-analysis.ts",
    """const RoleOutputSchema = z.object({
  role: ResearchBranchRoleSchema,
  status: z.enum(["CANDIDATE_READY", "BLOCKED"]),
  evidence_handle_refs: z.array(VersionedRefSchema).max(512),
  unknowns: z.array(z.string().min(1).max(1024)).max(64),
  limitations: z.array(z.string().min(1).max(1024)).max(64),
  failed_probe_refs: z.array(z.string().min(1).max(256)).max(64),
}).strict();
""",
    """const RoleOutputSchema = z.object({
  role: ResearchBranchRoleSchema,
  status: z.enum(["CANDIDATE_READY", "BLOCKED"]),
  evidence_handle_refs: z.array(VersionedRefSchema).max(512),
}).strict();
""",
)

replace_once(
    "packages/cloudflare-research/src/research-external-branch-analysis.ts",
    """      role_record_fields: Object.freeze([
        "role", "status", "evidence_handle_refs", "unknowns", "limitations", "failed_probe_refs",
      ]),
""",
    """      role_record_fields: Object.freeze(["role", "status", "evidence_handle_refs"]),
""",
)

replace_once(
    "packages/cloudflare-research/src/research-external-branch-analysis.ts",
    """        "CANDIDATE_READY roles must select admitted evidence_handle_refs supplied by this task. Never invent a handle.",
        "New browser, app, local-computer or UI observations belong only in candidate_findings with admission_state=NOT_ADMITTED.",
""",
    """        "CANDIDATE_READY roles must select admitted evidence_handle_refs supplied by this task. Never invent a handle.",
        "Do not return prose in role records. Canonical unknowns, limitations and failed-probe refs are derived server-side.",
        "New browser, app, local-computer or UI observations belong only in candidate_findings with admission_state=NOT_ADMITTED.",
""",
)

replace_once(
    "packages/cloudflare-research/src/research-external-branch-analysis.ts",
    """    for (const role of output.roles) {
      if (role.role === "COUNTER" ||
          (role.status === "CANDIDATE_READY" && role.evidence_handle_refs.length === 0 && role.role !== "SOURCE_AUDIT") ||
          (role.status === "BLOCKED" && role.failed_probe_refs.length === 0)) corrupt();
      const keys = refSet(role.evidence_handle_refs);
      if (new Set(keys).size !== keys.length || new Set(role.failed_probe_refs).size !== role.failed_probe_refs.length) corrupt();
    }
""",
    """    for (const role of output.roles) {
      if (role.role === "COUNTER" ||
          (role.status === "CANDIDATE_READY" && role.evidence_handle_refs.length === 0 && role.role !== "SOURCE_AUDIT")) corrupt();
      const keys = refSet(role.evidence_handle_refs);
      if (new Set(keys).size !== keys.length) corrupt();
    }
""",
)

replace_once(
    "packages/cloudflare-research/src/research-external-branch-analysis.ts",
    """    for (const role of output.roles.sort((left, right) => left.role.localeCompare(right.role))) {
      const limitations = uniqueSorted([
        ...role.limitations,
        ...candidateLimitation,
        `External client reported contour ${output.execution_observation.contour}; this metadata is non-authoritative and verification/claim audit remain authoritative.`,
      ]);
      results.push(await branchResult({
        role: role.role,
        status: role.status,
        question_ids: questionsForRole(context.planning, role.role),
        hypothesis_ids: hypothesesForRole(context.planning, role.role),
        evidence_handle_refs: role.evidence_handle_refs,
        observation_refs: await observationRefs(role.role, role.evidence_handle_refs, resultDigest),
        unknowns: uniqueSorted(role.unknowns),
        limitations,
        failed_probe_refs: uniqueSorted(role.failed_probe_refs),
        authoritative_disposition: "UNASSESSED",
      }));
    }
""",
    """    for (const role of output.roles.sort((left, right) => left.role.localeCompare(right.role))) {
      const blocked = role.status === "BLOCKED";
      const limitations = uniqueSorted([
        ...candidateLimitation,
        "Arbitrary computer-agent prose remains quarantined in delivery metadata; the canonical branch contains only server-derived status text and admitted handle selections.",
        `External client reported contour ${output.execution_observation.contour}; this metadata is non-authoritative and verification/claim audit remain authoritative.`,
      ]);
      const failedProbeRefs = blocked ? [`eliotr.research.external-agent-blocked-${await evidenceSha256({
        domain: "eliotr.research.external-agent-blocked.v1",
        role: role.role,
        result_digest: resultDigest,
      })}`] : [];
      results.push(await branchResult({
        role: role.role,
        status: role.status,
        question_ids: questionsForRole(context.planning, role.role),
        hypothesis_ids: hypothesesForRole(context.planning, role.role),
        evidence_handle_refs: role.evidence_handle_refs,
        observation_refs: await observationRefs(role.role, role.evidence_handle_refs, resultDigest),
        unknowns: blocked ? ["External computer-agent analysis left this required branch unresolved."] : [],
        limitations,
        failed_probe_refs: failedProbeRefs,
        authoritative_disposition: "UNASSESSED",
      }));
    }
""",
)

replace_once(
    "docs/adr/0007-external-agents-and-cloudflare-evolution.md",
    """selected handles are checked against the exact W2 attempt and re-resolved under current evidence
authority. The server derives the canonical branch checkpoint; the external agent cannot mint a branch
reference, observation reference or authoritative disposition. A strict failed callback becomes explicit
""",
    """selected handles are checked against the exact W2 attempt and re-resolved under current evidence
authority. The server derives the canonical branch checkpoint; the external agent cannot mint a branch
reference, observation reference, unknown/limitation prose, failed-probe reference or authoritative disposition.
Agent prose remains quarantined in delivery metadata. A strict failed callback becomes explicit
""",
)

replace_once(
    "docs/adr/0007-external-agents-and-cloudflare-evolution.md",
    """Task deadlines may outlive the original ten-minute W2 reservation, but do not outlive
the exact project grant or current workflow authority. There is no second completion authority.
""",
    """Task deadlines may outlive the original ten-minute W2 reservation, but do not outlive
the exact project grant or current workflow authority. A payload staged before a lost task-publication ACK
can bind the exact task at any later instant before that immutable deadline; replay never extends it. There is
no second completion authority.
""",
)

replace_once(
    "docs/implementation/muse-operator-runbook.md",
    """5. Call `eliotr_task_result` with one stable idempotency key and the strict
   `eliotr.external-branch-analysis.v1` output. Select only evidence handles from the supplied payload.
   Report the observed contour/computer/interface honestly; it is diagnostic metadata, not authority.
""",
    """5. Call `eliotr_task_result` with one stable idempotency key and the strict
   `eliotr.external-branch-analysis.v1` output. Each role record contains only `role`, `status` and selected
   admitted `evidence_handle_refs`; arbitrary role prose is rejected and cannot enter the canonical checkpoint.
   Report the observed contour/computer/interface honestly; it is diagnostic metadata, not authority.
""",
)

replace_once(
    "docs/implementation/muse-operator-runbook.md",
    """The task deadline can outlive the original short W2 execution reservation so an agent can complete GUI
work, but it is still bounded by the exact grant and current workflow authority. Revocation, regrant,
project/scope drift or cancellation fail closed. Owner explicit-protocol runs use deterministic v7;
""",
    """The task deadline can outlive the original short W2 execution reservation so an agent can complete GUI
work, but it is still bounded by the exact grant and current workflow authority. If publication loses its ACK
after staging the payload but before creating the task row, the exact task may still bind before that original
immutable deadline; replay never extends it. Revocation, regrant, project/scope drift or cancellation fail
closed. Owner explicit-protocol runs use deterministic v7;
""",
)
