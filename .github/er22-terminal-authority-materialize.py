from pathlib import Path

helper = '''import type {
  CompletionDisposition,
  FederationJobStatus,
} from "@eliotr/contracts";

export interface FederationTerminalAuthorityInput {
  readonly status: FederationJobStatus;
  readonly observed_completion_disposition: CompletionDisposition | null;
  readonly result_present: boolean;
}

export type FederationTerminalAuthorityResult =
  | {
      readonly accepted: true;
      readonly effective_disposition: CompletionDisposition | null;
    }
  | {
      readonly accepted: false;
      readonly message: string;
    };

function reject(message: string): FederationTerminalAuthorityResult {
  return { accepted: false, message };
}

function accept(
  effectiveDisposition: CompletionDisposition | null,
): FederationTerminalAuthorityResult {
  return {
    accepted: true,
    effective_disposition: effectiveDisposition,
  };
}

export function evaluateFederationTerminalAuthority(
  input: FederationTerminalAuthorityInput,
): FederationTerminalAuthorityResult {
  const { status } = input;
  const observed = input.observed_completion_disposition;
  const active =
    status.transport_state === "ACCEPTED" ||
    status.transport_state === "RUNNING" ||
    status.transport_state === "PARTIAL" ||
    status.transport_state === "BLOCKED";
  const hasResearchOutcome =
    observed !== null ||
    status.completion_disposition !== null ||
    input.result_present;
  const hasCancellationReceipt =
    status.cancellation_receipt_ref !== undefined;
  const hasTerminalReceipt = status.terminal_receipt_ref !== undefined;

  if (active) {
    if (hasResearchOutcome) {
      return reject(
        "non-completed transport exposed a terminal research outcome",
      );
    }
    if (hasCancellationReceipt || hasTerminalReceipt) {
      return reject("active transport exposed terminal authority");
    }
    return accept(null);
  }

  if (status.transport_state === "FAILED") {
    if (hasResearchOutcome) {
      return reject(
        "non-completed transport exposed a terminal research outcome",
      );
    }
    if (hasCancellationReceipt) {
      return reject("failed transport exposed cancellation authority");
    }
    if (!hasTerminalReceipt) {
      return reject("failed transport lacks a terminal receipt");
    }
    return accept(null);
  }

  if (status.transport_state === "CANCELLED") {
    if (
      observed !== "CANCELLED" ||
      status.completion_disposition !== "CANCELLED"
    ) {
      return reject("cancelled transport lacks exact cancellation disposition");
    }
    if (input.result_present) {
      return reject("cancelled transport exposed a result");
    }
    if (
      !hasCancellationReceipt ||
      !hasTerminalReceipt ||
      status.cancellation_receipt_ref !== status.terminal_receipt_ref
    ) {
      return reject(
        "cancelled transport lacks one exact cancellation terminal receipt",
      );
    }
    return accept("CANCELLED");
  }

  if (observed === null) {
    return reject("completed transport lacks an observed research disposition");
  }
  if (hasCancellationReceipt) {
    return reject("completed transport exposed cancellation authority");
  }
  if (!hasTerminalReceipt) {
    return reject("completed transport lacks a terminal receipt");
  }
  return accept(
    status.completion_disposition !== null &&
      status.completion_disposition !== observed
      ? "INCONCLUSIVE"
      : observed,
  );
}
'''
Path("apps/eliotr-core/src/federation-terminal-authority.ts").write_text(
    helper,
    encoding="utf-8",
)

