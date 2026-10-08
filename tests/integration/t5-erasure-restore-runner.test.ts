import { describe, expect, it } from "vitest";
import { gateMayBeReportedAsPass } from "./gate-state.js";
import { redactSecretsText, sha256Hex } from "./redact.js";
import {
  T5_ERASURE_RESTORE_GATE_ID,
  runT5ErasureRestoreProbe,
  type ErasureRestoreResult,
  type T5ErasureDeps,
  type T5ErasureTrial,
} from "./t5-erasure-restore-runner.js";

const NOW_MS = Date.parse("2026-10-01T10:00:02.000Z") - 2_000;
const TRIAL_GENERATION = "testgen-2026-10-01-001";
const OWNED_KEY = `probe/${TRIAL_GENERATION}/${T5_ERASURE_RESTORE_GATE_ID}/source/001`;
const SOURCE_LABEL_DIGEST = sha256Hex("disposable-source-label-001");
const ABSENCE_PROOF = sha256Hex("absence-proof-001");
const ERASURE_REF = "erasure-testgen-2026-10-01-001-1";

// Obviously-fake secrets shaped like the real thing, so the redaction test
// would catch a leak rather than pass vacuously.
const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"; // privacy-allowlist: synthetic token fixture
const FAKE_EMAIL = "owner@example.com";
const FAKE_TOKEN_ASSIGN = "token=super-secret-value";

function baseTrial(overrides: Partial<T5ErasureTrial> = {}): T5ErasureTrial {
  return {
    gate_id: T5_ERASURE_RESTORE_GATE_ID,
    mode: "local",
    environment: "development",
    trial_generation: TRIAL_GENERATION,
    source_label_digest: SOURCE_LABEL_DIGEST,
    now_ms: NOW_MS,
    ...overrides,
  };
}

