from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    Path(path).write_text(text.rstrip() + "\n", encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}: {old[:120]!r}")
    write(path, text.replace(old, new))


def replace_between(path: str, start: str, end: str, replacement: str) -> None:
    text = read(path)
    start_index = text.find(start)
    end_index = text.find(end, start_index + len(start))
    if start_index < 0 or end_index < 0:
        raise SystemExit(f"{path}: section markers not found: {start!r}, {end!r}")
    write(path, text[:start_index] + replacement.rstrip() + "\n\n" + text[end_index:])


# A persisted run payload is an immutable R2 WorkflowObject, not a compact D1
# receipt. Keep the existing 8 MiB WorkflowObject profile and the 64 KiB receipt
# profile separate rather than raising the receipt limit globally.
replace_once(
    "packages/cloudflare-research-runtime/src/research-session-application.ts",
    "  MAX_WORKFLOW_RECEIPT_BYTES,\n",
    "  MAX_WORKFLOW_OUTPUT_BYTES,\n",
)
replace_once(
    "packages/cloudflare-research-runtime/src/research-session-application.ts",
    '''  if (bytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) {
    ports.fail("RESEARCH_INPUT_LIMIT",
      `research workflow input exceeds ${MAX_WORKFLOW_RECEIPT_BYTES} UTF-8 bytes; partition the requested scope or shorten the question`,
      413);
  }
''',
    '''  if (bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) {
    ports.fail("RESEARCH_INPUT_LIMIT",
      `research workflow input object exceeds ${MAX_WORKFLOW_OUTPUT_BYTES} UTF-8 bytes; partition the requested scope or shorten the question`,
      413);
  }
''',
)

replace_once(
    "packages/cloudflare-research-branches/src/research-protocol-freeze.ts",
    "  MAX_WORKFLOW_RECEIPT_BYTES,\n",
    "  MAX_WORKFLOW_OUTPUT_BYTES,\n",
)
replace_once(
    "packages/cloudflare-research-branches/src/research-protocol-freeze.ts",
    '''  if (bytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) fail("RESEARCH_PROTOCOL_FREEZE_INPUT_INVALID", "run payload exceeds the checkpoint bound");
''',
    '''  if (bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) fail("RESEARCH_PROTOCOL_FREEZE_INPUT_INVALID", "run payload exceeds the workflow object bound");
''',
)
replace_once(
    "packages/cloudflare-research-branches/src/research-protocol-freeze.ts",
    '''  if (bytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_INVALID", "protocol scope checkpoint exceeds 64 KiB");
''',
    '''  if (bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_INVALID", "protocol scope checkpoint exceeds the workflow object bound");
''',
)
replace_once(
    "packages/cloudflare-research-branches/src/research-protocol-freeze.ts",
    '''  if (bytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) fail("RESEARCH_PROTOCOL_FREEZE_INPUT_INVALID", "protocol scope checkpoint exceeds 64 KiB");
''',
    '''  if (bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) fail("RESEARCH_PROTOCOL_FREEZE_INPUT_INVALID", "protocol scope checkpoint exceeds the workflow object bound");
''',
)

