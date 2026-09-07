// Admission-receipt evidence binding: per-metric tamper-evidence for receipts.
//
// An ADMITTED receipt is a locator that heavy paths trust across process
// boundaries, so every admitted metric must bind to its exact account,
// source, envelope generation, collection window, provider
// identity/provenance brand class, and coverage/readback status. This module builds that
// evidence from the live evaluation path (snapshot metrics plus
// readback.metric_trust) and recomputes the snapshot digest on validation, so
// a hand-forged shell without evidence — or any tampering with source,
// generation, account, windows, metrics, or evidence — fails closed. ADMITTED
// additionally requires a live provider evidence family: snapshot-asserted
// and test-only families (self-consistent without any live collection)
// validate structurally at most and never authorize heavy work.
//
// The taxonomy contract (required keys, metric windows, provenance strings,
// snapshot labels) is injected by cloudflare-usage-envelope.mjs so this
// module never duplicates canonical strings and no import cycle exists.

import { createHash } from "node:crypto";

// Canonical JSON: sorted keys, recursive, no whitespace. Both builder and
// validator use it, so any field mutation breaks the digest.
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

// Snapshot digest: sha256 over canonical account + source + generation +
// windows + metrics + evidence, exactly as the receipt schema requires.
// Source and generation are bound (not just carried) so flipping the snapshot
// source, the envelope generation, or any security-relevant field — account,
// windows, metrics, per-metric provenance families, evidence — breaks the
// digest. Provenance families ride inside the evidence entries, which are
// part of the digest input.
export function computeSnapshotDigest({ accountIdDigest, source, generation, windows, metrics, evidence }) {
  return createHash("sha256")
    .update(canonicalJson({ account_id_digest: accountIdDigest, generation, metrics, metric_evidence: evidence, source, windows }), "utf8")
    .digest("hex");
}

function evidenceWindow(snapshot, metricWindow) {
  if (metricWindow === "daily") return snapshot.daily_window ?? null;
  return snapshot.window ?? null;
}

// Build one evidence entry per required metric from the live evaluation path:
// trust records (brand class, provenance, coverage) where the collector
// recorded them, honest snapshot-asserted labels where no provider authority
// exists (fixtures, sealed unknowns). Never invents provider authority.
export function buildMetricEvidence(snapshot, contract) {
  const trustByMetric = snapshot?.readback?.metric_trust ?? {};
  return contract.requiredKeys.map((metric) => {
    const value = snapshot?.metrics?.[metric];
    const trust = trustByMetric[metric];
    const window = evidenceWindow(snapshot, contract.windowKindOf(metric));
    if (trust && typeof trust.brand === "string" && trust.brand !== "") {
      return {
        metric,
        value: value ?? "unknown",
        provider_group: trust.sources?.[0] ?? "unrecorded",
        provider_kind_class: trust.brand,
        provenance: trust.provenance ?? contract.unavailableProvenance,
        window_start: window?.start ?? null,
        window_end: window?.end ?? null,
        coverage_full: trust.coverage?.fullAccount === true,
        account_id_digest: snapshot?.account_id_digest ?? "missing",
      };
    }
    return {
      metric,
      value: value ?? "unknown",
      provider_group: contract.snapshotProvenance,
      provider_kind_class: contract.snapshotKindClass,
      provenance: contract.snapshotProvenance,
      window_start: window?.start ?? null,
      window_end: window?.end ?? null,
      coverage_full: false,
      account_id_digest: snapshot?.account_id_digest ?? "missing",
    };
  });
}

function isLiveClass(kindClass, contract) {
  return kindClass === contract.billingKindClass || contract.inventoryKindClasses.includes(kindClass);
}

