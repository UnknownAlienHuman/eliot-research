/** ImportFlow — U3-I props-only feature.
 *
 * No transport, factory, store, Query client, file hashing or persistence. Local UI state only;
 * every remote value arrives as a remote DTO prop and every action is an explicit callback.
 *
 * Conversion is never automatic: the caller-selected `RawMarkdownConversionRequest` arrives as
 * a root-supplied typed prop, and the control is absent rather than disabled when it is missing.
 *
 * Bundle import is one honest stage. `attempt.run()` performs prepare, upload and commit in a
 * single call, so the review gate renders the frozen bytes before that call and the panel claims
 * no separate commit step. Completion requires a COMMITTED status bound to a receipt.
 */
import { useId, useState } from "react";
import { Button, Field, Status } from "../../../primitives/primitives";
import type {
  BrowserBundleImport,
  ImportProgress,
  ImportStatus,
  RawFileCaptureReceipt,
  RawMarkdownConversionRequest,
  RawMarkdownConversionResult,
  RawNormalizedAdmissionResult,
  } from "@eliotr/owner-api-client";
import "./import-flow.css";

export type ImportFlowView = "file" | "bundle";
export type ImportFlowLocale = "en" | "ru";

/** Local presentation state composed by the root from accepted wire DTOs. */
export interface ImportFileState {
  readonly phase: "useful" | "loading" | "degraded" | "error";
  readonly receipt?: RawFileCaptureReceipt;
  readonly conversion?: RawMarkdownConversionResult;
  readonly admission?: RawNormalizedAdmissionResult;
  readonly uncertain?: "capture" | "conversion" | "admission";
  readonly interrupted?: boolean;
}
export interface ImportBundleState {
  readonly phase: "useful" | "loading" | "degraded" | "error";
  readonly progress?: ImportProgress;
  readonly recoveryId?: string;
  readonly uncertain?: boolean;
  readonly interrupted?: boolean;
  readonly status?: ImportStatus;
  readonly receipt?: NonNullable<Awaited<ReturnType<BrowserBundleImport["run"]>>>;
}

/** A frozen file bundle as the client sees it, reduced to what the review gate may show. */
export interface ImportFlowBundleFile {
  readonly path: string;
  readonly bytes: number;
  readonly digestPrefix: string;
}

export interface ImportFlowBundleReview {
  readonly files: readonly ImportFlowBundleFile[];
  readonly totalBytes: number;
  readonly idempotencyKey: string;
  readonly operationId?: string;
}

export interface ImportFlowCopy {
  readonly title: string;
  readonly file_tab: string;
  readonly bundle_tab: string;
  readonly file_hint: string;
  readonly bundle_hint: string;
  readonly choose_file: string;
  readonly choose_bundle: string;
  readonly recovery_id: string;
  readonly prepare: string;
  readonly prepare_bundle: string;
  readonly capture: string;
  readonly recover_capture: string;
  readonly convert: string;
  readonly convert_unavailable: string;
  readonly retry_convert: string;
  readonly reconcile_conversion: string;
  readonly admit: string;
  readonly admit_status: string;
  readonly review_intro: string;
  readonly review_files: string;
  readonly review_total: string;
  readonly review_identity: string;
  readonly review_operation: string;
  readonly run: string;
  readonly stop: string;
  readonly inspect: string;
  readonly dispose: string;
  readonly captured_at: string;
  readonly conversion_state: string;
  readonly admission_state: string;
  readonly source_revision: string;
  readonly phase: string;
  readonly unknown_heading: string;
  readonly unknown_conversion: string;
  readonly unknown_admission: string;
  readonly unknown_bundle: string;
  readonly interrupted: string;
  readonly missing_request: string;
  readonly not_complete: string;
  readonly committed: string;
  readonly loading: string;
}

