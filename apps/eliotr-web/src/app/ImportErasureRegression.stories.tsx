import { ImportErasureRegressionFixture, type PanelRegressionProbe } from "./ImportErasureRegressionFixture";

export default {
  title: "Workspace/Issue 335 composed panel regressions",
  component: ImportErasureRegressionFixture,
  parameters: { layout: "fullscreen" },
};

let importProbe: PanelRegressionProbe | undefined;
let erasureProbe: PanelRegressionProbe | undefined;

const observeImport = (probe: PanelRegressionProbe) => { importProbe = probe; };
const observeErasure = (probe: PanelRegressionProbe) => { erasureProbe = probe; };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equalData(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (actual === null || expected === null || typeof actual !== "object" || typeof expected !== "object") {
    return false;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length &&
      actual.every((value, index) => equalData(value, expected[index]));
  }
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const actualKeys = Object.keys(actualRecord);
  const expectedKeys = Object.keys(expectedRecord);
  return actualKeys.length === expectedKeys.length && actualKeys.every(key =>
    Object.hasOwn(expectedRecord, key) && equalData(actualRecord[key], expectedRecord[key]));
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  assert(Object.is(actual, expected), message);
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  assert(equalData(actual, expected), message);
}

function assertLength(actual: { readonly length: number }, expected: number, message: string): void {
  assert(actual.length === expected, message);
}

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let count = 0; count < 120; count += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error("Import/erasure regression fixture timed out: " + label);
}

async function bundleFiles(): Promise<File[]> {
  const encode = (value: string) => new TextEncoder().encode(value);
  const digest = async (bytes: Uint8Array) => Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
    value => value.toString(16).padStart(2, "0"),
  ).join("");
  const content = "# Panel regression evidence\n";
  const contentHash = await digest(encode(content));
  const makeManifest = (allowedUse: readonly string[]) => JSON.stringify({
    protocol: "eliotr.normalized.v1",
    origin: {
      owner_system_id: "panel-owner",
      source_namespace_id: "workspace-panel-1",
      source_owner_generation: "owner-generation-panel",
      source_revision_ref: "panel-source-revision",
      source_view_ref: "panel-source-view",
      ownership_mode: "immutable_import",
    },
    source: {
      logical_id: "panel-bundle-source",
      original_name: "Panel regression evidence",
      original_sha256: contentHash,
      origin_location_class: "local_only",
      mime_type: "text/markdown",
    },
    residency_and_disclosure: {
      scope_domain_id: "scope-panel",
      access_domain_id: "access-panel",
      confidentiality_domain_id: "confidentiality-panel",
      encryption_key_domain_id: "encryption-panel",
      retention_domain_id: "retention-panel",
      erasure_domain_id: "erasure-panel",
      disclosure_ceiling: "owner-only",
      allowed_use: allowedUse,
    },
    normalization: { analyzer: "panel-analyzer", analyzer_version: "1.0.0", profile: "panel-profile", config_hash: "a".repeat(64), created_at: "2026-10-13T12:00:00.000Z" },
    content: { markdown: "content.md", markdown_sha256: contentHash },
    capabilities: { text_ranges: true, pages: false, bounding_boxes: false, tables: false, figures: false },
    quality: { state: "high_fidelity", assurance_ceiling: "panel-ceiling", warnings: [] },
    export: { purpose: "owner workspace import", receipt_ref: "panel-export-receipt" },
  });
  const metadataLimit = 256 * 1024;
  const identifier = "a".repeat(256);
  const emptyManifest = makeManifest([]);
  // Each valid 256-byte identifier adds 259 JSON bytes. Fill the file to its browser limit;
  // the surrounding prepare envelope then crosses the separate local dispatch guard.
  const allowedUseCount = Math.floor((metadataLimit - encode(emptyManifest).byteLength + 1) / 259);
  const manifest = makeManifest(Array.from({ length: allowedUseCount }, () => identifier));
  const manifestBytes = encode(manifest);
  if (manifestBytes.byteLength > metadataLimit) throw new Error("Bundle fixture manifest exceeded the browser metadata limit");
  const manifestHash = await digest(encode(manifest));
  const hashList = `${contentHash} *content.md\n${manifestHash} *manifest.json\n`;
  const hashListBytes = encode(hashList);
  const totalBytes = manifestBytes.byteLength + encode(content).byteLength + hashListBytes.byteLength;
  const manifestValue: unknown = JSON.parse(manifest);
  const prepareRequest = JSON.stringify({
    manifest: manifestValue,
    file_hashes: {
      "manifest.json": manifestHash,
      "content.md": contentHash,
      "hashes.sha256": await digest(hashListBytes),
    },
    total_bytes: totalBytes,
    idempotency_key: "33333333-3333-4333-8333-000000000000",
  });
  if (encode(prepareRequest).byteLength <= metadataLimit) {
    throw new Error("Bundle fixture did not reach the real prepare-request metadata guard");
  }
  return [
    new File([manifest], "manifest.json", { type: "application/json" }),
    new File([content], "content.md", { type: "text/markdown" }),
    new File([hashList], "hashes.sha256", { type: "text/plain" }),
  ];
}

