import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { RawFileCaptureReceipt, RawMarkdownConversionRequest, RawMarkdownConversionResult } from "@eliotr/owner-api-client";
import { IMPORT_FLOW_COPY, ImportFlow, type ImportFlowBundleReview, type ImportFlowProps } from "../../../features/sources/import/ImportFlow";
const meta: Meta<ImportFlowProps> = { title: "Product/Sources/Import", component: ImportFlow,
  args: { locale: "en", copy: IMPORT_FLOW_COPY.en }, decorators: [Story => <div className="eliot-token-story"><Story /></div>] };
export default meta;
type Story = StoryObj<typeof meta>;
const capture: RawFileCaptureReceipt = { protocol: "eliotr.raw-file-capture.v1", disposition: "CAPTURED", capture_id: "raw-capture-" + "b".repeat(48),
  idempotency_key: "raw-upload-" + "c".repeat(64), original_file_name: "Infrastructure evidence.pdf", content_sha256: "d".repeat(64),
  size_bytes: 262144, content_type: "application/pdf", captured_at: "2026-10-09T14:05:00.000Z" };
const request: RawMarkdownConversionRequest = { idempotency_key: "raw-markdown-" + "a".repeat(64), max_output_bytes: 8388608, max_tokens: 1000000, timeout_ms: 300000 };
const conversion: RawMarkdownConversionResult = { protocol: "eliotr.raw-markdown-conversion.v1", state: "UNKNOWN",
  operation_id: "e".repeat(64), capture_id: capture.capture_id, content_sha256: capture.content_sha256, failure_code: "PROVIDER_UNCERTAIN" };
const review: ImportFlowBundleReview = { files: [{ path: "manifest.json", bytes: 512, digestPrefix: "aabbccdd" },
  { path: "content.md", bytes: 18432, digestPrefix: "ddeeff00" }, { path: "hashes.sha256", bytes: 256, digestPrefix: "11223344" }],
  totalBytes: 19200, idempotencyKey: "bundle-import-key-0001" };
export const FileReview: Story = { args: { fileState: { phase: "useful", receipt: capture }, conversionRequest: request, onConvert: fn() } };
export const Loading: Story = { args: { fileState: { phase: "loading" } } };
export const Empty: Story = { args: { onSelectFile: fn() } };
export const Failed: Story = { args: { fileState: { phase: "error", receipt: capture, conversion: { ...conversion, state: "FAILED", failure_code: "PROVIDER_FAILED" } }, onRetryConvert: fn() } };
export const LongRussian: Story = { args: { locale: "ru", copy: IMPORT_FLOW_COPY.ru,
  fileState: { phase: "useful", receipt: { ...capture, original_file_name: "Ежеквартальный отчёт об инфраструктуре исследовательской рабочей области с сохранёнными доказательствами.pdf" } }, conversionRequest: request, onConvert: fn() } };
export const ConversionNotRequested: Story = { args: { fileState: { phase: "useful", receipt: capture }, onConvert: fn() },
  play: async ({ canvasElement }) => { const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: IMPORT_FLOW_COPY.en.convert })).not.toBeInTheDocument();
    await expect(canvas.getByText(IMPORT_FLOW_COPY.en.convert_unavailable)).toBeVisible(); } };
export const UncertainOutcome: Story = { args: { fileState: { phase: "degraded", receipt: capture, conversion, uncertain: "conversion" }, conversionRequest: request,
  onCapture: fn(), onConvert: fn(), onAdmit: fn(), onReconcileConversion: fn() },
  play: async ({ canvasElement }) => { const canvas = within(canvasElement);
    for (const name of [IMPORT_FLOW_COPY.en.capture, IMPORT_FLOW_COPY.en.convert, IMPORT_FLOW_COPY.en.admit]) await expect(canvas.queryByRole("button", { name })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: IMPORT_FLOW_COPY.en.reconcile_conversion })).toBeVisible(); } };
const convertSpy = fn();
export const InteractionJourney: Story = { args: { fileState: { phase: "useful", receipt: capture }, conversionRequest: request, onConvert: convertSpy },
  play: async ({ canvasElement }) => { const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: IMPORT_FLOW_COPY.en.convert }));
    await expect(convertSpy).toHaveBeenCalledTimes(1); await expect(convertSpy).toHaveBeenCalledWith(request); } };
const runSpy = fn();
export const BundleReviewJourney: Story = { args: { view: "bundle", bundleReview: review, bundleState: { phase: "useful" }, onRunBundle: runSpy },
  play: async ({ canvasElement }) => { const canvas = within(canvasElement); await expect(canvas.getByText("content.md")).toBeVisible();
    const start = canvas.getByRole("button", { name: IMPORT_FLOW_COPY.en.run }); await expect(start).toBeDisabled(); await expect(runSpy).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("checkbox", { name: IMPORT_FLOW_COPY.en.review_intro })); await userEvent.click(start);
    await expect(runSpy).toHaveBeenCalledTimes(1); await expect(start).toBeDisabled(); } };
export const InterruptedImport: Story = { args: { view: "bundle", bundleReview: review, bundleState: { phase: "degraded", interrupted: true }, onRunBundle: fn(), onInspectBundle: fn() },
  play: async ({ canvasElement }) => { const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: IMPORT_FLOW_COPY.en.run })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: IMPORT_FLOW_COPY.en.inspect })).toBeVisible(); await expect(canvas.queryByText(IMPORT_FLOW_COPY.en.committed)).not.toBeInTheDocument(); } };