export interface ImportFlowProps {
  readonly locale?: ImportFlowLocale;
  readonly copy: ImportFlowCopy;
  readonly view?: ImportFlowView;
  /** False while this destination is hidden; closes the review gate. */
  readonly active?: boolean;
  readonly fileState?: ImportFileState | undefined;
  readonly bundleState?: ImportBundleState | undefined;
  readonly bundleReview?: ImportFlowBundleReview | undefined;
  readonly conversionRequest?: RawMarkdownConversionRequest | undefined;
  readonly selectionName?: string | undefined;
  readonly onSelectFile?: ((file: File) => void) | undefined;
  readonly onSelectBundle?: ((files: readonly File[]) => void) | undefined;
  readonly onPrepareFile?: (() => void) | undefined;
  readonly onPrepareBundle?: (() => void) | undefined;
  readonly onCapture?: (() => void) | undefined;
  readonly onRecoverCapture?: (() => void) | undefined;
  readonly onConvert?: ((request: RawMarkdownConversionRequest) => void) | undefined;
  readonly onReconcileConversion?: (() => void) | undefined;
  readonly onRetryConvert?: ((priorOperationId: string) => void) | undefined;
  readonly onAdmit?: (() => void) | undefined;
  readonly onAdmissionStatus?: (() => void) | undefined;
  readonly onRecoveryIdChange?: ((operationId: string) => void) | undefined;
  readonly onRunBundle?: (() => void) | undefined;
  readonly onStopBundle?: (() => void) | undefined;
  readonly onInspectBundle?: (() => void) | undefined;
  readonly onDisposeBundle?: (() => void) | undefined;
  readonly onViewChange?: ((view: ImportFlowView) => void) | undefined;
}

const EN_COPY: ImportFlowCopy = {
  title: "Import a document or a saved bundle",
  file_tab: "Single file",
  bundle_tab: "Saved bundle",
  file_hint: "Choose one file, review what the server captured, then process it before any Library step.",
  bundle_hint: "Choose a bundle folder, review the frozen bytes, then start one import that prepares, uploads and commits.",
  choose_file: "Choose a file",
  choose_bundle: "Choose bundle files",
  recovery_id: "Operation ID from a previous upload",
  prepare: "Review the selected file",
  prepare_bundle: "Review bundle files",
  capture: "Capture the selected file",
  recover_capture: "Check the previous capture",
  convert: "Process the captured file",
  convert_unavailable: "Processing options have not been chosen yet. Nothing was sent.",
  retry_convert: "Try processing again",
  reconcile_conversion: "Check processing status",
  admit: "Add to Library",
  admit_status: "Check Library status",
  review_intro: "Review the exact bytes below before anything is uploaded.",
  review_files: "Frozen files",
  review_total: "Total bytes",
  review_identity: "Import identity",
  review_operation: "Operation",
  run: "Start the import",
  stop: "Stop sending",
  inspect: "Check import status",
  dispose: "Clear this import",
  captured_at: "Captured",
  conversion_state: "Processing",
  admission_state: "Library admission",
  source_revision: "Source revision",
  phase: "Progress",
  unknown_heading: "The last outcome is unknown. Re-read the same identity before starting anything new.",
  unknown_conversion: "Processing outcome is unknown. Check the same processing identity again.",
  unknown_admission: "Library admission outcome is unknown. Check the same admission identity again.",
  unknown_bundle: "Import outcome is unknown. Check the same import identity again.",
  interrupted: "Stopped before it finished. Requests already sent may have completed.",
  missing_request: "No processing request was selected, so processing cannot start.",
  not_complete: "Processing must be complete before the file can be added to Library.",
  committed: "Committed with a verified receipt.",
  loading: "Loading import state…",
};