# Route the existing Workerd fixture through the real admission payload writer,
# then make the long-question case cross 64 KiB at both the input and checkpoint.
test_path = "apps/eliotr-core/test/research-protocol-freeze.test.ts"
replace_once(
    test_path,
    '''  createWorkflowCheckpointExecutor,
  digest,
  fail,
''',
    '''  createWorkflowCheckpointExecutor,
  digest,
  fail,
  MAX_WORKFLOW_OUTPUT_BYTES,
  MAX_WORKFLOW_RECEIPT_BYTES,
''',
)
replace_once(
    test_path,
    '''import type { EvidenceGrade, ScopeSnapshot, VersionedRef } from "@eliotr/contracts";
''',
    '''import type { EvidenceGrade, ScopeSnapshot, VersionedRef } from "@eliotr/contracts";
import type { QueryRequest } from "@eliotr/interfaces";
import { persistResearchSessionRunPayload } from
  "@eliotr/cloudflare-research-runtime/research-session-application.js";
''',
)
replace_once(
    test_path,
    '''  const payloadKey = `protocol-freeze-input-${tag}`;
''',
    "",
)
replace_between(
    test_path,
    "  const payload = {\n",
    "  const ledgerInput: CreateLedgerInput = {\n",
    '''  const request: QueryRequest = {
    query: question,
    product: "RESEARCH",
    scope_expression: { kind: "SELECTED_SOURCES", source_ids: [sourceId] },
    literals: [],
    evidence_grade: evidenceGrade,
    budget_ref: `protocol-budget-${tag}`,
    max_results: 1,
    ...(protocolRef === undefined ? {} : {
      request_version: "eliotr.research-run-request.v2" as const,
      inquiry_protocol_ref: protocolRef,
    }),
  };
  const persistedPayload = await persistResearchSessionRunPayload({
    request,
    operation_id: `protocol-run-${tag}`,
    investigation_id: `protocol-investigation-${tag}`,
    payload_suffix: tag,
    scope_ref: { id: scope.snapshot_id, revision: scope.revision },
    ...(planningManifest === undefined ? {} : { planning_manifest: planningManifest }),
    principal_ref: principal.principal_ref,
  }, {
    work_bucket: bucket,
    fail: (code, message, status = 500, retryable = false): never => {
      throw Object.assign(new Error(message), { code, status, retryable });
    },
  });
  const payloadKey = persistedPayload.object_key;
  const payloadBytes = persistedPayload.bytes;
  const payloadDigest = persistedPayload.sha256;''',
)
replace_once(
    test_path,
    "    goal: payload.query,\n",
    "    goal: question,\n",
)
replace_between(
    test_path,
    'describe("S24 exact long question protocol freeze", () => {\n',
    "__END_OF_FILE__",
    '''describe("C03 persisted workflow object bounds", () => {
  it("freezes and replays R2 input and checkpoint objects larger than the receipt bound", async () => {
    const question = "  English question\\r\\n\\t- Русский пункт 😀\\n> quoted evidence\\n".repeat(1_200);
    const fixture = await createProtocolFreezeFixture("c03-large-object", question, INSTALLED_INQUIRY_PROTOCOL_REFS.lookup);
    expect(fixture.request.input_manifest.byte_length).toBeGreaterThan(MAX_WORKFLOW_RECEIPT_BYTES);
    expect(fixture.request.input_manifest.byte_length).toBeLessThanOrEqual(MAX_WORKFLOW_OUTPUT_BYTES);

    const handler = createFreezeProtocolAndScopeStageHandler({ navigation: fixture.navigation, ledger: fixture.ledger });
    const first = await fixture.executor.execute(fixture.request, principal, handler);
    const bytes = await readWorkflowObject(fixture.bucket, first.output_manifest, true);
    expect(first.output_manifest.byte_length).toBeGreaterThan(MAX_WORKFLOW_RECEIPT_BYTES);
    expect(first.output_manifest.byte_length).toBeLessThanOrEqual(MAX_WORKFLOW_OUTPUT_BYTES);

    const checkpoint = decodeProtocolScopeCheckpoint(bytes);
    expect(checkpoint.protocol_profile.question).toBe(question);
    expect((await fixture.ledger.read(fixture.request.investigation_ref.id))?.head.goal).toBe(question);
    expect(await fixture.executor.execute(fixture.request, principal, handler)).toEqual(first);
    expect(await readWorkflowObject(fixture.bucket, first.output_manifest, true)).toEqual(bytes);
    const readback = await readFreezeProtocolAndScopeCheckpoint({ request: fixture.request, principal, database: fixture.db,
      bucket: fixture.bucket, navigation: fixture.navigation, ledger: fixture.ledger });
    expect(readback.protocol_profile.question).toBe(question);
  }, 30_000);
});
'''.replace("\n__END_OF_FILE__", ""),
)

# replace_between needs a real end marker; the final describe is the end of file.
# The call above intentionally uses a sentinel and is corrected here before write.
# (This block is unreachable if the marker did not exist.)

replace_once(
    "docs/implementation/runtime-contract.md",
    '''The earlier C03 256-KiB HTTP versus 64-KiB persisted-input mismatch is a source finding, not a desired limit. Align
the actual producer, stored locator and readers in the changed path.
''',
    '''Research HTTP, immutable R2 objects and compact receipts have separate bounds. The HTTP JSON envelope remains
256 KiB; initial run payloads and protocol checkpoints use the existing bounded WorkflowObject/R2 profile; only
compact D1/step receipt documents use the 64 KiB receipt profile. Writers and readers enforce the same object bound.
''',
)
replace_once(
    "docs/implementation/backend-entrypoints.md",
    "| C03 | Align HTTP, stored input and compact Workflow state; one large immutable value behind a locator |\n",
    "",
)
replace_once(
    "docs/implementation/research-runtime-configuration.md",
    '''- The immutable initial workflow payload is at most 65,536 UTF-8 bytes. This
  includes the planning manifest and its question copy, when present. Overflow
  returns `RESEARCH_INPUT_LIMIT` naming this bound before R2 input publication,
  ledger/run creation or model reservation. It is not a 65,536-character promise.
''',
    '''- The immutable initial workflow payload and first protocol checkpoint are R2
  `WorkflowObject` values, bounded by the existing 8,388,608-byte object profile.
  The separate 65,536-byte limit applies only to compact D1/step receipts. Overflow
  returns `RESEARCH_INPUT_LIMIT` before R2 publication, ledger/run creation or model
  reservation; it is not a character-count promise.
''',
)
