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
// FIX14: manual insertion sort and index-assembled parts (no
// Array.prototype.map/sort/join, whose prototypes are mutable ambient
// behavior). Sort poisoning can only fail the digest closed, never admit.
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out += ",";
      out += canonicalJson(value[i]);
    }
    return `${out}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    for (let i = 1; i < keys.length; i += 1) {
      const current = keys[i];
      let j = i - 1;
      while (j >= 0 && keys[j] > current) {
        keys[j + 1] = keys[j];
        j -= 1;
      }
      keys[j + 1] = current;
    }
    let out = "{";
    for (let i = 0; i < keys.length; i += 1) {
      if (i > 0) out += ",";
      out += `${JSON.stringify(keys[i])}:${canonicalJson(value[keys[i]])}`;
    }
    return `${out}}`;
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
  const out = [];
  for (let i = 0; i < contract.requiredKeys.length; i += 1) {
    const metric = contract.requiredKeys[i];
    const value = snapshot?.metrics?.[metric];
    const trust = trustByMetric[metric];
    const window = evidenceWindow(snapshot, contract.windowKindOf(metric));
    if (trust && typeof trust.brand === "string" && trust.brand !== "") {
      const firstSource = Array.isArray(trust.sources) && typeof trust.sources[0] === "string" ? trust.sources[0] : "unrecorded";
      out[out.length] = {
        metric,
        value: value ?? "unknown",
        provider_group: firstSource,
        provider_kind_class: trust.brand,
        provenance: trust.provenance ?? contract.unavailableProvenance,
        window_start: window?.start ?? null,
        window_end: window?.end ?? null,
        coverage_full: trust.coverage?.fullAccount === true,
        account_id_digest: snapshot?.account_id_digest ?? "missing",
      };
    } else {
      out[out.length] = {
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
    }
  }
  return out;
}

function isLiveClass(kindClass, contract) {
  if (kindClass === contract.billingKindClass) return true;
  for (let i = 0; i < contract.inventoryKindClasses.length; i += 1) {
    if (kindClass === contract.inventoryKindClasses[i]) return true;
  }
  return false;
}

function inventoryClassPairs(kindClass, contract) {
  for (let i = 0; i < contract.inventoryKindClasses.length; i += 1) {
    if (kindClass === contract.inventoryKindClasses[i]) return true;
  }
  return false;
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
  const deny = (message) => { reasons[reasons.length] = message; };
  const metrics = receipt?.metrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    deny("admission receipt must carry the evaluated metrics object; refusing evidenceless receipt");
    return reasons;
  }
  const evidence = receipt?.metric_evidence;
  if (!Array.isArray(evidence)) {
    deny("admission receipt carries no per-metric evidence; refusing evidenceless receipt");
    return reasons;
  }
  if (typeof receipt?.snapshot_digest !== "string" || receipt.snapshot_digest === "") {
    deny("admission receipt snapshot digest binding is missing; refusing evidenceless receipt");
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
    deny("admission receipt snapshot digest mismatch; refusing tampered receipt");
    return reasons;
  }
  if (!strict) return reasons;
  // FIX14: null-prototype seen table with explicit === scans (no Map, no
  // Array.prototype filter/includes, no for..of iterator).
  const seenTable = Object.create(null);
  const seenKeys = [];
  for (let i = 0; i < evidence.length; i += 1) {
    const entry = evidence[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      deny("admission receipt evidence entry must be an object; refusing forged receipt");
      continue;
    }
    const metric = entry.metric;
    if (typeof metric !== "string" || metric === "") {
      deny("admission receipt evidence entry must be an object; refusing forged receipt");
      continue;
    }
    let duplicate = false;
    for (let j = 0; j < seenKeys.length; j += 1) {
      if (seenKeys[j] === metric) { duplicate = true; break; }
    }
    if (duplicate) {
      deny(`admission receipt carries duplicated evidence for ${metric}; refusing forged receipt`);
      continue;
    }
    seenKeys[seenKeys.length] = metric;
    seenTable[metric] = entry;
  }
  const requiredHas = (key) => {
    for (let i = 0; i < contract.requiredKeys.length; i += 1) {
      if (contract.requiredKeys[i] === key) return true;
    }
    return false;
  };
  const missing = [];
  for (let i = 0; i < contract.requiredKeys.length; i += 1) {
    const key = contract.requiredKeys[i];
    let found = false;
    for (let j = 0; j < seenKeys.length; j += 1) {
      if (seenKeys[j] === key) { found = true; break; }
    }
    if (!found) missing[missing.length] = key;
  }
  if (missing.length > 0) {
    let list = "";
    for (let i = 0; i < missing.length; i += 1) list += (i > 0 ? ", " : "") + missing[i];
    deny(`admission receipt evidence is missing metrics: ${list}; refusing forged receipt`);
  }
  const unexpected = [];
  for (let i = 0; i < seenKeys.length; i += 1) {
    if (!requiredHas(seenKeys[i])) unexpected[unexpected.length] = seenKeys[i];
  }
  if (unexpected.length > 0) {
    let list = "";
    for (let i = 0; i < unexpected.length; i += 1) list += (i > 0 ? ", " : "") + unexpected[i];
    deny(`admission receipt evidence carries unknown metrics: ${list}; refusing forged receipt`);
  }
  let liveCount = 0;
  let snapshotCount = 0;
  for (let i = 0; i < contract.requiredKeys.length; i += 1) {
    const key = contract.requiredKeys[i];
    let found = false;
    for (let j = 0; j < seenKeys.length; j += 1) {
      if (seenKeys[j] === key) { found = true; break; }
    }
    if (!found) continue;
    const entry = seenTable[key];
    if (!entry) continue;
    if (!Object.is(metrics[key], entry.value) && !(Number.isNaN(metrics[key]) && Number.isNaN(entry.value))) {
      deny(`admission receipt evidence conflicts with metrics for ${key}; refusing forged receipt`);
    }
    if (entry.account_id_digest !== receipt.account_id_digest) {
      deny(`admission receipt evidence for ${key} binds a different account; refusing forged receipt`);
    }
    const expectedWindow = contract.windowKindOf(key) === "daily" ? receipt.windows?.daily : receipt.windows?.monthly;
    if (entry.window_start !== expectedWindow?.start || entry.window_end !== expectedWindow?.end) {
      deny(`admission receipt evidence for ${key} binds a different window; refusing forged receipt`);
    }
    if (typeof entry.provider_group !== "string" || entry.provider_group === "" || entry.provider_group === "unrecorded") {
      deny(`admission receipt evidence for ${key} names no provider; refusing forged receipt`);
    }
    if (isLiveClass(entry.provider_kind_class, contract)) {
      liveCount += 1;
      const trusted = entry.provenance === contract.billingProvenance || entry.provenance === contract.inventoryProvenance;
      if (!trusted) {
        deny(`admission receipt evidence for ${key} carries untrusted provenance; refusing forged receipt`);
      }
      const pairs = (entry.provider_kind_class === contract.billingKindClass && entry.provenance === contract.billingProvenance) ||
        (inventoryClassPairs(entry.provider_kind_class, contract) && entry.provenance === contract.inventoryProvenance);
      if (!pairs) {
        deny(`admission receipt evidence for ${key} pairs provider class with the wrong provenance; refusing forged receipt`);
      }
      if (entry.coverage_full !== true) {
        deny(`admission receipt evidence for ${key} lacks full account coverage; refusing forged receipt`);
      }
    } else if (entry.provider_kind_class === contract.snapshotKindClass && entry.provenance === contract.snapshotProvenance) {
      snapshotCount += 1;
      if (entry.coverage_full !== false) {
        deny(`admission receipt evidence for ${key} claims coverage without provider authority; refusing forged receipt`);
      }
    } else {
      deny(`admission receipt evidence for ${key} carries untrusted provenance; refusing forged receipt`);
    }
  }
  if (liveCount > 0 && snapshotCount > 0) {
    deny("admission receipt mixes provider evidence with snapshot-asserted entries; refusing forged receipt");
  }
  // ADMITTED authorizes heavy work, so it additionally requires a live
  // provider family: a fully self-consistent snapshot-asserted or test-only
  // receipt (mintable by anyone knowing the account ID, without any live
  // collection) validates structurally at most and never authorizes.
  // Non-empty exact coverage is enforced independently here: a zero-length
  // authority set never admits, even if every() would be vacuously true.
  const requiredLen = Array.isArray(contract.requiredKeys) ? contract.requiredKeys.length : 0;
  if (requiredLen === 0) {
    deny("authority metric set is empty; refusing vacuous admission");
  } else if (liveCount === 0) {
    deny("admission receipt carries no live provider evidence (snapshot-asserted/test-only family never authorizes heavy work); refusing forged receipt");
  } else if (liveCount !== requiredLen) {
    deny("admission receipt live evidence does not exactly cover the required set; refusing forged receipt");
  }
  const monthly = receipt.windows?.monthly;
  if (monthly && (Date.parse(monthly.start) > now + contract.clockSkewMs || now > Date.parse(monthly.end))) {
    deny("admission receipt monthly window does not cover now; re-run the usage preflight before mutating");
  }
  const daily = receipt.windows?.daily;
  if (daily !== null && daily !== undefined &&
    (Date.parse(daily.start) > now + contract.clockSkewMs || now > Date.parse(daily.end))) {
    deny("admission receipt daily window does not cover now; re-run the usage preflight before mutating");
  }
  return reasons;
}