const RU_COPY: ImportFlowCopy = {
  title: "Импорт документа или сохранённой подборки",
  file_tab: "Один файл",
  bundle_tab: "Сохранённая подборка",
  file_hint: "Выберите один файл, проверьте, что зафиксировал сервер, и обработайте его перед любым шагом добавления в библиотеку.",
  bundle_hint: "Выберите папку подборки, проверьте зафиксированные байты, затем запустите один импорт, который подготовит, отправит и зафиксирует данные.",
  choose_file: "Выберите файл",
  choose_bundle: "Выберите файлы подборки",
  recovery_id: "Идентификатор операции предыдущей загрузки",
  prepare: "Проверить выбранный файл",
  prepare_bundle: "Проверить файлы подборки",
  capture: "Зафиксировать выбранный файл",
  recover_capture: "Проверить предыдущую фиксацию",
  convert: "Обработать зафиксированный файл",
  convert_unavailable: "Параметры обработки ещё не выбраны. Ничего не отправлено.",
  retry_convert: "Повторить обработку",
  reconcile_conversion: "Проверить статус обработки",
  admit: "Добавить в библиотеку",
  admit_status: "Проверить статус в библиотеке",
  review_intro: "Проверьте точные байты ниже до того, как что-либо будет отправлено.",
  review_files: "Зафиксированные файлы",
  review_total: "Всего байт",
  review_identity: "Идентификатор импорта",
  review_operation: "Операция",
  run: "Начать импорт",
  stop: "Остановить отправку",
  inspect: "Проверить статус импорта",
  dispose: "Очистить этот импорт",
  captured_at: "Зафиксировано",
  conversion_state: "Обработка",
  admission_state: "Допуск в библиотеку",
  source_revision: "Ревизия источника",
  phase: "Прогресс",
  unknown_heading: "Последний результат неизвестен. Перечитайте тот же идентификатор перед началом чего-либо нового.",
  unknown_conversion: "Результат обработки неизвестен. Проверьте тот же идентификатор обработки снова.",
  unknown_admission: "Результат допуска в библиотеку неизвестен. Проверьте тот же идентификатор допуска снова.",
  unknown_bundle: "Результат импорта неизвестен. Проверьте тот же идентификатор импорта снова.",
  interrupted: "Остановлено до завершения. Уже отправленные запросы могли завершиться.",
  missing_request: "Запрос на обработку не выбран, поэтому обработка не может начаться.",
  not_complete: "Обработка должна завершиться до добавления файла в библиотеку.",
  committed: "Зафиксировано с подтверждённой квитанцией.",
  loading: "Загрузка состояния импорта…",
};

export const IMPORT_FLOW_COPY = { en: EN_COPY, ru: RU_COPY } as const;

