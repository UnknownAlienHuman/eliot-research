import { describe, expect, it } from "vitest";
import { gateMayBeReportedAsPass } from "./gate-state.js";
import {
  DISCLOSURE_AUDIT_GATE_ID,
  redactSecretsText,
  runDisclosureAuditProbe,
  sha256Hex,
  type DisclosureAuditDeps,
  type DisclosureAuditTrial,
  type EvidenceRead,
  type SharedFixtureRead,
} from "./t5-disclosure-audit-runner.js";

const NOW_MS = Date.parse("2026-10-01T15:00:00.000Z") - 2_000;
const TRIAL_GENERATION = "testgen-2026-10-01-001";
const OWNED_KEYS = [
  `probe/${TRIAL_GENERATION}/${DISCLOSURE_AUDIT_GATE_ID}/fixture/client-a/001`,
  `probe/${TRIAL_GENERATION}/${DISCLOSURE_AUDIT_GATE_ID}/fixture/client-b/001`,
  `probe/${TRIAL_GENERATION}/${DISCLOSURE_AUDIT_GATE_ID}/evidence/client-a/001`,
] as const;

function baseTrial(overrides: Partial<DisclosureAuditTrial> = {}): DisclosureAuditTrial {
  return {
    gate_id: DISCLOSURE_AUDIT_GATE_ID,
    mode: "local",
    environment: "development",
    trial_generation: TRIAL_GENERATION,
    now_ms: NOW_MS,
    ...overrides,
  };
}

interface FixtureEntry {
  client_id: string;
  canary: string;
  excerpt_digest: string;
}

// Correct-behavior policy doubles: an in-memory fixture store with strict
// per-client scoping, a redactor that marks every sensitive shape, and an
// attribution step that preserves the source-task reference.
function policyDeps(overrides: Partial<DisclosureAuditDeps> = {}) {
  const calls = {
    plant: 0,
    redact: 0,
    readShared: 0,
    attribute: 0,
    readEvidence: 0,
    cleanup: 0,
    cleanupArgs: [] as readonly string[][],
  };
  const receivedCanaries: string[] = [];
  const receivedTexts: string[] = [];
  const store = new Map<string, FixtureEntry>();
  const deps: DisclosureAuditDeps = {
    hasLiveCredentials: () => true,
    checkPrerequisites: () => ({ ok: true }),
    plantFixture: async ({ key, client_id, canary }) => {
      calls.plant += 1;
      receivedCanaries.push(canary);
      const excerpt_digest = sha256Hex(`excerpt:${key}:${canary}`);
      store.set(key, { client_id, canary, excerpt_digest });
      return { excerpt_digest };
    },
    redactForDisclosure: async ({ text }) => {
      calls.redact += 1;
      receivedTexts.push(text);
      return { redacted_text: redactSecretsText(text) };
    },
    readSharedFixture: async ({ client_id, fixture_key }): Promise<SharedFixtureRead> => {
      calls.readShared += 1;
      const entry = store.get(fixture_key);
      if (!entry) return { outcome: "denied", reason: "unknown fixture" };
      if (entry.client_id !== client_id) {
        return { outcome: "denied", reason: `fixture scoped to ${entry.client_id}` };
      }
      return {
        outcome: "visible",
        excerpt_digest: entry.excerpt_digest,
        attributed_client_id: entry.client_id,
      };
    },
    attributeAfterRedaction: async ({ text, source_task_ref }) => {
      calls.attribute += 1;
      receivedTexts.push(text);
      return { redacted_text: redactSecretsText(text), source_task_ref };
    },
    readEvidence: async ({ client_id, evidence_key }): Promise<EvidenceRead> => {
      calls.readEvidence += 1;
      const entry = store.get(evidence_key);
      if (!entry) return { outcome: "denied", reason: "unknown evidence" };
      if (entry.client_id !== client_id) return { outcome: "denied", reason: "client not authorized" };
      return { outcome: "allowed", excerpt_digest: entry.excerpt_digest };
    },
    cleanupKeys: async (owned_keys) => {
      calls.cleanup += 1;
      calls.cleanupArgs.push([...owned_keys]);
      return { deleted: [...owned_keys] };
    },
    ...overrides,
  };
  return { deps, calls, receivedCanaries, receivedTexts, store };
}

