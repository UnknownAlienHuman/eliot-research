/**
 * Settles v7 branch execution observations on the W1 investigation ledger head.
 *
 * After the branch stages (ANALYZE_BRANCHES / COUNTER_SEARCH) complete, the
 * committed branch reconciliation checkpoint holds evidence-bound observations
 * with stable identities (per-role observation_refs bound to evidence handles,
 * and the reconciliation checkpoint ref itself). This module appends a single
 * OBSERVED ledger event carrying those observations to the W1 head.
 *
 * The settling runs at the session level after the workflow engine completes,
 * not inside a stage handler: the stage checkpoint commit is the sole ledger
 * writer per stage (it reserves the head revision at attempt start and its
 * CHECKPOINT mask forbids observed-state mutation), so a mid-stage OBSERVED
 * append would break the commit's authority check.
 *
 * Safety properties, all enforced by the existing ledger machinery:
 * - Append-only: OBSERVED is an append-only event kind; the ledger mutation
 *   mask forbids touching portfolio_ref / debt_refs and requires the observed
 *   state to actually change.
 * - Permitted: only the ledger owner settles (principal_ref must match), and
 *   only on an OPEN ledger (enforced by the mask).
 * - Evidence-bound: the event payload is the committed reconciliation
 *   checkpoint workflow object; its ref and digest are verified on read, and
 *   the fidelity note carries a digest over the exact observation refs.
 * - Stable branch identities: the event id and the execution note carry the
 *   reconciliation identity digest; per-role observation_refs are
 *   deterministic content hashes.
 * - Identical replay is a no-op: the event id is deterministic per
 *   reconciliation, and an explicit settled-state check skips the append when
 *   the head already carries this reconciliation's observations.
 * - Conflict is integrity failure: divergent bytes under the same event id
 *   raise LEDGER_CONFLICT from the ledger store.
 */
import {
  createD1InvestigationLedgerStore,
  type LedgerD1Database,
  type LedgerEvent,
  type LedgerHead,
} from "@eliotr/research";
import { evidenceSha256 } from "@eliotr/cloudflare-evidence";
import {
  WorkflowCheckpointStore,
  fail,
  readWorkflowObject,
} from "@eliotr/cloudflare-workflows";
import type { ResearchBranchReconciliationCheckpoint } from "@eliotr/contracts";
import { decodeResearchBranchReconciliationCheckpoint } from "./research-branch-execution-shared.js";

export interface SettleW1BranchObservationsInput {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly principal_ref: string;
  /**
   * Whether the run's handler generation executes branches through the shared
   * branch executor (v7/v8). Older generations still commit a COUNTER_SEARCH
   * stage, but its output is not a branch reconciliation checkpoint, so there
   * is nothing to settle. The caller owns generation knowledge; the package
   * must not infer it from the payload.
   */
  readonly branch_execution: boolean;
}

interface W1Observation {
  readonly execution: string;
  readonly fidelity: string;
  readonly assurance: string;
  readonly event_id: string;
}

async function observationFor(
  checkpoint: ResearchBranchReconciliationCheckpoint,
): Promise<W1Observation> {
  const roles = checkpoint.branch_results.map((result) => result.role).sort();
  const observationRefs = checkpoint.branch_results
    .flatMap((result) => result.observation_refs)
    .sort();
  const evidenceHandles = [...new Set(
    checkpoint.branch_results.flatMap((result) => result.evidence_handle_refs),
  )].sort();
  const refsDigest = await evidenceSha256({
    domain: "eliotr.research.w1-observation-refs.v1",
    refs: observationRefs,
  });
  const unmet = [...checkpoint.unmet_required_roles].sort();
  return {
    execution:
      `branch-reconciliation eliotr.research.branch-reconciliation-${checkpoint.identity_digest} ` +
      `roles=${roles.join(",")}`,
    fidelity:
      `observations=${observationRefs.length} evidence_handles=${evidenceHandles.length} ` +
      `observation_refs_digest=${refsDigest}`,
    assurance:
      `counter_search=${checkpoint.counter_search_status} ` +
      `unmet_roles=${unmet.length === 0 ? "none" : unmet.join(",")} ` +
      `contradictions=${checkpoint.unresolved_contradiction_refs.length}`,
    event_id: `eliotr.research.w1-observation-${checkpoint.identity_digest}`,
  };
}