function countingDeps(overrides: Partial<T5ErasureDeps> = {}) {
  const calls = {
    ingest: 0,
    erase: 0,
    readback: 0,
    replay: 0,
    cleanup: 0,
    cleanupArgs: [] as readonly string[][],
    replayArgs: [] as { readonly key: string; readonly erasure_ref: string }[],
  };
  const absent = (): ErasureRestoreResult => ({ outcome: "absent", absence_proof_digest: ABSENCE_PROOF });
  const deps: T5ErasureDeps = {
    hasLiveCredentials: () => true,
    checkPrerequisites: () => ({ ok: true }),
    ingestDisposableSource: async () => {
      calls.ingest += 1;
      return { ingested: true };
    },
    eraseSource: async () => {
      calls.erase += 1;
      return { erased: true, erasure_ref: ERASURE_REF };
    },
    readbackErased: async () => {
      calls.readback += 1;
      return absent();
    },
    verifyPurgeReplay: async (args) => {
      calls.replay += 1;
      calls.replayArgs.push(args);
      return absent();
    },
    cleanupKeys: async (owned_keys) => {
      calls.cleanup += 1;
      calls.cleanupArgs.push(owned_keys);
      return { deleted: [...owned_keys] };
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("T5-erasure-restore probe runner", () => {
  it("reports NOT_EXECUTED without credentials and calls no dep at all", async () => {
    const { deps, calls } = countingDeps({ hasLiveCredentials: () => false });
    const output = await runT5ErasureRestoreProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("NOT_EXECUTED");
    expect(output.receipt.reason_codes).toContain("LIVE_CREDENTIALS_OR_BINDINGS_NOT_PRESENT");
    expect(output.receipt.cleanup_state).toBe("NOT_REQUIRED");
    expect(output.owned_keys).toEqual([]);
    expect(calls.ingest).toBe(0);
    expect(calls.erase).toBe(0);
    expect(calls.readback).toBe(0);
    expect(calls.replay).toBe(0);
    expect(calls.cleanup).toBe(0);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("reports BLOCKED for an unsatisfied prerequisite, distinct from FAIL", async () => {
    const { deps, calls } = countingDeps({
      checkPrerequisites: () => ({ ok: false, reason: "erasure authority unreachable" }),
    });
    const output = await runT5ErasureRestoreProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("BLOCKED");
    expect(output.receipt.state).not.toBe("FAIL");
    expect(calls.ingest).toBe(0);
    expect(calls.erase).toBe(0);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("reports BLOCKED for a malformed trial generation before any effect", async () => {
    const { deps, calls } = countingDeps();
    const output = await runT5ErasureRestoreProbe(baseTrial({ trial_generation: "../*broad*" }), deps);
    expect(output.receipt.state).toBe("BLOCKED");
    expect(output.receipt.reason_codes).toContain("INVALID_TRIAL_GENERATION");
    expect(output.owned_keys).toEqual([]);
    expect(calls.ingest).toBe(0);
    expect(calls.cleanup).toBe(0);
  });

  it("reports BLOCKED for a non-digest source label before any effect", async () => {
    const { deps, calls } = countingDeps();
    const output = await runT5ErasureRestoreProbe(baseTrial({ source_label_digest: "not-a-digest" }), deps);
    expect(output.receipt.state).toBe("BLOCKED");
    expect(output.receipt.reason_codes).toContain("INVALID_SOURCE_LABEL_DIGEST");
    expect(calls.ingest).toBe(0);
    expect(calls.cleanup).toBe(0);
  });

  it("reports BLOCKED when a live trial declares a non-live environment", async () => {
    const { deps, calls } = countingDeps();
    const output = await runT5ErasureRestoreProbe(
      baseTrial({ mode: "live", environment: "development" }),
      deps,
    );
    expect(output.receipt.state).toBe("BLOCKED");
    expect(output.receipt.reason_codes).toContain("LIVE_ENVIRONMENT_MISMATCH");
    expect(calls.ingest).toBe(0);
  });

  it("reports FAIL when the erased source reads back present: the core T5-A assertion", async () => {
    const { deps, calls } = countingDeps({
      readbackErased: async () => {
        calls.readback += 1;
        return { outcome: "present", detail: "bytes still readable at R2 key" };
      },
    });
    const output = await runT5ErasureRestoreProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.receipt.reason_codes).toContain("ERASURE_READBACK_NOT_ABSENT");
    expect(output.receipt.cleanup_state).toBe("COMPLETE");
    // Erasure was performed before the failed readback; replay never ran.
    expect(calls.ingest).toBe(1);
    expect(calls.erase).toBe(1);
    expect(calls.readback).toBe(1);
    expect(calls.replay).toBe(0);
    expect(calls.cleanupArgs).toEqual([[OWNED_KEY]]);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("reports FAIL when the purge-ledger replay finds content present after rebuild", async () => {
    const { deps, calls } = countingDeps({
      verifyPurgeReplay: async (args) => {
        calls.replay += 1;
        calls.replayArgs.push(args);
        return { outcome: "present", detail: "projection rebuilt with content" };
      },
    });
    const output = await runT5ErasureRestoreProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.receipt.reason_codes).toContain("PURGE_REPLAY_CONTENT_PRESENT");
    expect(calls.readback).toBe(1);
    expect(calls.replay).toBe(1);
    // The replay is bound to the exact erasure closure of this probe run.
    expect(calls.replayArgs).toEqual([{ key: OWNED_KEY, erasure_ref: ERASURE_REF }]);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("reports FAIL when ingest is not confirmed, before erase runs", async () => {
    const { deps, calls } = countingDeps({
      ingestDisposableSource: async () => {
        calls.ingest += 1;
        return { ingested: false };
      },
    });
    const output = await runT5ErasureRestoreProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.receipt.reason_codes).toContain("PROBE_ASSERTION_MISMATCH");
    expect(calls.ingest).toBe(1);
    expect(calls.erase).toBe(0);
    expect(calls.readback).toBe(0);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("reports FAIL when erase is not confirmed, before readback runs", async () => {
    const { deps, calls } = countingDeps({
      eraseSource: async () => {
        calls.erase += 1;
        return { erased: false, erasure_ref: "" };
      },
    });
    const output = await runT5ErasureRestoreProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.receipt.reason_codes).toContain("PROBE_ASSERTION_MISMATCH");
    expect(calls.ingest).toBe(1);
    expect(calls.erase).toBe(1);
    expect(calls.readback).toBe(0);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("leaves an unknown readback unresolved with exactly one attempt per step and no retry", async () => {
    const { deps, calls } = countingDeps({
      readbackErased: async () => {
        calls.readback += 1;
        return { outcome: "unknown", detail: "response lost after purge" };
      },
    });
    const output = await runT5ErasureRestoreProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("RUNNING");
    expect(output.receipt.reason_codes).toContain("SETTLEMENT_UNCERTAIN");
    expect(calls.ingest).toBe(1);
    expect(calls.erase).toBe(1);
    expect(calls.readback).toBe(1);
    expect(calls.replay).toBe(0);
    expect(output.owned_keys).toEqual([OWNED_KEY]);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("treats a thrown timeout during erase as uncertain, not as failure, with no second intent", async () => {
    const { deps, calls } = countingDeps({
      eraseSource: async () => {
        calls.erase += 1;
        throw Object.assign(new Error("erasure call timed out"), { name: "TimeoutError" });
      },
    });
    const output = await runT5ErasureRestoreProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("RUNNING");
    expect(output.receipt.reason_codes).toContain("SETTLEMENT_UNCERTAIN");
    expect(calls.erase).toBe(1);
    expect(calls.readback).toBe(0);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("treats a thrown transport error as FAIL, not uncertainty", async () => {
    const { deps, calls } = countingDeps({
      verifyPurgeReplay: async () => {
        calls.replay += 1;
        throw new Error("ledger D1 unavailable");
      },
    });
    const output = await runT5ErasureRestoreProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.receipt.reason_codes).toContain("PROBE_TRANSPORT_ERROR");
    expect(calls.replay).toBe(1);
    expect(output.receipt.cleanup_state).toBe("COMPLETE");
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("accepts an attested live trial through the predicate (fake-live, no account, no network)", async () => {
    const { deps, calls } = countingDeps();
    const trial = baseTrial({
      mode: "live",
      environment: "staging",
      worker_generation: "worker-build-abcdef1234",
      data_generation: "erasure-data-gen-2026-10-01-001",
    });
    const output = await runT5ErasureRestoreProbe(trial, deps);
    expect(output.receipt.state).toBe("PASS");
    expect(output.receipt.reason_codes).toEqual([]);
    expect(output.receipt.cleanup_state).toBe("COMPLETE");
    expect(output.receipt.test_id).toBe(T5_ERASURE_RESTORE_GATE_ID);
    expect(output.receipt.input_digest).toBe(SOURCE_LABEL_DIGEST);
    expect(output.receipt.redacted_receipt_ref).toBe(`sha256:${ABSENCE_PROOF}`);
    expect(output.owned_keys).toEqual([OWNED_KEY]);
    expect(calls.cleanupArgs).toEqual([[OWNED_KEY]]);
    expect(calls.ingest).toBe(1);
    expect(calls.erase).toBe(1);
    expect(calls.readback).toBe(1);
    expect(calls.replay).toBe(1);
    expect(gateMayBeReportedAsPass(output.receipt, { nowMs: NOW_MS + 2_000 })).toBe(true);
  });

  it("keeps a local success structurally green-proof: the predicate still refuses PASS", async () => {
    const { deps } = countingDeps();
    const output = await runT5ErasureRestoreProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("PASS");
    expect(gateMayBeReportedAsPass(output.receipt, { nowMs: NOW_MS + 2_000 })).toBe(false);
  });

  it("downgrades local trials even when attestation is supplied", async () => {
    const { deps } = countingDeps();
    const output = await runT5ErasureRestoreProbe(
      baseTrial({ worker_generation: "worker-build-x", data_generation: "erasure-data-gen-x" }),
      deps,
    );
    expect(output.receipt.worker_generation).toBeNull();
    expect(output.receipt.data_generation).toBeNull();
    expect(output.receipt.generation_ref).toBeNull();
    expect(gateMayBeReportedAsPass(output.receipt, { nowMs: NOW_MS + 2_000 })).toBe(false);
  });

  it("rejects a malformed absence proof instead of pinning it", async () => {
    const { deps, calls } = countingDeps({
      readbackErased: async () => {
        calls.readback += 1;
        return { outcome: "absent", absence_proof_digest: "not-a-digest" };
      },
    });
    const output = await runT5ErasureRestoreProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.receipt.reason_codes).toContain("PROBE_ASSERTION_MISMATCH");
    expect(output.receipt.redacted_receipt_ref).toBeNull();
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("redacts secrets and never emits raw labels, prompts, or source text", async () => {
    const { deps, calls } = countingDeps({
      readbackErased: async () => {
        calls.readback += 1;
        return { outcome: "present", detail: `saw ${FAKE_JWT} for ${FAKE_EMAIL} ${FAKE_TOKEN_ASSIGN}` };
      },
    });
    const output = await runT5ErasureRestoreProbe(baseTrial(), deps);
    const dumped = JSON.stringify(output);
    // Secret-shaped material is redacted; the raw source label is never in the
    // runner's input at all (only its digest), so it cannot leak.
    for (const secret of [FAKE_JWT, FAKE_EMAIL, "super-secret-value", "disposable-source-label-001"]) {
      expect(dumped).not.toContain(secret);
    }
    expect(dumped).toContain("[REDACTED_");
    // The source is pinned by digest only.
    expect(output.receipt.input_digest).toBe(SOURCE_LABEL_DIGEST);
    expect(redactSecretsText(`a ${FAKE_TOKEN_ASSIGN} b`)).toContain("[REDACTED_CREDENTIAL]");
  });

  it("names only the owned key for cleanup and records FAILED cleanup honestly", async () => {
    const { deps, calls } = countingDeps({
      cleanupKeys: async () => {
        calls.cleanup += 1;
        throw new Error("delete unavailable");
      },
    });
    const trial = baseTrial({
      mode: "live",
      environment: "staging",
      worker_generation: "worker-build-abcdef1234",
      data_generation: "erasure-data-gen-2026-10-01-001",
    });
    const output = await runT5ErasureRestoreProbe(trial, deps);
    expect(output.owned_keys).toEqual([OWNED_KEY]);
    for (const arg of calls.cleanupArgs) {
      expect(arg).toEqual([OWNED_KEY]);
      for (const key of arg) expect(key).not.toContain("*");
    }
    expect(output.receipt.cleanup_state).toBe("FAILED");
    expect(gateMayBeReportedAsPass(output.receipt, { nowMs: NOW_MS + 2_000 })).toBe(false);
  });
});
