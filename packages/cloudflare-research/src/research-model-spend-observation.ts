import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  type ModelGatewayPricingPort,
} from "@eliotr/cloudflare-ai";
import {
  observeOperationSettlement,
  parseAdmissionRow,
  parseAttemptRow,
  spendIdentifier,
  spendObservationFail,
  spendRoundUsd,
  spendTimestamp,
  type AdmissionRow,
  type AttemptRow,
  type OperationSpendObservation,
  type SettlementContext,
  type SpendObservationCostTargets,
  type SpendObservationVerdict,
} from "./research-model-spend-settlement.js";

export {
  ResearchModelSpendObservationError,
  type AttemptSettlementCounts,
  type OperationQuotedCost,
  type OperationSpendObservation,
  type RepricingStatus,
  type ResearchModelSpendObservationErrorCode,
  type SpendObservationCostTargets,
  type SpendObservationVerdict,
  type SpendSettlement,
} from "./research-model-spend-settlement.js";

export const RESEARCH_MODEL_SPEND_OBSERVATION_PROTOCOL = "eliotr.research-model-spend-observation.v1" as const;

export interface SpendObservationWindow {
  readonly from: string;
  readonly to: string;
}

export interface SpendObservationInput {
  /** UTC canonical ISO-8601 window; admissions are selected by created_at. */
  readonly window: SpendObservationWindow;
  readonly workflow_operation_ids?: readonly string[];
  /** W3 model stage indexes (12/13/14). */
  readonly stage_indexes?: readonly number[];
  /** Approved pricing snapshot ref used for independent repricing. */
  readonly pricing_snapshot_ref: string;
  /** Cost envelope. Never invented: the caller supplies it (T6 trial definition owns it). */
  readonly cost_targets: SpendObservationCostTargets;
}

export interface ResearchModelSpendObserverOptions {
  /** Pricing port override (tests). Defaults to the D1 exact-token quote port. */
  readonly pricing?: ModelGatewayPricingPort;
  readonly now?: () => number;
}

export interface OrphanModelAttempt {
  readonly attempt_id: string;
  readonly reservation_id: string;
  readonly state: string;
  readonly started_at: string;
}

export interface OperationKindCostStats {
  readonly count: number;
  readonly p50_actual_usd: number;
  readonly p95_actual_usd: number;
}

export interface SpendObservationAggregate {
  readonly operations_observed: number;
  readonly operations_passed: number;
  readonly operations_failed: number;
  readonly operations_blocked: number;
  readonly quoted_total_usd: number;
  readonly actual_total_usd: number;
  readonly repriced_total_usd: number;
  readonly byok_total_usd: number;
  readonly total_target_exceeded: boolean;
  readonly reprice_complete: boolean;
  readonly orphans_found: boolean;
  readonly per_operation_kind: Readonly<Record<string, OperationKindCostStats>>;
}

export interface SpendObservationReport {
  readonly protocol: typeof RESEARCH_MODEL_SPEND_OBSERVATION_PROTOCOL;
  readonly observation_ref: string;
  readonly window: SpendObservationWindow;
  readonly pricing_snapshot_ref: string;
  readonly cost_targets: SpendObservationCostTargets;
  readonly operations: readonly OperationSpendObservation[];
  readonly orphans: readonly OrphanModelAttempt[];
  readonly aggregate: SpendObservationAggregate;
  readonly verdict: SpendObservationVerdict;
  readonly empty_window: boolean;
  readonly observed_at: string;
}