export const ImportPanelRefusalRecoveryAndExplicitDismissal = {
  args: { panel: "import" },
  render: () => {
    importProbe = undefined;
    return <ImportErasureRegressionFixture panel="import" onProbe={observeImport} />;
  },
  play: async ({ canvas, userEvent }: {
    readonly canvas: {
      findByRole(role: "spinbutton", options: { readonly name: string; readonly exact?: boolean }): Promise<HTMLInputElement>;
      findByRole(role: "button" | "dialog" | "option" | "combobox" | "checkbox", options: { readonly name: string; readonly exact?: boolean }): Promise<HTMLElement>;
      getByRole(role: "combobox", options: { readonly name: string; readonly exact?: boolean }): HTMLSelectElement;
      getByRole(role: "spinbutton", options: { readonly name: string; readonly exact?: boolean }): HTMLInputElement;
      getByRole(role: "button" | "checkbox", options: { readonly name: string; readonly exact?: boolean }): HTMLElement;
      findByText(text: string | RegExp, options?: { readonly selector: string }): Promise<HTMLElement>;
      getByText(text: string): HTMLElement;
      getByLabelText(text: string): HTMLInputElement;
      queryByRole(role: "button", options: { readonly name: string; readonly exact?: boolean }): HTMLElement | null;
      queryByLabelText(text: string): HTMLInputElement | null;
    };
    readonly userEvent: {
      click(element: HTMLElement): Promise<void>;
      selectOptions(element: HTMLSelectElement, value: string): Promise<void>;
      type(element: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void>;
      upload(element: HTMLInputElement, file: File | File[]): Promise<void>;
    };
  }) => {
    await until(() => importProbe !== undefined, "import fixture probe");
    const probe = importProbe;
    assert(probe !== undefined, "Import panel fixture probe was not supplied");

    const originalText = "Original editable source bytes stay with the owner.";
    await userEvent.click(await canvas.findByRole("button", { name: "Import sources" }));
    await canvas.findByRole("dialog", { name: "Import sources" });
    await canvas.findByRole("option", { name: "Panel imports" });
    await userEvent.selectOptions(canvas.getByRole("combobox", { name: "Save the file in" }), "workspace-panel-1");
    await userEvent.upload(canvas.getByLabelText("Choose a file"), new File([originalText], "original.md", { type: "text/markdown" }));
    await userEvent.click(canvas.getByRole("button", { name: "Review the selected file" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Capture the selected file" }));

    await userEvent.type(await canvas.findByRole("spinbutton", { name: "Maximum result size (bytes)" }), "4096");
    await userEvent.type(canvas.getByRole("spinbutton", { name: "Maximum processing tokens" }), "64");
    await userEvent.type(canvas.getByRole("spinbutton", { name: "Time limit (milliseconds)" }), "30000");
    await userEvent.click(canvas.getByRole("button", { name: "Review processing options" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Process the captured file" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Add to Library" }));
    await until(() => probe.importMemory()?.file?.admission?.state === "UNKNOWN", "unknown raw admission outcome");

    const unknownAdmission = probe.importMemory();
    if (!unknownAdmission) throw new Error("Unknown admission outcome lost its protected intent");
    const unknownSelection = unknownAdmission.selection;
    const unknownFile = unknownAdmission.file;
    if (!unknownSelection || !unknownFile) throw new Error("Unknown admission outcome discarded its selected input");
    const unknownResult = unknownFile.admission;
    const capturedFile = unknownFile.receipt;
    const completedConversion = unknownFile.conversion;
    if (!unknownResult || !capturedFile || !completedConversion) {
      throw new Error("Unknown admission outcome discarded the original request state");
    }
    const admissionOperationId = unknownResult.admission_operation_id;
    assertEqual(unknownSelection.original_file_name, "original.md", "Unknown admission changed the selected filename");
    assertEqual(new TextDecoder().decode(unknownSelection.bytes), originalText, "Unknown admission changed the selected bytes");
    assertEqual(completedConversion.state, "COMPLETE", "Unknown admission lost the completed conversion");
    assertEqual(unknownFile.uncertain, "admission", "Unknown admission lost its uncertain phase");
    assert(unknownAdmission.admissionRejected !== true, "Unknown admission was marked rejected");
    assertLength(probe.counts().rawAdmissionKeys, 1, "Unknown admission minted another identity");
    assertLength(probe.counts().rawAdmissionBodies, 1, "Unknown admission repeated its mutation body");
    const admissionBody = probe.counts().rawAdmissionBodies[0];
    if (!admissionBody) throw new Error("The admission request body was not captured");
    const admissionRequest: unknown = JSON.parse(admissionBody);
    assertDeepEqual(admissionRequest, {
      idempotency_key: probe.counts().rawAdmissionKeys[0],
      conversion_operation_id: completedConversion.operation_id,
    }, "Unknown admission changed its original request identity");
    assertDeepEqual(probe.counts().rawAdmissionStatusPaths, [], "Unknown admission read status before an explicit check");
    await canvas.findByText("Library admission outcome is unknown. Check the same admission identity again.");
    await userEvent.click(await canvas.findByRole("button", { name: "Check Library status" }));
    await until(() => probe.importMemory()?.file?.admission?.state === "COMMITTED", "committed raw admission readback");
    const committedAdmission = probe.importMemory()?.file?.admission;
    assert(probe.importMemory()?.file?.uncertain === undefined, "Committed admission retained uncertainty");
    assertEqual(committedAdmission?.admission_receipt?.operation_id, admissionOperationId, "Admission readback changed operation identity");
    assertEqual(committedAdmission?.admission_receipt?.decision, "ADMITTED", "Admission readback changed its decision");
    assertLength(probe.counts().rawAdmissionKeys, 1, "Admission readback repeated the mutation identity");
    assertLength(probe.counts().rawAdmissionBodies, 1, "Admission readback repeated the mutation body");
    assertDeepEqual(probe.counts().rawAdmissionStatusPaths, [
      `/api/v1/ingest/raw/${capturedFile.capture_id}/admission/${admissionOperationId}`,
    ], "Admission status readback changed its canonical path");
    await userEvent.click(canvas.getByRole("button", { name: "Choose another file" }));

    const uncertainText = "Second source whose capture acknowledgement is lost.";
    await userEvent.upload(canvas.getByLabelText("Choose a file"), new File([uncertainText], "second.md", { type: "text/markdown" }));
    await userEvent.click(canvas.getByRole("button", { name: "Review the selected file" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Capture the selected file" }));
    await canvas.findByText("The last outcome is unknown. Re-read the same identity before starting anything new.");

    const beforeRemount = probe.importMemory();
    if (!beforeRemount?.selection) throw new Error("Lost capture acknowledgement discarded its selected input");
    const captureKey = beforeRemount.selection.idempotency_key;
    assertEqual(beforeRemount.selection.original_file_name, "second.md", "Uncertain capture changed its filename");
    assertEqual(new TextDecoder().decode(beforeRemount.selection.bytes), uncertainText, "Uncertain capture changed its bytes");
    assertEqual(beforeRemount.file?.uncertain, "capture", "Lost capture acknowledgement lost its uncertain phase");
    assertLength(probe.counts().rawCapturePostKeys, 2, "Lost capture acknowledgement repeated capture");
    assertEqual(probe.counts().rawCapturePostKeys[1], captureKey, "Lost capture acknowledgement changed its idempotency key");

    await userEvent.click(canvas.getByRole("button", { name: "Unmount panel" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Mount panel" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Import sources" }));
    await canvas.findByRole("dialog", { name: "Import sources" });
    assertEqual(probe.importMemory()?.selection?.idempotency_key, captureKey, "Remount changed the saved capture identity");
    assertEqual(probe.importMemory()?.selection?.original_file_name, "second.md", "Remount changed the selected filename");
    assertEqual(new TextDecoder().decode(probe.importMemory()?.selection?.bytes), uncertainText, "Remount changed the selected bytes");
    assertEqual(probe.importMemory()?.file?.uncertain, "capture", "Remount lost the uncertain capture phase");
    assertLength(probe.counts().rawCapturePostKeys, 2, "Remount repeated capture");
    await userEvent.click(await canvas.findByRole("button", { name: "Check the previous capture" }));
    await until(() => probe.importMemory()?.file?.receipt !== undefined, "saved capture receipt readback");
    assertDeepEqual(probe.counts().rawCaptureReadKeys, [captureKey], "Capture readback changed the saved identity");
    assertLength(probe.counts().rawCapturePostKeys, 2, "Capture readback repeated capture");

    await userEvent.click(canvas.getByRole("button", { name: "Saved bundle" }));
    await userEvent.upload(canvas.getByLabelText("Choose bundle files"), await bundleFiles());
    await userEvent.click(canvas.getByRole("button", { name: "Review bundle files" }));
    await canvas.findByText("content.md");
    await userEvent.click(canvas.getByRole("checkbox", { name: "Review the exact bytes below before anything is uploaded." }));
    await userEvent.click(await canvas.findByRole("button", { name: "Start the import" }));
    await until(() => probe.importMemory()?.bundleRejected === true, "local bundle dispatch guard refusal");
    await canvas.findByText("The import request was refused before execution. Review the input and access before continuing.", { selector: ".er-import__note" });

    const rejectedBundle = probe.importMemory();
    assert(rejectedBundle?.bundle !== undefined, "Guard refusal discarded the inspected bundle");
    assert(rejectedBundle?.attempt !== undefined, "Guard refusal discarded the local attempt");
    assertEqual(rejectedBundle?.bundleState?.uncertain, false, "Local guard refusal was misreported as uncertain");
    assertEqual(rejectedBundle?.bundleState?.interrupted, false, "Local guard refusal was misreported as interrupted");
    assertLength(probe.counts().bundlePrepareKeys, 0, "Local guard refusal reached bundle prepare");
    assertLength(probe.counts().bundlePartPaths, 0, "Local guard refusal uploaded bundle parts");
    assertLength(probe.counts().bundleCompletePaths, 0, "Local guard refusal completed a bundle");
    assertEqual(probe.counts().bundleCommitCount, 0, "Local guard refusal committed a bundle");
    await userEvent.click(await canvas.findByRole("button", { name: "Clear this import" }));
    await until(() => probe.importMemory()?.bundle === undefined, "explicit bundle dismissal");
    assert(probe.importMemory()?.attempt === undefined, "Dismissal retained the bundle attempt");
    assert(probe.importMemory()?.identity === undefined, "Dismissal retained the bundle identity");
    assert(probe.importMemory()?.bundleState === undefined, "Dismissal retained bundle state");
    assert(probe.importMemory()?.bundleRejected === undefined, "Dismissal retained the local rejection");

    await userEvent.click(canvas.getByRole("button", { name: "Unmount panel" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Mount panel" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Import sources" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Saved bundle" }));
    assert(probe.importMemory()?.bundle === undefined, "Remount restored a dismissed bundle");
    assert(probe.importMemory()?.bundleRejected === undefined, "Remount restored the dismissed guard result");
    assert(canvas.queryByLabelText("Choose bundle files") !== null, "Remount did not restore the bundle picker");
    assertLength(probe.counts().bundlePrepareKeys, 0, "Remount dispatched bundle prepare");
    assertLength(probe.counts().bundlePartPaths, 0, "Remount uploaded bundle parts");
    assertLength(probe.counts().bundleCompletePaths, 0, "Remount completed a bundle");
    assertEqual(probe.counts().bundleCommitCount, 0, "Remount committed a bundle");
  },
};

export const ErasurePanelRefusalFreshReviewUnknownAndCanonicalCompletion = {
  args: { panel: "erasure" },
  render: () => {
    erasureProbe = undefined;
    return <ImportErasureRegressionFixture panel="erasure" onProbe={observeErasure} />;
  },
  play: async ({ canvas, userEvent }: Parameters<typeof ImportPanelRefusalRecoveryAndExplicitDismissal.play>[0]) => {
    await until(() => erasureProbe !== undefined, "erasure fixture probe");
    const probe = erasureProbe;
    assert(probe !== undefined, "Erasure panel fixture probe was not supplied");

    await userEvent.click(canvas.getByText("Manage selected source"));
    await userEvent.click(await canvas.findByRole("button", { name: "Review deletion" }));
    await canvas.findByRole("button", { name: "Confirm deletion" });
    const firstReview = probe.erasureMemory();
    if (!firstReview.intent || !firstReview.prepared) throw new Error("Initial erasure review was not stored");
    const refusedKey = firstReview.intent.key;
    await userEvent.click(canvas.getByRole("button", { name: "Confirm deletion" }));
    await until(() => probe.erasureMemory().intent?.rejected === true, "stale erasure review refusal");
    assertDeepEqual(probe.erasureMemory().prepared, firstReview.prepared, "Stale review refusal changed the saved preparation");
    assertLength(probe.counts().erasureExecuteBodies, 1, "Stale review refusal repeated execution");
    await canvas.findByText("The deletion request was refused before execution. Read a fresh review before confirming again.", { selector: ".er-status > span" });

    await userEvent.click(canvas.getByRole("button", { name: "Unmount panel" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Mount panel" }));
    await userEvent.click(canvas.getByText("Manage selected source"));
    await userEvent.click(await canvas.findByRole("button", { name: "Review deletion" }));
    await canvas.findByRole("button", { name: "Read review again" });
    assert(canvas.queryByRole("button", { name: "Confirm deletion" }) === null, "Remount restored stale confirmation");
    assertEqual(probe.erasureMemory().intent?.key, refusedKey, "Remount changed the refused erasure identity");
    assertEqual(probe.erasureMemory().intent?.rejected, true, "Remount lost the refused state");
    assertDeepEqual(probe.erasureMemory().prepared, firstReview.prepared, "Remount changed the refused preparation");
    assertLength(probe.counts().erasureExecuteBodies, 1, "Remount repeated stale erasure execution");

    await userEvent.click(canvas.getByRole("button", { name: "Read review again" }));
    await canvas.findByRole("button", { name: "Confirm deletion" });
    const freshReview = probe.erasureMemory();
    if (!freshReview.intent || !freshReview.prepared) throw new Error("Explicit fresh review was not stored");
    const freshKey = freshReview.intent.key;
    assert(!Object.is(freshKey, refusedKey), "Fresh review reused the refused identity");
    assertDeepEqual(probe.counts().erasurePrepareKeys, [refusedKey, freshKey], "Fresh review changed the prepare sequence");
    assertDeepEqual(freshReview.prepared.request.request.erasure_ref, { id: "erasure-panel-fresh", revision: 1 },
      "Fresh review selected the wrong erasure reference");

    await userEvent.click(canvas.getByRole("button", { name: "Confirm deletion" }));
    await until(() => probe.counts().erasureExecuteBodies.length === 2, "single lost-ack erasure execution");
    await canvas.findByText("The deletion request is unresolved. Read its saved status.", { selector: ".er-operation-announcement" });
    const unknownReview = probe.erasureMemory();
    if (!unknownReview.intent || !unknownReview.prepared) throw new Error("Unknown erasure outcome lost its review");
    const unknownBody = probe.counts().erasureExecuteBodies[1];
    const bodiesAtUnknown = [...probe.counts().erasureExecuteBodies];
    assertEqual(unknownReview.intent.key, freshKey, "Unknown result changed the submitted erasure identity");
    assertEqual(unknownReview.intent.submitted, true, "Unknown result lost the submitted marker");
    assertDeepEqual(unknownReview.prepared, freshReview.prepared, "Unknown result changed the submitted preparation");
    assertDeepEqual(JSON.parse(unknownBody ?? "null"), unknownReview.prepared.request,
      "Unknown result changed the original execute body");

    await userEvent.click(canvas.getByRole("button", { name: "Unmount panel" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Mount panel" }));
    await userEvent.click(canvas.getByText("Manage selected source"));
    await userEvent.click(await canvas.findByRole("button", { name: "Check deletion request" }));
    await canvas.findByRole("button", { name: "Refresh status" });
    assertEqual(probe.erasureMemory().intent?.key, freshKey, "Remount changed the unknown erasure identity");
    assertDeepEqual(probe.erasureMemory().prepared, unknownReview.prepared, "Remount changed the unknown preparation");
    assertDeepEqual(probe.counts().erasureExecuteBodies, bodiesAtUnknown, "Remount repeated the uncertain execute request");
    await userEvent.click(canvas.getByRole("button", { name: "Refresh status" }));
    await canvas.findByText("The deletion result is unknown. Refresh the status to read the saved request.");
    assertEqual(probe.counts().erasureStatusReads, 1, "First saved-status refresh changed its read count");
    assertEqual(probe.counts().completionReports, 0, "Unknown saved status reported completion");
    assertDeepEqual(probe.counts().completionReportRefs, [], "Unknown saved status reported a completion reference");
    assertLength(probe.counts().erasureExecuteBodies, 2, "Saved-status refresh repeated erasure execution");

    await userEvent.click(canvas.getByRole("button", { name: "Refresh status" }));
    await canvas.findByText("The deletion review could not be read. Try again with the same request.");
    assertEqual(probe.counts().erasureStatusReads, 2, "Foreign receipt changed the status read count");
    assertEqual(probe.counts().completionReports, 0, "Foreign receipt reported completion");
    assertDeepEqual(probe.counts().completionReportRefs, [], "Foreign receipt reported a completion reference");
    assertLength(probe.counts().erasureExecuteBodies, 2, "Foreign receipt caused another execute request");

    await userEvent.click(canvas.getByRole("button", { name: "Refresh status" }));
    await canvas.findByText("Deletion confirmed by the saved server receipt.", { selector: ".er-status > span" });
    await until(() => probe.counts().completionReports === 1, "canonical erasure completion report");
    assertDeepEqual(probe.counts().completionReportRefs, ["source-panel-1:erasure-panel-fresh:1"],
      "Canonical receipt reported the wrong completion reference");
    assertDeepEqual(probe.counts().erasureStatusPaths, [
      "/api/v1/library/erasure/erasure-panel-fresh/1",
      "/api/v1/library/erasure/erasure-panel-fresh/1",
      "/api/v1/library/erasure/erasure-panel-fresh/1",
    ], "Canonical status reads changed their saved request path");
    assertEqual(probe.counts().completionReports, 1, "Canonical receipt reported completion more than once");
    assertLength(probe.counts().erasureExecuteBodies, 2, "Canonical completion retried erasure execution");
  },
};