/**
 * Settles the committed branch reconciliation's observations on the W1 head.
 *
 * Returns the W1 head after settling, or null when the operation did not run
 * branch execution (the run's handler generation is not branch-aware, or no
 * committed COUNTER_SEARCH checkpoint exists), in which case there is nothing
 * to settle. When the head already carries this
 * reconciliation's observations the call is a no-op returning the current
 * head.
 */
export async function settleW1BranchObservations(
  input: SettleW1BranchObservationsInput,
): Promise<LedgerHead | null> {
  // The run's generation never executed branches: a committed COUNTER_SEARCH
  // from an older generation is legacy content, not a branch reconciliation
  // checkpoint, so there is nothing to settle.
  if (!input.branch_execution) {
    return null;
  }
  const checkpoints = new WorkflowCheckpointStore(input.database);
  const committed = await checkpoints.readCommittedStageRequest(input.operation_id, "COUNTER_SEARCH");
  if (committed === null || committed.request.investigation_ref.id !== input.investigation_id) {
    return null;
  }
  const receipt = await checkpoints.receipt(committed.request, committed.request_sha256);
  if (receipt === null || receipt.investigation_ref.id !== input.investigation_id) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  // The payload binding: the object ref and digest are verified on read, so a
  // successfully decoded checkpoint is evidence-bound by construction.
  const checkpoint = decodeResearchBranchReconciliationCheckpoint(
    await readWorkflowObject(input.work_bucket, receipt.output_manifest, true),
  );
  if (checkpoint.operation_id !== input.operation_id ||
      checkpoint.investigation_ref.id !== input.investigation_id ||
      checkpoint.principal_ref !== input.principal_ref) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }

  const store = createD1InvestigationLedgerStore(input.database as unknown as LedgerD1Database);
  const snapshot = await store.read(input.investigation_id);
  if (snapshot === null) fail("WORKFLOW_AUTHORITY_STALE");
  const head = snapshot.head;
  // Permitted: only the ledger owner settles W1 observations.
  if (head.principal_ref !== input.principal_ref) fail("WORKFLOW_AUTHORITY_STALE");

  const observation = await observationFor(checkpoint);
  // Identical replay is a no-op: the head already carries this reconciliation's
  // observations, so there is nothing to append.
  if (head.observed_execution === observation.execution &&
      head.observed_fidelity === observation.fidelity &&
      head.observed_assurance === observation.assurance) {
    return head;
  }

  const now = new Date().toISOString();
  const next: LedgerHead = {
    ...head,
    revision: head.revision + 1,
    event_head: head.event_head + 1,
    observed_execution: observation.execution,
    observed_fidelity: observation.fidelity,
    observed_assurance: observation.assurance,
    updated_at: now,
  };
  // The event timestamp is the reconciliation's creation time: the observation
  // was made when the branches were reconciled, and a deterministic timestamp
  // keeps identical retries byte-identical for the ledger's replay check.
  const event: LedgerEvent = {
    investigation_id: head.investigation_id,
    sequence: next.event_head,
    event_id: observation.event_id,
    kind: "OBSERVED",
    payload_handle_ref: receipt.output_manifest.object_ref,
    payload_digest: receipt.output_manifest.sha256,
    actor_ref: input.principal_ref,
    verifier_ref: null,
    created_at: checkpoint.created_at,
  };
  // The store enforces the rest: append-only OBSERVED mask (portfolio/debt
  // refs untouched), identical replay no-op via appliedAlready, and
  // LEDGER_CONFLICT on divergent bytes under the same event id.
  return store.append(next, head.revision, event);
}