describe("T5-disclosure-audit probe runner", () => {
  it("reports NOT_EXECUTED without credentials and performs no dep effect", async () => {
    const { deps, calls } = policyDeps({ hasLiveCredentials: () => false });
    const output = await runDisclosureAuditProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("NOT_EXECUTED");
    expect(output.receipt.reason_codes).toContain("LIVE_CREDENTIALS_OR_BINDINGS_NOT_PRESENT");
    expect(output.receipt.cleanup_state).toBe("NOT_REQUIRED");
    expect(calls.plant).toBe(0);
    expect(calls.cleanup).toBe(0);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("reports BLOCKED for a malformed trial generation before any effect", async () => {
    const { deps, calls } = policyDeps();
    const output = await runDisclosureAuditProbe(baseTrial({ trial_generation: "../*broad*" }), deps);
    expect(output.receipt.state).toBe("BLOCKED");
    expect(output.receipt.reason_codes).toContain("INVALID_TRIAL_GENERATION");
    expect(calls.plant).toBe(0);
    expect(calls.cleanup).toBe(0);
  });

  it("reports BLOCKED when a live trial declares a non-live environment", async () => {
    const { deps, calls } = policyDeps();
    const output = await runDisclosureAuditProbe(baseTrial({ mode: "live", environment: "development" }), deps);
    expect(output.receipt.state).toBe("BLOCKED");
    expect(output.receipt.reason_codes).toContain("LIVE_ENVIRONMENT_MISMATCH");
    expect(calls.plant).toBe(0);
    expect(calls.cleanup).toBe(0);
  });

  it("reports BLOCKED for an unsatisfied prerequisite, distinct from FAIL", async () => {
    const { deps, calls } = policyDeps({
      checkPrerequisites: () => ({ ok: false, reason: "disclosure policy document unavailable" }),
    });
    const output = await runDisclosureAuditProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("BLOCKED");
    expect(output.receipt.state).not.toBe("FAIL");
    expect(calls.plant).toBe(0);
    expect(calls.cleanup).toBe(0);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("reports PASS when all four policy dimensions hold, with exact-key cleanup", async () => {
    const { deps, calls } = policyDeps();
    const output = await runDisclosureAuditProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("PASS");
    expect(output.receipt.reason_codes).toEqual([]);
    expect(output.owned_keys).toEqual([...OWNED_KEYS]);
    expect(calls.cleanupArgs).toEqual([[ ...OWNED_KEYS ]]);
    expect(output.receipt.cleanup_state).toBe("COMPLETE");
    expect(output.receipt.redacted_receipt_ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(output.receipt.input_digest).toMatch(/^[0-9a-f]{64}$/);
    // Local trials are structurally green-proof.
    expect(gateMayBeReportedAsPass(output.receipt, { nowMs: NOW_MS + 2_000 })).toBe(false);
  });

  it("accepts an attested live trial through the predicate (fake-live, no account, no network)", async () => {
    const { deps } = policyDeps();
    const output = await runDisclosureAuditProbe(
      baseTrial({
        mode: "live",
        environment: "staging",
        worker_generation: "worker-build-abcdef1234",
        data_generation: "t5-data-gen-2026-10-01-001",
      }),
      deps,
    );
    expect(output.receipt.state).toBe("PASS");
    expect(gateMayBeReportedAsPass(output.receipt, { nowMs: NOW_MS + 2_000 })).toBe(true);
  });

  it("downgrades local trials even when attestation is supplied", async () => {
    const { deps } = policyDeps();
    const output = await runDisclosureAuditProbe(
      baseTrial({ worker_generation: "worker-build-x", data_generation: "t5-data-gen-x" }),
      deps,
    );
    expect(output.receipt.state).toBe("PASS");
    expect(output.receipt.worker_generation).toBeNull();
    expect(output.receipt.data_generation).toBeNull();
    expect(gateMayBeReportedAsPass(output.receipt, { nowMs: NOW_MS + 2_000 })).toBe(false);
  });

  it("fails closed when the redactor echoes sensitive values (dimension a)", async () => {
    const { deps } = policyDeps({
      redactForDisclosure: async ({ text }) => ({ redacted_text: text }),
    });
    const output = await runDisclosureAuditProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.receipt.reason_codes).toContain("DISCLOSURE_REDACTION_LEAK");
    expect(output.receipt.cleanup_state).toBe("COMPLETE");
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("fails closed when the redactor strips secrets without markers (dimension a)", async () => {
    const { deps } = policyDeps({
      redactForDisclosure: async ({ text }) => ({
        redacted_text: redactSecretsText(text).replaceAll(/\[REDACTED_[A-Z]+\]/g, "***"),
      }),
    });
    const output = await runDisclosureAuditProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.receipt.reason_codes).toContain("DISCLOSURE_REDACTION_LEAK");
  });

  it("fails closed on a visible cross-client fixture read (dimension b)", async () => {
    const built = policyDeps();
    const leaky: DisclosureAuditDeps = {
      ...built.deps,
      readSharedFixture: async ({ fixture_key }): Promise<SharedFixtureRead> => {
        const entry = built.store.get(fixture_key);
        if (!entry) return { outcome: "denied", reason: "unknown fixture" };
        // Leaky policy: every read is visible regardless of client scoping.
        return {
          outcome: "visible",
          excerpt_digest: entry.excerpt_digest,
          attributed_client_id: entry.client_id,
        };
      },
    };
    const output = await runDisclosureAuditProbe(baseTrial(), leaky);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.receipt.reason_codes).toContain("INFERENCE_BOUNDARY_LEAK");
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("fails closed when an own fixture read is misattributed (dimension b)", async () => {
    const built = policyDeps();
    const leaky: DisclosureAuditDeps = {
      ...built.deps,
      readSharedFixture: async ({ client_id, fixture_key }): Promise<SharedFixtureRead> => {
        const entry = built.store.get(fixture_key);
        if (!entry || entry.client_id !== client_id) return { outcome: "denied", reason: "scoped" };
        return {
          outcome: "visible",
          excerpt_digest: entry.excerpt_digest,
          attributed_client_id: client_id === "client-a" ? "client-b" : "client-a",
        };
      },
    };
    const output = await runDisclosureAuditProbe(baseTrial(), leaky);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.receipt.reason_codes).toContain("INFERENCE_BOUNDARY_LEAK");
  });

  it("scrubs raw canaries echoed in denial reasons and still fails the boundary (dimension b)", async () => {
    const built = policyDeps();
    const leaky: DisclosureAuditDeps = {
      ...built.deps,
      readSharedFixture: async ({ client_id, fixture_key }): Promise<SharedFixtureRead> => {
        const entry = built.store.get(fixture_key);
        if (!entry || entry.client_id !== client_id) {
          return { outcome: "denied", reason: `nope, contains ${entry?.canary ?? "?"}` };
        }
        return {
          outcome: "visible",
          excerpt_digest: entry.excerpt_digest,
          attributed_client_id: entry.client_id,
        };
      },
    };
    const output = await runDisclosureAuditProbe(baseTrial(), leaky);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.receipt.reason_codes).toContain("INFERENCE_BOUNDARY_LEAK");
    const dumped = JSON.stringify(output);
    for (const raw of built.receivedCanaries) {
      expect(dumped).not.toContain(raw);
    }
    expect(dumped).toContain("[REDACTED_CANARY]");
  });

  it("fails closed when source-task attribution is altered through redaction (dimension c)", async () => {
    const { deps } = policyDeps({
      attributeAfterRedaction: async ({ text }) => ({
        redacted_text: redactSecretsText(text),
        source_task_ref: "task:tampered",
      }),
    });
    const output = await runDisclosureAuditProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.receipt.reason_codes).toContain("ATTRIBUTION_LOST");
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("fails closed when a stranger is granted evidence access (dimension d)", async () => {
    const built = policyDeps();
    const leaky: DisclosureAuditDeps = {
      ...built.deps,
      readEvidence: async ({ evidence_key }): Promise<EvidenceRead> => {
        const entry = built.store.get(evidence_key);
        if (!entry) return { outcome: "denied", reason: "unknown evidence" };
        // Leaky policy: no per-client check.
        return { outcome: "allowed", excerpt_digest: entry.excerpt_digest };
      },
    };
    const output = await runDisclosureAuditProbe(baseTrial(), leaky);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.receipt.reason_codes).toContain("CLIENT_POLICY_GRANT_VIOLATION");
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("fails closed when the owning client is denied evidence access (dimension d)", async () => {
    const { deps } = policyDeps({
      readEvidence: async () => ({ outcome: "denied", reason: "deny by default" }),
    });
    const output = await runDisclosureAuditProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.receipt.reason_codes).toContain("CLIENT_POLICY_OWNER_DENIED");
  });

  it("emits no raw synthetic fixture bytes anywhere in the output", async () => {
    const { deps, receivedCanaries, receivedTexts } = policyDeps();
    const output = await runDisclosureAuditProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("PASS");
    expect(receivedCanaries.length).toBeGreaterThan(0);
    expect(receivedTexts.length).toBeGreaterThan(0);
    const dumped = JSON.stringify(output);
    for (const raw of [...receivedCanaries, ...receivedTexts]) {
      expect(dumped).not.toContain(raw);
    }
  });

  it("names only the owned keys for cleanup and records FAILED cleanup honestly", async () => {
    const { deps, calls } = policyDeps({
      cleanupKeys: async (owned_keys) => {
        calls.cleanup += 1;
        calls.cleanupArgs.push([...owned_keys]);
        return { deleted: [] };
      },
    });
    const output = await runDisclosureAuditProbe(baseTrial(), deps);
    expect(output.owned_keys).toEqual([...OWNED_KEYS]);
    expect(calls.cleanupArgs).toEqual([[ ...OWNED_KEYS ]]);
    for (const arg of calls.cleanupArgs) {
      for (const key of arg) expect(key).not.toContain("*");
    }
    expect(output.receipt.cleanup_state).toBe("FAILED");
    expect(gateMayBeReportedAsPass(output.receipt, { nowMs: NOW_MS + 2_000 })).toBe(false);
  });

  it("leaves an uncertain policy check unresolved with no retry", async () => {
    const { deps, calls } = policyDeps();
    const uncertain: DisclosureAuditDeps = {
      ...deps,
      readEvidence: async () => {
        calls.readEvidence += 1;
        throw Object.assign(new Error("evidence read timed out"), { name: "TimeoutError" });
      },
    };
    const output = await runDisclosureAuditProbe(baseTrial(), uncertain);
    expect(output.receipt.state).toBe("RUNNING");
    expect(output.receipt.reason_codes).toContain("SETTLEMENT_UNCERTAIN");
    expect(calls.readEvidence).toBe(1);
    expect(calls.cleanup).toBe(1);
    expect(output.owned_keys).toEqual([...OWNED_KEYS]);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("reports FAIL on a non-timeout transport error after cleanup", async () => {
    const { deps, calls } = policyDeps({
      plantFixture: async () => {
        throw new Error("D1 unavailable");
      },
    });
    const output = await runDisclosureAuditProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.receipt.reason_codes).toContain("PROBE_TRANSPORT_ERROR");
    expect(calls.cleanup).toBe(1);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });
});