function validateInput(input: SpendObservationInput): {
  readonly from: string;
  readonly to: string;
  readonly workflowOperationIds: readonly string[] | null;
  readonly stageIndexes: readonly number[] | null;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    spendObservationFail("SPEND_OBSERVATION_INPUT_INVALID", "observation input is invalid");
  }
  const window = (input as { window?: unknown }).window;
  if (window === null || typeof window !== "object" || Array.isArray(window)) {
    spendObservationFail("SPEND_OBSERVATION_INPUT_INVALID", "observation window is invalid");
  }
  const from = spendTimestamp((window as { from?: unknown }).from, "window.from");
  const to = spendTimestamp((window as { to?: unknown }).to, "window.to");
  if (Date.parse(from) >= Date.parse(to)) spendObservationFail("SPEND_OBSERVATION_INPUT_INVALID", "observation window is empty or inverted");
  spendIdentifier(input.pricing_snapshot_ref, "pricing_snapshot_ref");
  const targets = input.cost_targets;
  if (targets === null || typeof targets !== "object" || Array.isArray(targets)) {
    spendObservationFail("SPEND_OBSERVATION_INPUT_INVALID", "cost targets are invalid");
  }
  // Cost targets are caller-supplied input, not D1 readback: invalid values
  // are INPUT_INVALID, never READBACK_CORRUPT.
  for (const key of ["max_usd_per_operation", "max_total_usd"] as const) {
    const value = (targets as unknown as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      spendObservationFail("SPEND_OBSERVATION_INPUT_INVALID", `cost_targets.${key} is invalid`);
    }
  }
  let workflowOperationIds: readonly string[] | null = null;
  if (input.workflow_operation_ids !== undefined) {
    if (!Array.isArray(input.workflow_operation_ids) || input.workflow_operation_ids.length === 0) {
      spendObservationFail("SPEND_OBSERVATION_INPUT_INVALID", "workflow_operation_ids is invalid");
    }
    workflowOperationIds = Object.freeze(input.workflow_operation_ids.map((id) => spendIdentifier(id, "workflow_operation_id")));
  }
  let stageIndexes: readonly number[] | null = null;
  if (input.stage_indexes !== undefined) {
    if (!Array.isArray(input.stage_indexes) || input.stage_indexes.length === 0) {
      spendObservationFail("SPEND_OBSERVATION_INPUT_INVALID", "stage_indexes is invalid");
    }
    for (const stage of input.stage_indexes) {
      if (!Number.isSafeInteger(stage) || ![12, 13, 14].includes(stage)) {
        spendObservationFail("SPEND_OBSERVATION_INPUT_INVALID", "stage_indexes must be W3 model stages (12, 13, 14)");
      }
    }
    stageIndexes = Object.freeze([...input.stage_indexes]);
  }
  return { from, to, workflowOperationIds, stageIndexes };
}

async function selectAll(database: D1Database, sql: string, binds: readonly unknown[]): Promise<Record<string, unknown>[]> {
  let result: { results?: unknown };
  try {
    result = await database.prepare(sql).bind(...binds).all();
  } catch (cause) {
    spendObservationFail("SPEND_OBSERVATION_PERSISTENCE_UNCERTAIN", "spend observation read failed", true, cause);
  }
  if (!Array.isArray(result.results)) spendObservationFail("SPEND_OBSERVATION_PERSISTENCE_UNCERTAIN", "spend observation read returned no rows");
  return result.results as Record<string, unknown>[];
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] as number;
}

