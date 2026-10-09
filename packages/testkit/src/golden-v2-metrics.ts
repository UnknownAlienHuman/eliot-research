import {
  assertOnlyKeys,
  deepFreeze,
  isRecord,
  requireString,
  type GoldenCaseMetrics,
  type GoldenMetricRequirements,
  type GoldenSourceFamilyCount,
} from "./golden-v2-manifest.js";

const EMPTY_METRICS: GoldenCaseMetrics = {
  source_family_counts: [],
  latency_ms: null,
  cost_micros: null,
};

interface NormalizedMetrics {
  readonly metrics: GoldenCaseMetrics;
  readonly failures: readonly string[];
}

function normalizeMetrics(caseId: string, raw: unknown): NormalizedMetrics {
  if (raw === undefined) return { metrics: EMPTY_METRICS, failures: [] };
  if (!isRecord(raw)) {
    return { metrics: EMPTY_METRICS, failures: ["MALFORMED_GOLDEN_METRICS:" + caseId] };
  }
  try {
    assertOnlyKeys(raw, ["source_family_counts", "latency_ms", "cost_micros"], "metrics");
    const rawCounts = raw["source_family_counts"];
    if (rawCounts !== undefined && (!Array.isArray(rawCounts) || rawCounts.length > 64)) {
      throw new Error("source_family_counts");
    }
    const counts: GoldenSourceFamilyCount[] = [];
    const seen = new Set<string>();
    for (const entry of rawCounts ?? []) {
      if (!isRecord(entry)) throw new Error("source_family_counts");
      assertOnlyKeys(entry, ["source_family", "source_count"], "source_family_count");
      const family = requireString(entry["source_family"], "source_family", 64);
      const count = entry["source_count"];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        throw new Error("source_count");
      }
      if (seen.has(family)) throw new Error("duplicate source_family");
      seen.add(family);
      counts.push({ source_family: family, source_count: count });
    }
    const metricNumber = (field: "latency_ms" | "cost_micros"): number | null => {
      const value = raw[field];
      if (value === undefined || value === null) return null;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(field);
      }
      return value;
    };
    return {
      metrics: deepFreeze({
        source_family_counts: counts,
        latency_ms: metricNumber("latency_ms"),
        cost_micros: metricNumber("cost_micros"),
      }),
      failures: [],
    };
  } catch {
    return { metrics: EMPTY_METRICS, failures: ["MALFORMED_GOLDEN_METRICS:" + caseId] };
  }
}

function requirementFailures(
  caseId: string,
  requirements: GoldenMetricRequirements,
  metrics: GoldenCaseMetrics,
): string[] {
  const failures: string[] = [];
  const observedFamilies = new Map(metrics.source_family_counts.map((entry) => [entry.source_family, entry.source_count]));
  for (const requirement of requirements.source_family_requirements) {
    const count = observedFamilies.get(requirement.source_family);
    if (count === undefined) {
      failures.push("MISSING_SOURCE_FAMILY_METRIC:" + caseId + ":" + requirement.source_family);
    } else if (count < requirement.minimum_sources) {
      failures.push("SOURCE_FAMILY_INSUFFICIENT:" + caseId + ":" + requirement.source_family);
    }
  }
  if (requirements.latency_budget_ms !== undefined) {
    if (metrics.latency_ms === null) failures.push("MISSING_LATENCY_METRIC:" + caseId);
    else if (metrics.latency_ms > requirements.latency_budget_ms) failures.push("LATENCY_BUDGET_EXCEEDED:" + caseId);
  }
  if (requirements.cost_budget_micros !== undefined) {
    if (metrics.cost_micros === null) failures.push("MISSING_COST_METRIC:" + caseId);
    else if (metrics.cost_micros > requirements.cost_budget_micros) failures.push("COST_BUDGET_EXCEEDED:" + caseId);
  }
  return failures;
}

export function validateGoldenMetrics(
  caseId: string,
  requirements: GoldenMetricRequirements,
  raw: unknown,
): readonly string[] {
  const normalized = normalizeMetrics(caseId, raw);
  return [...normalized.failures, ...requirementFailures(caseId, requirements, normalized.metrics)];
}

export function adjudicateGoldenCaseMetrics(
  caseId: string,
  requirements: GoldenMetricRequirements,
  raw: unknown,
): { readonly metrics: GoldenCaseMetrics; readonly failures: readonly string[] } {
  const normalized = normalizeMetrics(caseId, raw);
  return {
    metrics: normalized.metrics,
    failures: [...normalized.failures, ...requirementFailures(caseId, requirements, normalized.metrics)],
  };
}