// Validate evidence coherence. Always (every decision): presence, shape,
// account binding, and digest recomputation (now covering source and
// generation too, so source/generation tampering breaks the digest).
// Strict (ADMITTED only): completeness (no missing/duplicated/conflicting
// entries), window binding, live-family uniformity (every entry live-trusted:
// test-only and snapshot-asserted families validate structurally at most and
// never authorize heavy work), trusted provenance pairing with the brand
// class, coverage flags, and window freshness. Returns an array of reasons
// (empty = coherent).
export function validateMetricEvidence(receipt, contract, { now = Date.now(), strict = false } = {}) {
  const reasons = [];
  const metrics = receipt?.metrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    reasons.push("admission receipt must carry the evaluated metrics object; refusing evidenceless receipt");
    return reasons;
  }
  const evidence = receipt?.metric_evidence;
  if (!Array.isArray(evidence)) {
    reasons.push("admission receipt carries no per-metric evidence; refusing evidenceless receipt");
    return reasons;
  }
  if (typeof receipt?.snapshot_digest !== "string" || receipt.snapshot_digest === "") {
    reasons.push("admission receipt snapshot digest binding is missing; refusing evidenceless receipt");
    return reasons;
  }
  const recomputed = computeSnapshotDigest({
    accountIdDigest: receipt.account_id_digest,
    source: receipt.source ?? "missing",
    generation: receipt.generation ?? "missing",
    windows: { monthly: receipt.windows?.monthly ?? null, daily: receipt.windows?.daily ?? null },
    metrics,
    evidence,
  });
  if (recomputed !== receipt.snapshot_digest) {
    reasons.push("admission receipt snapshot digest mismatch; refusing tampered receipt");
    return reasons;
  }
  if (!strict) return reasons;
  const seen = new Map();
  for (const entry of evidence) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      reasons.push("admission receipt evidence entry must be an object; refusing forged receipt");
      continue;
    }
    if (seen.has(entry.metric)) {
      reasons.push(`admission receipt carries duplicated evidence for ${entry.metric}; refusing forged receipt`);
      continue;
    }
    seen.set(entry.metric, entry);
  }
  const missing = contract.requiredKeys.filter((key) => !seen.has(key));
  if (missing.length > 0) {
    reasons.push(`admission receipt evidence is missing metrics: ${missing.join(", ")}; refusing forged receipt`);
  }
  const unexpected = [...seen.keys()].filter((key) => !contract.requiredKeys.includes(key));
  if (unexpected.length > 0) {
    reasons.push(`admission receipt evidence carries unknown metrics: ${unexpected.join(", ")}; refusing forged receipt`);
  }
  let liveCount = 0;
  let snapshotCount = 0;
  for (const key of contract.requiredKeys) {
    const entry = seen.get(key);
    if (!entry) continue;
    if (!Object.is(metrics[key], entry.value) && !(Number.isNaN(metrics[key]) && Number.isNaN(entry.value))) {
      reasons.push(`admission receipt evidence conflicts with metrics for ${key}; refusing forged receipt`);
    }
    if (entry.account_id_digest !== receipt.account_id_digest) {
      reasons.push(`admission receipt evidence for ${key} binds a different account; refusing forged receipt`);
    }
    const expectedWindow = contract.windowKindOf(key) === "daily" ? receipt.windows?.daily : receipt.windows?.monthly;
    if (entry.window_start !== expectedWindow?.start || entry.window_end !== expectedWindow?.end) {
      reasons.push(`admission receipt evidence for ${key} binds a different window; refusing forged receipt`);
    }
    if (typeof entry.provider_group !== "string" || entry.provider_group === "" || entry.provider_group === "unrecorded") {
      reasons.push(`admission receipt evidence for ${key} names no provider; refusing forged receipt`);
    }
    if (isLiveClass(entry.provider_kind_class, contract)) {
      liveCount += 1;
      const trusted = entry.provenance === contract.billingProvenance || entry.provenance === contract.inventoryProvenance;
      if (!trusted) {
        reasons.push(`admission receipt evidence for ${key} carries untrusted provenance; refusing forged receipt`);
      }
      const pairs = (entry.provider_kind_class === contract.billingKindClass && entry.provenance === contract.billingProvenance) ||
        (contract.inventoryKindClasses.includes(entry.provider_kind_class) && entry.provenance === contract.inventoryProvenance);
      if (!pairs) {
        reasons.push(`admission receipt evidence for ${key} pairs provider class with the wrong provenance; refusing forged receipt`);
      }
      if (entry.coverage_full !== true) {
        reasons.push(`admission receipt evidence for ${key} lacks full account coverage; refusing forged receipt`);
      }
    } else if (entry.provider_kind_class === contract.snapshotKindClass && entry.provenance === contract.snapshotProvenance) {
      snapshotCount += 1;
      if (entry.coverage_full !== false) {
        reasons.push(`admission receipt evidence for ${key} claims coverage without provider authority; refusing forged receipt`);
      }
    } else {
      reasons.push(`admission receipt evidence for ${key} carries untrusted provenance; refusing forged receipt`);
    }
  }
  if (liveCount > 0 && snapshotCount > 0) {
    reasons.push("admission receipt mixes provider evidence with snapshot-asserted entries; refusing forged receipt");
  }
  // ADMITTED authorizes heavy work, so it additionally requires a live
  // provider family: a fully self-consistent snapshot-asserted or test-only
  // receipt (mintable by anyone knowing the account ID, without any live
  // collection) validates structurally at most and never authorizes.
  // Non-empty exact coverage is enforced independently here: a zero-length
  // authority set never admits, even if every() would be vacuously true.
  const requiredLen = Array.isArray(contract.requiredKeys) ? contract.requiredKeys.length : 0;
  if (requiredLen === 0) {
    reasons.push("authority metric set is empty; refusing vacuous admission");
  } else if (liveCount === 0) {
    reasons.push("admission receipt carries no live provider evidence (snapshot-asserted/test-only family never authorizes heavy work); refusing forged receipt");
  } else if (liveCount !== requiredLen) {
    reasons.push("admission receipt live evidence does not exactly cover the required set; refusing forged receipt");
  }
  const monthly = receipt.windows?.monthly;
  if (monthly && (Date.parse(monthly.start) > now + contract.clockSkewMs || now > Date.parse(monthly.end))) {
    reasons.push("admission receipt monthly window does not cover now; re-run the usage preflight before mutating");
  }
  const daily = receipt.windows?.daily;
  if (daily !== null && daily !== undefined &&
    (Date.parse(daily.start) > now + contract.clockSkewMs || now > Date.parse(daily.end))) {
    reasons.push("admission receipt daily window does not cover now; re-run the usage preflight before mutating");
  }
  return reasons;
}