helper_test = '''import type {
  CompletionDisposition,
  FederationJobStatus,
} from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import {
  evaluateFederationTerminalAuthority,
  type FederationTerminalAuthorityResult,
} from "./federation-terminal-authority.js";

const ACTIVE_STATES = [
  "ACCEPTED",
  "RUNNING",
  "PARTIAL",
  "BLOCKED",
] as const;

function status(
  transportState: FederationJobStatus["transport_state"],
  overrides: Partial<FederationJobStatus> = {},
): FederationJobStatus {
  return {
    exchange_id: "exchange-1",
    idempotency_key: "idempotency-1",
    job_id: "job-1",
    attempt: 1,
    transport_state: transportState,
    completion_disposition: null,
    completed_obligation_refs: [],
    partial_bundle_refs: [],
    open_research_debt_refs: [],
    ...overrides,
  };
}

function evaluate(
  value: FederationJobStatus,
  observed: CompletionDisposition | null = null,
  resultPresent = false,
): FederationTerminalAuthorityResult {
  return evaluateFederationTerminalAuthority({
    status: value,
    observed_completion_disposition: observed,
    result_present: resultPresent,
  });
}

function rejected(value: FederationTerminalAuthorityResult): void {
  expect(value).toMatchObject({ accepted: false });
}

describe("ER-22 federation terminal authority", () => {
  it.each(ACTIVE_STATES)(
    "admits clean %s transport without terminal authority",
    (state) => {
      expect(evaluate(status(state))).toEqual({
        accepted: true,
        effective_disposition: null,
      });
    },
  );

  it.each(ACTIVE_STATES)(
    "rejects outcomes and receipt authority on active %s transport",
    (state) => {
      rejected(evaluate(status(state, {
        terminal_receipt_ref: "terminal-receipt-1",
      })));
      rejected(evaluate(status(state, {
        cancellation_receipt_ref: "cancellation-receipt-1",
      })));
      rejected(evaluate(status(state, {
        completion_disposition: "INCONCLUSIVE",
      })));
      rejected(evaluate(status(state), "INCONCLUSIVE"));
      rejected(evaluate(status(state), null, true));
    },
  );

  it("requires FAILED to carry only a durable terminal receipt", () => {
    expect(evaluate(status("FAILED", {
      terminal_receipt_ref: "terminal-failed-1",
    }))).toEqual({
      accepted: true,
      effective_disposition: null,
    });
    rejected(evaluate(status("FAILED")));
    rejected(evaluate(status("FAILED", {
      terminal_receipt_ref: "terminal-failed-1",
      cancellation_receipt_ref: "cancellation-receipt-1",
    })));
    rejected(evaluate(status("FAILED", {
      terminal_receipt_ref: "terminal-failed-1",
      completion_disposition: "INCONCLUSIVE",
    })));
    rejected(evaluate(status("FAILED", {
      terminal_receipt_ref: "terminal-failed-1",
    }), "INCONCLUSIVE"));
    rejected(evaluate(status("FAILED", {
      terminal_receipt_ref: "terminal-failed-1",
    }), null, true));
  });

  it("requires COMPLETED to carry an observation and terminal receipt", () => {
    expect(evaluate(status("COMPLETED", {
      completion_disposition: "ANSWERED_WITH_SUPPORTED_RESULT",
      terminal_receipt_ref: "terminal-completed-1",
    }), "INCONCLUSIVE")).toEqual({
      accepted: true,
      effective_disposition: "INCONCLUSIVE",
    });
    expect(evaluate(status("COMPLETED", {
      terminal_receipt_ref: "terminal-completed-1",
    }), "NO_NEW_USEFUL_EVIDENCE")).toEqual({
      accepted: true,
      effective_disposition: "NO_NEW_USEFUL_EVIDENCE",
    });
    rejected(evaluate(status("COMPLETED", {
      terminal_receipt_ref: "terminal-completed-1",
    })));
    rejected(evaluate(status("COMPLETED"), "INCONCLUSIVE"));
    rejected(evaluate(status("COMPLETED", {
      terminal_receipt_ref: "terminal-completed-1",
      cancellation_receipt_ref: "cancellation-receipt-1",
    }), "INCONCLUSIVE"));
  });

  it("admits CANCELLED only with exact dispositions and one receipt identity", () => {
    const valid = status("CANCELLED", {
      completion_disposition: "CANCELLED",
      cancellation_receipt_ref: "cancellation-receipt-1",
      terminal_receipt_ref: "cancellation-receipt-1",
    });
    expect(evaluate(valid, "CANCELLED")).toEqual({
      accepted: true,
      effective_disposition: "CANCELLED",
    });

    rejected(evaluate(status("CANCELLED")));
    rejected(evaluate(status("CANCELLED", {
      completion_disposition: "CANCELLED",
      terminal_receipt_ref: "cancellation-receipt-1",
    }), "CANCELLED"));
    rejected(evaluate(status("CANCELLED", {
      completion_disposition: "CANCELLED",
      cancellation_receipt_ref: "cancellation-receipt-1",
    }), "CANCELLED"));
    rejected(evaluate(status("CANCELLED", {
      completion_disposition: "CANCELLED",
      cancellation_receipt_ref: "cancellation-receipt-1",
      terminal_receipt_ref: "another-receipt",
    }), "CANCELLED"));
    rejected(evaluate(status("CANCELLED", {
      cancellation_receipt_ref: "cancellation-receipt-1",
      terminal_receipt_ref: "cancellation-receipt-1",
    }), "CANCELLED"));
    rejected(evaluate(valid, null));
    rejected(evaluate(valid, "CANCELLED", true));
  });
});
'''
Path("apps/eliotr-core/src/federation-terminal-authority.test.ts").write_text(
    helper_test,
    encoding="utf-8",
)