export function ImportFlow(props: ImportFlowProps) {
  const fileInputId = useId(), bundleInputId = useId();
  const { copy } = props, locale = props.locale ?? "en", view = props.view ?? "file";
  const file = props.fileState, bundle = props.bundleState, review = props.bundleReview;
  const [confirmedReview, setConfirmedReview] = useState<ImportFlowBundleReview>();
  const active = props.active !== false, busy = file?.phase === "loading" || bundle?.phase === "loading";
  const uncertain = file?.uncertain !== undefined || file?.conversion?.state === "UNKNOWN" || bundle?.uncertain === true || bundle?.interrupted === true;
  const capture = file?.receipt;
  const canConvert = capture !== undefined && file?.conversion === undefined && props.conversionRequest !== undefined && !uncertain && !busy;
  const canAdmit = file?.conversion?.state === "COMPLETE" && file.admission === undefined && !uncertain && !busy;
  const receipt = bundle?.receipt, savedReceipt = bundle?.status?.receipt;
  const committed = bundle?.status?.state === "COMMITTED" && receipt !== undefined && savedReceipt !== undefined &&
    (receipt.decision === "ADMITTED" || receipt.decision === "DUPLICATE") &&
    savedReceipt.operation_id === receipt.operation_id && savedReceipt.manifest_sha256 === receipt.manifest_sha256 &&
    savedReceipt.source_revision_ref === receipt.source_revision_ref && savedReceipt.readback_sha256 === receipt.readback_sha256;
  const number = (value: number) => new Intl.NumberFormat(locale === "ru" ? "ru-RU" : "en-US").format(value);
  const conversionLabel = (state: RawMarkdownConversionResult["state"]) => ({
    STARTED: locale === "ru" ? "Обработка началась" : "Processing started",
    COMPLETE: locale === "ru" ? "Обработка завершена" : "Processing complete",
    FAILED: locale === "ru" ? "Обработка не завершилась" : "Processing failed",
    UNKNOWN: locale === "ru" ? "Результат пока неизвестен" : "Outcome not yet known",
  })[state];
  return <section className="er-import" lang={locale} aria-label={copy.title}>
    <header className="er-import__head"><h2 className="er-import__title">{copy.title}</h2>
      {props.onViewChange && <div className="er-import__tabs">
        <Button variant={view === "file" ? "tonal" : "text"} onClick={() => props.onViewChange?.("file")}>{copy.file_tab}</Button>
        <Button variant={view === "bundle" ? "tonal" : "text"} onClick={() => props.onViewChange?.("bundle")}>{copy.bundle_tab}</Button>
      </div>}
    </header>
    <p className="er-import__hint">{view === "file" ? copy.file_hint : copy.bundle_hint}</p>
    {busy && <Status icon="search">{copy.loading}</Status>}
    {view === "file" ? <div className="er-import__review">
      {!uncertain && !capture && props.onSelectFile && <label className="er-import__picker er-button er-button--tonal" htmlFor={fileInputId}>
        <span>{copy.choose_file}</span>
        <input id={fileInputId} type="file" disabled={busy}
          onChange={event => { const selected = event.target.files?.[0]; if (selected) props.onSelectFile?.(selected); event.target.value = ""; }} />
      </label>}
      {props.selectionName && !capture && <p className="er-import__note">{props.selectionName}</p>}
      {capture && <dl className="er-import__facts">
        <div className="er-import__fact"><dt>{copy.choose_file}</dt><dd>{capture.original_file_name}</dd></div>
        <div className="er-import__fact"><dt>{copy.review_total}</dt><dd>{number(capture.size_bytes)}</dd></div>
        <div className="er-import__fact"><dt>{copy.captured_at}</dt><dd>{capture.captured_at}</dd></div>
      </dl>}
      {file?.uncertain === "capture" && <Status>{copy.unknown_heading}</Status>}
      {(file?.uncertain === "conversion" || file?.conversion?.state === "UNKNOWN") && <Status>{copy.unknown_conversion}</Status>}
      {file?.uncertain === "admission" && <Status>{copy.unknown_admission}</Status>}
      {file?.interrupted && <Status>{copy.interrupted}</Status>}
      {file?.conversion && <dl className="er-import__facts"><div className="er-import__fact"><dt>{copy.conversion_state}</dt><dd>{conversionLabel(file.conversion.state)}</dd></div></dl>}
      {file?.admission && <dl className="er-import__facts">
        <div className="er-import__fact"><dt>{copy.admission_state}</dt><dd>{file.admission.state}</dd></div>
        <div className="er-import__fact"><dt>{copy.source_revision}</dt><dd>{file.admission.source_revision_ref}</dd></div>
      </dl>}
      {capture && !props.conversionRequest && !file?.conversion && <p className="er-import__note">{copy.convert_unavailable}</p>}
      <div className="er-import__actions">
        {!capture && !uncertain && props.onPrepareFile && <Button variant="text" onClick={props.onPrepareFile} loading={busy}>{copy.prepare}</Button>}
        {!capture && !uncertain && props.onCapture && <Button onClick={props.onCapture} loading={busy}>{copy.capture}</Button>}
        {props.onRecoverCapture && <Button variant="tonal" onClick={props.onRecoverCapture} loading={busy}>{copy.recover_capture}</Button>}
        {canConvert && props.onConvert && <Button onClick={() => { if (props.conversionRequest) props.onConvert?.(props.conversionRequest); }}>{copy.convert}</Button>}
        {(file?.uncertain === "conversion" || file?.conversion?.state === "STARTED" || file?.conversion?.state === "UNKNOWN") && props.onReconcileConversion && <Button variant="tonal" onClick={props.onReconcileConversion} loading={busy}>{copy.reconcile_conversion}</Button>}
        {file?.conversion?.state === "FAILED" && props.onRetryConvert && <Button variant="tonal" onClick={() => { if (file.conversion) props.onRetryConvert?.(file.conversion.operation_id); }}>{copy.retry_convert}</Button>}
        {canAdmit && props.onAdmit && <Button onClick={props.onAdmit}>{copy.admit}</Button>}
        {(file?.admission || file?.uncertain === "admission") && props.onAdmissionStatus && <Button variant="tonal" onClick={props.onAdmissionStatus} loading={busy}>{copy.admit_status}</Button>}
      </div>
    </div> : <div className="er-import__review">
      {!review && !uncertain && props.onSelectBundle && <label className="er-import__picker er-button er-button--tonal" htmlFor={bundleInputId}>
        <span>{copy.choose_bundle}</span>
        <input id={bundleInputId} type="file" multiple disabled={busy}
          onChange={event => { if (event.target.files) props.onSelectBundle?.(Array.from(event.target.files)); event.target.value = ""; }} />
      </label>}
      {!review && !uncertain && props.onPrepareBundle && <Button variant="text" onClick={props.onPrepareBundle} loading={busy}>{copy.prepare_bundle}</Button>}
      {props.onRecoveryIdChange && <Field label={copy.recovery_id} value={bundle?.recoveryId ?? ""} onChange={event => props.onRecoveryIdChange?.(event.target.value)} />}
      {review && <>
        <p className="er-import__note">{copy.review_intro}</p>
        <ul className="er-import__files">{review.files.map(item => <li className="er-import__file" key={item.path}><span>{item.path}</span><span>{item.digestPrefix}</span><span>{number(item.bytes)}</span></li>)}</ul>
        <dl className="er-import__facts"><div className="er-import__fact"><dt>{copy.review_total}</dt><dd>{number(review.totalBytes)}</dd></div>
          <div className="er-import__fact"><dt>{copy.review_identity}</dt><dd>{review.idempotencyKey}</dd></div>
          {review.operationId && <div className="er-import__fact"><dt>{copy.review_operation}</dt><dd>{review.operationId}</dd></div>}
        </dl>
        {!uncertain && !busy && !bundle?.receipt && props.onRunBundle && <>
          <label><input type="checkbox" checked={confirmedReview === review && active} onChange={event => setConfirmedReview(event.target.checked ? review : undefined)} /> {copy.review_intro}</label>
          <Button disabled={confirmedReview !== review || !active} onClick={() => { if (confirmedReview === review && active) { setConfirmedReview(undefined); props.onRunBundle?.(); } }}>{copy.run}</Button>
        </>}
      </>}
      {bundle?.uncertain && <Status>{copy.unknown_bundle}</Status>}
      {bundle?.interrupted && <Status>{copy.interrupted}</Status>}
      {bundle?.progress && <Status>{`${copy.phase}: ${bundle.progress.phase} · ${number(bundle.progress.bytes)} / ${number(bundle.progress.total)}`}</Status>}
      {committed && <Status icon="check">{copy.committed}</Status>}
      <div className="er-import__actions">
        {busy && props.onStopBundle && <Button variant="text" onClick={props.onStopBundle}>{copy.stop}</Button>}
        {props.onInspectBundle && <Button variant="tonal" onClick={props.onInspectBundle}>{copy.inspect}</Button>}
        {!uncertain && !busy && props.onDisposeBundle && <Button variant="text" onClick={props.onDisposeBundle}>{copy.dispose}</Button>}
      </div>
    </div>}
  </section>;
}