export function createD1ResearchModelSpendObserver(
  database: D1Database,
  options: ResearchModelSpendObserverOptions = {},
): { observe(input: SpendObservationInput): Promise<SpendObservationReport> } {
  if (typeof database !== "object" || database === null || typeof database.prepare !== "function") {
    spendObservationFail("SPEND_OBSERVATION_INPUT_INVALID", "spend observer database binding is invalid");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    spendObservationFail("SPEND_OBSERVATION_INPUT_INVALID", "spend observer options are invalid");
  }
  const pricingOverrideRaw: unknown = options.pricing;
  let pricingOverride: ModelGatewayPricingPort | undefined;
  if (pricingOverrideRaw !== undefined) {
    if (
      typeof pricingOverrideRaw !== "object" ||
      pricingOverrideRaw === null ||
      typeof (pricingOverrideRaw as { readonly quote?: unknown }).quote !== "function"
    ) {
      spendObservationFail("SPEND_OBSERVATION_INPUT_INVALID", "spend observer pricing port is invalid");
    }
    pricingOverride = pricingOverrideRaw as ModelGatewayPricingPort;
  }
  const now = options.now ?? (() => Date.now());
  if (typeof now !== "function") spendObservationFail("SPEND_OBSERVATION_INPUT_INVALID", "spend observer clock is invalid");

  async function observe(input: SpendObservationInput): Promise<SpendObservationReport> {
    const validated = validateInput(input);
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs)) spendObservationFail("SPEND_OBSERVATION_INPUT_INVALID", "spend observer clock is invalid");
    const observedAt = new Date(nowMs).toISOString();

    const admissionBinds: unknown[] = [validated.from, validated.to];
    let admissionSql =
      "SELECT authorization_ref, operation_id, workflow_operation_id, stage_index, reservation_id, quote_json, route_ref, principal_ref, created_at " +
      "FROM research_model_spend_admission WHERE created_at >= ?1 AND created_at < ?2";
    if (validated.workflowOperationIds !== null) {
      const placeholders = validated.workflowOperationIds.map((_, index) => `?${admissionBinds.length + index + 1}`).join(",");
      admissionSql += ` AND workflow_operation_id IN (${placeholders})`;
      admissionBinds.push(...validated.workflowOperationIds);
    }
    if (validated.stageIndexes !== null) {
      const placeholders = validated.stageIndexes.map((_, index) => `?${admissionBinds.length + index + 1}`).join(",");
      admissionSql += ` AND stage_index IN (${placeholders})`;
      admissionBinds.push(...validated.stageIndexes);
    }
    admissionSql += " ORDER BY created_at ASC, authorization_ref ASC";

    const admissionRows = await selectAll(database, admissionSql, admissionBinds);
    const admissions: AdmissionRow[] = admissionRows.map(parseAdmissionRow);
    const reservationIds = [...new Set(admissions.map((admission) => admission.reservation_id))];

    let attemptRows: Record<string, unknown>[] = [];
    if (reservationIds.length > 0) {
      const placeholders = reservationIds.map((_, index) => `?${index + 1}`).join(",");
      attemptRows = await selectAll(
        database,
        "SELECT attempt_id, reservation_id, operation_kind, state, receipt_json, receipt_sha256, started_at " +
          `FROM research_model_attempt WHERE reservation_id IN (${placeholders}) ORDER BY started_at ASC, attempt_id ASC`,
        reservationIds,
      );
    }
    const attemptsByReservation = new Map<string, AttemptRow[]>();
    for (const row of attemptRows) {
      const attempt = parseAttemptRow(row);
      const list = attemptsByReservation.get(attempt.reservation_id) ?? [];
      list.push(attempt);
      attemptsByReservation.set(attempt.reservation_id, list);
    }

    const context: SettlementContext = {
      database,
      ...(pricingOverride === undefined ? {} : { pricing: pricingOverride }),
      pricingSnapshotRef: input.pricing_snapshot_ref,
      costTargets: input.cost_targets,
      nowMs,
    };
    const operations: OperationSpendObservation[] = [];
    for (const admission of admissions) {
      operations.push(
        await observeOperationSettlement(admission, attemptsByReservation.get(admission.reservation_id) ?? [], context),
      );
    }

    // A true orphan is an attempt with no spend admission at all. The
    // NOT EXISTS form avoids window-edge false positives where the admission
    // was created before the window but the attempt started inside it.
    const orphanRows = await selectAll(
      database,
      "SELECT attempt_id, reservation_id, state, started_at FROM research_model_attempt AS m " +
        "WHERE m.started_at >= ?1 AND m.started_at < ?2 " +
        "AND NOT EXISTS (SELECT 1 FROM research_model_spend_admission AS s WHERE s.reservation_id = m.reservation_id) " +
        "ORDER BY m.started_at ASC",
      [validated.from, validated.to],
    );
    const orphans: OrphanModelAttempt[] = orphanRows.map((row) =>
      Object.freeze({
        attempt_id: spendIdentifier(row.attempt_id, "orphan.attempt_id"),
        reservation_id: spendIdentifier(row.reservation_id, "orphan.reservation_id"),
        state: spendIdentifier(row.state, "orphan.state"),
        started_at: spendTimestamp(row.started_at, "orphan.started_at"),
      }),
    );

    const kindActuals = new Map<string, number[]>();
    let quotedTotal = 0;
    let actualTotal = 0;
    let repricedTotal = 0;
    let byokTotal = 0;
    let passed = 0;
    let failed = 0;
    let blocked = 0;
    let repriceComplete = true;
    for (const operation of operations) {
      if (operation.verdict === "PASS") passed += 1;
      else if (operation.verdict === "FAIL") failed += 1;
      else blocked += 1;
      quotedTotal = spendRoundUsd(quotedTotal + operation.quoted.quoted_total_usd);
      byokTotal = spendRoundUsd(byokTotal + operation.quoted.byok_usd);
      if (operation.actual_usd !== null) {
        actualTotal = spendRoundUsd(actualTotal + operation.actual_usd);
        const list = kindActuals.get(operation.operation_kind) ?? [];
        list.push(operation.actual_usd);
        kindActuals.set(operation.operation_kind, list);
      }
      if (operation.repriced_usd !== null) repricedTotal = spendRoundUsd(repricedTotal + operation.repriced_usd);
      if (operation.settlement === "SETTLED" && operation.attempts.succeeded > 0 && operation.repriced_usd === null) {
        repriceComplete = false;
      }
    }
    const perOperationKind: Record<string, OperationKindCostStats> = {};
    for (const [kind, values] of kindActuals) {
      const sorted = [...values].sort((a, b) => a - b);
      perOperationKind[kind] = {
        count: sorted.length,
        p50_actual_usd: spendRoundUsd(percentile(sorted, 50)),
        p95_actual_usd: spendRoundUsd(percentile(sorted, 95)),
      };
    }

    const totalTargetExceeded = actualTotal > input.cost_targets.max_total_usd;
    const orphansFound = orphans.length > 0;
    let verdict: SpendObservationVerdict = "PASS";
    // Fail-closed ordering: hard failures first, then orphans (spend without
    // a quote is a control violation), then blocks. A window with no
    // admissions and no orphans observed nothing and stays BLOCKED, never PASS.
    if (failed > 0 || totalTargetExceeded || orphansFound) verdict = "FAIL";
    else if (blocked > 0) verdict = "BLOCKED";
    const emptyWindow = operations.length === 0 && !orphansFound;
    if (emptyWindow) verdict = "BLOCKED";

    const body = {
      protocol: RESEARCH_MODEL_SPEND_OBSERVATION_PROTOCOL,
      window: { from: validated.from, to: validated.to },
      pricing_snapshot_ref: input.pricing_snapshot_ref,
      cost_targets: {
        max_usd_per_operation: input.cost_targets.max_usd_per_operation,
        max_total_usd: input.cost_targets.max_total_usd,
      },
      operations,
      orphans,
      aggregate: {
        operations_observed: operations.length,
        operations_passed: passed,
        operations_failed: failed,
        operations_blocked: blocked,
        quoted_total_usd: quotedTotal,
        actual_total_usd: actualTotal,
        repriced_total_usd: repricedTotal,
        byok_total_usd: byokTotal,
        total_target_exceeded: totalTargetExceeded,
        reprice_complete: repriceComplete,
        orphans_found: orphansFound,
        per_operation_kind: perOperationKind,
      },
      verdict,
      empty_window: emptyWindow,
      observed_at: observedAt,
    };
    const observationRef = `spend-observation-${await modelGatewaySha256(canonicalModelGatewayJson(body))}`;
    return Object.freeze({ ...body, observation_ref: observationRef });
  }

  return Object.freeze({ observe });
}