service_path = Path("apps/eliotr-core/src/federation-service.ts")
service = service_path.read_text(encoding="utf-8")
import_anchor = 'import { federationRequestAuthorityRefs } from "./federation-request-authorities.js";\n'
import_line = 'import { evaluateFederationTerminalAuthority } from "./federation-terminal-authority.js";\n'
if service.count(import_anchor) != 1 or import_line in service:
    raise SystemExit("terminal-authority import anchor missing or already applied")
service = service.replace(import_anchor, import_anchor + import_line)
old_block = '''  const active = status.transport_state === "ACCEPTED" || status.transport_state === "RUNNING" ||
    status.transport_state === "PARTIAL" || status.transport_state === "BLOCKED";
  const hasTerminalOutcome = observedDisposition !== null ||
    status.completion_disposition !== null || record.result !== null;
  if ((active || status.transport_state === "FAILED") && hasTerminalOutcome) {
    fail("FEDERATION_AUTHORITY_INVALID", "non-completed transport exposed a terminal research outcome");
  }
  if (status.transport_state === "COMPLETED" && observedDisposition === null) {
    fail("FEDERATION_AUTHORITY_INVALID", "completed transport lacks an observed research disposition");
  }
  if (status.transport_state === "CANCELLED" &&
      ((observedDisposition !== null && observedDisposition !== "CANCELLED") ||
       (status.completion_disposition !== null && status.completion_disposition !== "CANCELLED") ||
       record.result !== null)) {
    fail("FEDERATION_AUTHORITY_INVALID", "cancelled transport exposed a non-cancelled outcome");
  }
  const effectiveDisposition = status.transport_state === "CANCELLED"
    ? "CANCELLED"
    : status.transport_state === "COMPLETED" && status.completion_disposition !== null &&
        status.completion_disposition !== observedDisposition
      ? "INCONCLUSIVE"
      : observedDisposition;'''
new_block = '''  const terminalAuthority = evaluateFederationTerminalAuthority({
    status,
    observed_completion_disposition: observedDisposition,
    result_present: record.result !== null,
  });
  if (!terminalAuthority.accepted) {
    fail("FEDERATION_AUTHORITY_INVALID", terminalAuthority.message);
  }
  const effectiveDisposition = terminalAuthority.effective_disposition;'''
if service.count(old_block) != 1:
    raise SystemExit("terminal-authority service anchor missing or ambiguous")
service_path.write_text(service.replace(old_block, new_block), encoding="utf-8")

test_path = Path("apps/eliotr-core/src/federation-service.test.ts")
test = test_path.read_text(encoding="utf-8")
old_status = '''function status(
  transportState: FederationJobStatus["transport_state"] = "COMPLETED",
  disposition: CompletionDisposition | null = "ANSWERED_WITH_SUPPORTED_RESULT",
): FederationJobStatus {
  return {
    exchange_id: "exchange-1",
    idempotency_key: "idempotency-1",
    job_id: "job-1",
    attempt: 1,
    transport_state: transportState,
    completion_disposition: disposition,
    completed_obligation_refs: [],
    partial_bundle_refs: [],
    open_research_debt_refs: [],
    terminal_receipt_ref: "terminal-receipt-1",
  };
}'''
new_status = '''function status(
  transportState: FederationJobStatus["transport_state"] = "COMPLETED",
  disposition: CompletionDisposition | null = "ANSWERED_WITH_SUPPORTED_RESULT",
): FederationJobStatus {
  const cancelled = transportState === "CANCELLED";
  const terminal = cancelled || transportState === "COMPLETED" ||
    transportState === "FAILED";
  return {
    exchange_id: "exchange-1",
    idempotency_key: "idempotency-1",
    job_id: "job-1",
    attempt: 1,
    transport_state: transportState,
    completion_disposition: disposition,
    completed_obligation_refs: [],
    partial_bundle_refs: [],
    open_research_debt_refs: [],
    ...(cancelled ? { cancellation_receipt_ref: "cancellation-receipt-1" } : {}),
    ...(terminal ? {
      terminal_receipt_ref: cancelled
        ? "cancellation-receipt-1"
        : "terminal-receipt-1",
    } : {}),
  };
}'''
if test.count(old_status) != 1:
    raise SystemExit("service-test status helper anchor missing or ambiguous")
test = test.replace(old_status, new_status)
old_title = '  it("never strengthens conflicting completion claims and rejects failed terminal claims", async () => {'
new_title = '  it("never strengthens conflicting completion claims or trusts bare cancellation", async () => {'
if test.count(old_title) != 1:
    raise SystemExit("terminal integration test title anchor missing or ambiguous")
test = test.replace(old_title, new_title)
old_case = '''    const failed: FederationJobRecord = {
      request_digest: DIGEST,
      status: status("FAILED", "ANSWERED_WITH_SUPPORTED_RESULT"),
      observed_completion_disposition: "ANSWERED_WITH_SUPPORTED_RESULT",
      result: null,
    };
    await expectCode(
      createFederationService(dependencies(failed)).status(
        context(),
        "exchange-1",
        "idempotency-1",
      ),
      "FEDERATION_AUTHORITY_INVALID",
    );'''
new_case = '''    const bareCancelled: FederationJobRecord = {
      request_digest: DIGEST,
      status: {
        ...status("CANCELLED", null),
        cancellation_receipt_ref: undefined,
        terminal_receipt_ref: undefined,
      },
      observed_completion_disposition: null,
      result: null,
    };
    await expectCode(
      createFederationService(dependencies(bareCancelled)).status(
        context(),
        "exchange-1",
        "idempotency-1",
      ),
      "FEDERATION_AUTHORITY_INVALID",
    );'''
if test.count(old_case) != 1:
    raise SystemExit("terminal integration negative anchor missing or ambiguous")
test_path.write_text(test.replace(old_case, new_case), encoding="utf-8")

document_path = Path("docs/agent-work/ER-22-generic-federation-boundary.md")
document = document_path.read_text(encoding="utf-8")
document_anchor = "- `apps/eliotr-core/src/federation-request-authorities.ts`\n- `apps/eliotr-core/src/federation-service.test.ts`"
document_replacement = (
    "- `apps/eliotr-core/src/federation-request-authorities.ts`\n"
    "- `apps/eliotr-core/src/federation-terminal-authority.ts`\n"
    "- `apps/eliotr-core/src/federation-terminal-authority.test.ts`\n"
    "- `apps/eliotr-core/src/federation-service.test.ts`"
)
if document.count(document_anchor) != 1:
    raise SystemExit("ER-22 document ownership anchor missing or ambiguous")
document = document.replace(document_anchor, document_replacement)
required_anchor = (
    "- Map internal outcomes toward less assertive exact disposition; transport completion remains orthogonal."
)
required_replacement = (
    "- Map internal outcomes toward less assertive exact disposition; transport completion remains orthogonal.\n"
    "- Require state-appropriate durable terminal authority: none on active states, one terminal receipt\n"
    "  on FAILED/COMPLETED, and one matching cancellation/terminal receipt identity on CANCELLED."
)
if document.count(required_anchor) != 1:
    raise SystemExit("ER-22 required implementation anchor missing or ambiguous")
document = document.replace(required_anchor, required_replacement)
acceptance_anchor = "- No reverse authority or client canonical write path exists."
acceptance_replacement = (
    "- No reverse authority or client canonical write path exists.\n"
    "- Bare cancellation, unreceipted terminal state, or terminal authority on active transport fails closed."
)
if document.count(acceptance_anchor) != 1:
    raise SystemExit("ER-22 acceptance anchor missing or ambiguous")
document = document.replace(acceptance_anchor, acceptance_replacement)
implemented_anchor = (
    "Terminal output is reconciled to `observed_completion_disposition`. Transport `COMPLETED` therefore\n"
    "remains orthogonal to research success:"
)
implemented_replacement = (
    "Terminal output is reconciled to `observed_completion_disposition`, but only after state-appropriate\n"
    "receipt authority is present. Active states expose neither terminal nor cancellation receipts; FAILED\n"
    "and COMPLETED require a terminal receipt; CANCELLED requires exact CANCELLED dispositions, no result,\n"
    "and one matching cancellation/terminal receipt identity. Transport `COMPLETED` therefore remains\n"
    "orthogonal to research success:"
)
if document.count(implemented_anchor) != 1:
    raise SystemExit("ER-22 implemented-boundary anchor missing or ambiguous")
document_path.write_text(
    document.replace(implemented_anchor, implemented_replacement),
    encoding="utf-8",
)

manifest_path = Path("docs/agent-work/manifest.json")
manifest = manifest_path.read_text(encoding="utf-8")
manifest_anchor = '        "apps/eliotr-core/src/federation-request-authorities.ts",\n        "apps/eliotr-core/src/federation-service.test.ts"'
manifest_replacement = (
    '        "apps/eliotr-core/src/federation-request-authorities.ts",\n'
    '        "apps/eliotr-core/src/federation-terminal-authority.ts",\n'
    '        "apps/eliotr-core/src/federation-terminal-authority.test.ts",\n'
    '        "apps/eliotr-core/src/federation-service.test.ts"'
)
if manifest.count(manifest_anchor) != 1:
    raise SystemExit("ER-22 manifest ownership anchor missing or ambiguous")
manifest_path.write_text(
    manifest.replace(manifest_anchor, manifest_replacement),
    encoding="utf-8",
)
