/** ImportFlow — U3-I props-only feature.
 *
 * No transport, factory, store, Query client, file hashing or persistence. Local UI state only;
 * every remote value arrives as a remote DTO prop and every action is an explicit callback.
 *
 * The root decides how steps advance. With `automatic`, the owner only picks a file: the root runs
 * capture, processing and Library admission itself and this feature shows one progress list; every
 * step still keeps its own uncertainty and recovery action. Without it the step buttons render.
 *
 * Bundle import is one honest stage. `attempt.run()` performs prepare, upload and commit in a
 * single call, so the review gate renders the frozen bytes before that call and the panel claims
 * no separate commit step. Completion requires a COMMITTED status bound to a receipt.
 */
import { useId, useState } from "react";
import { Button, Field, Status } from "../../../primitives/primitives";
import { MaterialSymbol } from "../../../catalog/MaterialSymbol";
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
  readonly drop_title: string;
  readonly auto_hint: string;
  readonly step_upload: string;
  readonly step_process: string;
  readonly step_library: string;
  readonly added: string;
  readonly details: string;
}

export interface ImportFlowProps {
  readonly accessibleName?: string | undefined;
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
  readonly onSelectFiles?: ((files: readonly File[]) => void) | undefined;
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
  /** The root advances the file steps by itself; the owner only picks the file. */
  readonly automatic?: boolean | undefined;
  /** While true the automatic chain is moving, so the current step reads as in progress. */
  readonly working?: boolean | undefined;
}

const EN_COPY: ImportFlowCopy = {
  title: "Add a source",
  file_tab: "Single file",
  bundle_tab: "Saved bundle",
  file_hint: "Choose one file. Eliot uploads it, turns it into text and adds it to the Library.",
  bundle_hint: "Choose the files of a saved bundle. Eliot checks them and imports them in one go.",
  choose_file: "Choose a file",
  choose_bundle: "Choose bundle files",
  recovery_id: "Operation ID from a previous upload",
  prepare: "Review the selected file",
  prepare_bundle: "Review bundle files",
  capture: "Capture the selected file",
  recover_capture: "Check the previous capture",
  convert: "Process the captured file",
  convert_unavailable: "Processing has not started yet.",
  retry_convert: "Try processing again",
  reconcile_conversion: "Check processing status",
  admit: "Add to Library",
  admit_status: "Check Library status",
  review_intro: "Review the exact bytes below before anything is uploaded.",
  review_files: "Frozen files",
  review_total: "Size",
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
  unknown_conversion: "Not sure whether processing finished. Check its status.",
  unknown_admission: "Library admission outcome is unknown. Check the same admission identity again.",
  unknown_bundle: "Not sure whether the import finished. Check its status.",
  interrupted: "Stopped before it finished. Requests already sent may have completed.",
  missing_request: "Processing has not started yet.",
  not_complete: "Processing must be complete before the file can be added to Library.",
  committed: "Committed with a verified receipt.",
  loading: "Loading import state…",
  drop_title: "Choose a file or drop it here",
  auto_hint: "Eliot uploads it, turns it into text and adds it to the Library by itself.",
  step_upload: "Upload",
  step_process: "Turn into text",
  step_library: "Add to the Library",
  added: "The source is in the Library.",
  details: "Details",
};

const RU_COPY: ImportFlowCopy = {
  title: "Добавить источник",
  file_tab: "Один файл",
  bundle_tab: "Сохранённая подборка",
  file_hint: "Выберите файл. Eliot загрузит его, переведёт в текст и добавит в библиотеку.",
  bundle_hint: "Выберите файлы сохранённой подборки. Eliot проверит их и импортирует за один раз.",
  choose_file: "Выберите файл",
  choose_bundle: "Выберите файлы подборки",
  recovery_id: "Идентификатор операции предыдущей загрузки",
  prepare: "Проверить выбранный файл",
  prepare_bundle: "Проверить файлы подборки",
  capture: "Загрузить выбранный файл",
  recover_capture: "Проверить загрузку",
  convert: "Перевести в текст",
  convert_unavailable: "Обработка ещё не началась.",
  retry_convert: "Повторить обработку",
  reconcile_conversion: "Проверить статус обработки",
  admit: "Добавить в библиотеку",
  admit_status: "Проверить статус в библиотеке",
  review_intro: "Проверьте файлы ниже до отправки.",
  review_files: "Файлы подборки",
  review_total: "Размер",
  review_identity: "Идентификатор импорта",
  review_operation: "Операция",
  run: "Начать импорт",
  stop: "Остановить отправку",
  inspect: "Проверить статус импорта",
  dispose: "Очистить этот импорт",
  captured_at: "Загружен",
  conversion_state: "Обработка",
  admission_state: "Библиотека",
  source_revision: "Ревизия источника",
  phase: "Прогресс",
  unknown_heading: "Не удалось подтвердить последний шаг. Проверьте его, прежде чем продолжать.",
  unknown_conversion: "Не ясно, закончилась ли обработка. Проверьте статус.",
  unknown_admission: "Не ясно, добавлен ли источник в библиотеку. Проверьте статус.",
  unknown_bundle: "Не ясно, закончился ли импорт. Проверьте статус.",
  interrupted: "Остановлено до завершения. Уже отправленные запросы могли завершиться.",
  missing_request: "Обработка ещё не началась.",
  not_complete: "Сначала файл должен быть переведён в текст.",
  committed: "Импорт подтверждён.",
  loading: "Загрузка состояния импорта…",
  drop_title: "Выберите файл или перетащите его сюда",
  auto_hint: "Eliot сам загрузит его, переведёт в текст и добавит в библиотеку.",
  step_upload: "Загрузка",
  step_process: "Перевод в текст",
  step_library: "Добавление в библиотеку",
  added: "Источник добавлен в библиотеку.",
  details: "Подробности",
};

export const IMPORT_FLOW_COPY = { en: EN_COPY, ru: RU_COPY } as const;

type StepState = "done" | "active" | "todo" | "attention";

/** The automatic file chain as three owner-facing steps; a problem marks its step, never a later one. */
function fileSteps(file: ImportFileState | undefined, working: boolean): readonly [StepState, StepState, StepState] {
  const captured = file?.receipt !== undefined;
  const converted = file?.conversion?.state === "COMPLETE";
  const admitted = file?.admission?.state === "COMMITTED";
  const upload: StepState = captured ? "done" : file?.uncertain === "capture" ? "attention" : working ? "active" : "todo";
  const process: StepState = converted ? "done"
    : file?.conversion?.state === "FAILED" || (file?.uncertain === "conversion" && !working) ? "attention"
      : captured && working ? "active" : "todo";
  const library: StepState = admitted ? "done"
    : file?.admission?.state === "REJECTED" || file?.admission?.state === "QUARANTINED" || (file?.uncertain === "admission" && !working) ? "attention"
      : converted && working ? "active" : "todo";
  return [upload, process, library];
}

const STEP_ICON: Record<StepState, "check" | "pending" | "error" | "document"> = {
  done: "check", active: "pending", attention: "error", todo: "document",
};

function formatSize(locale: ImportFlowLocale, bytes: number): string {
  const units = locale === "ru" ? ["Б", "КБ", "МБ", "ГБ"] : ["B", "KB", "MB", "GB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale === "ru" ? "ru-RU" : "en-US", { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

export function ImportFlow(props: ImportFlowProps) {
  const fileInputId = useId(), bundleInputId = useId();
  const { copy } = props, locale = props.locale ?? "en", view = props.view ?? "file";
  const file = props.fileState, bundle = props.bundleState, review = props.bundleReview;
  const [confirmedReview, setConfirmedReview] = useState<ImportFlowBundleReview>();
  const active = props.active !== false, busy = file?.phase === "loading" || bundle?.phase === "loading";
  const automatic = props.automatic === true && view === "file";
  const working = automatic && (props.working === true || file?.phase === "loading");
  // Each view answers for its own outcome: an unsettled file step never hides the bundle picker.
  const uncertain = view === "file"
    ? file?.uncertain !== undefined || file?.conversion?.state === "UNKNOWN"
    : bundle?.uncertain === true || bundle?.interrupted === true;
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
  return <section className="er-import" lang={locale} aria-label={props.accessibleName ?? copy.title}>
    <header className="er-import__head"><h2 className="er-import__title">{copy.title}</h2>
      {props.onViewChange && <div className="er-import__tabs">
        <Button variant={view === "file" ? "tonal" : "text"} onClick={() => props.onViewChange?.("file")}>{copy.file_tab}</Button>
        <Button variant={view === "bundle" ? "tonal" : "text"} onClick={() => props.onViewChange?.("bundle")}>{copy.bundle_tab}</Button>
      </div>}
    </header>
    {automatic ? null : <p className="er-import__hint">{view === "file" ? copy.file_hint : copy.bundle_hint}</p>}
    {busy && !automatic && <Status icon="search">{copy.loading}</Status>}
    {view === "file" ? <div className="er-import__review">
      {automatic && !uncertain && !capture && !props.selectionName && props.onSelectFile ? <label className="er-import__drop" htmlFor={fileInputId}>
        <span className="er-import__drop-glyph" aria-hidden="true"><MaterialSymbol name="upload" /></span>
        <span className="er-import__drop-title">{props.onSelectFiles
          ? locale === 'ru' ? 'Выберите файлы или перетащите их сюда' : 'Choose files or drop them here'
          : copy.drop_title}</span>
        <span className="er-import__drop-hint">{props.onSelectFiles
          ? locale === 'ru' ? 'Eliot обрабатывает до двух файлов одновременно. Для каждого сохраняется свой результат.'
            : 'Eliot processes up to two files at a time and keeps each file’s outcome.'
          : copy.auto_hint}</span>
        <input id={fileInputId} type="file" multiple={props.onSelectFiles !== undefined} disabled={busy} aria-label={copy.choose_file}
          onChange={event => { const selected = Array.from(event.target.files ?? []); if (selected.length > 0 && props.onSelectFiles) props.onSelectFiles(selected); else if (selected[0]) props.onSelectFile?.(selected[0]); event.target.value = ""; }} />
      </label> : null}
      {!automatic && !uncertain && !capture && props.onSelectFile && <label className="er-import__picker er-button er-button--tonal" htmlFor={fileInputId}>
        <span>{copy.choose_file}</span>
        <input id={fileInputId} type="file" multiple={props.onSelectFiles !== undefined} disabled={busy}
          onChange={event => { const selected = Array.from(event.target.files ?? []); if (selected.length > 0 && props.onSelectFiles) props.onSelectFiles(selected); else if (selected[0]) props.onSelectFile?.(selected[0]); event.target.value = ""; }} />
      </label>}
      {automatic && (props.selectionName || capture) ? <div className="er-import__progress">
        <p className="er-import__file-row">
          <span className="er-import__file-glyph" aria-hidden="true"><MaterialSymbol name="document" /></span>
          <span className="er-import__file-name">{capture?.original_file_name ?? props.selectionName}</span>
          {capture ? <span className="er-import__file-size">{formatSize(locale, capture.size_bytes)}</span> : null}
        </p>
        <ol className="er-import__steps">
          {fileSteps(file, working).map((state, index) => <li key={index} className="er-import__step" data-state={state}>
            <span className="er-import__step-glyph" aria-hidden="true"><MaterialSymbol name={STEP_ICON[state]} /></span>
            <span>{[copy.step_upload, copy.step_process, copy.step_library][index]}</span>
            {index === 1 && file?.conversion && file.conversion.state !== "COMPLETE"
              ? <span className="er-import__step-note">{conversionLabel(file.conversion.state)}</span> : null}
          </li>)}
        </ol>
        {file?.admission?.state === "COMMITTED" ? <Status icon="check">{copy.added}</Status> : null}
      </div> : null}
      {!automatic && props.selectionName && !capture && <p className="er-import__note">{props.selectionName}</p>}
      {!automatic && capture && <dl className="er-import__facts">
        <div className="er-import__fact"><dt>{copy.choose_file}</dt><dd>{capture.original_file_name}</dd></div>
        <div className="er-import__fact"><dt>{copy.review_total}</dt><dd>{number(capture.size_bytes)}</dd></div>
        <div className="er-import__fact"><dt>{copy.captured_at}</dt><dd>{capture.captured_at}</dd></div>
      </dl>}
      {file?.uncertain === "capture" && <Status>{copy.unknown_heading}</Status>}
      {(file?.uncertain === "conversion" || file?.conversion?.state === "UNKNOWN") && <Status>{copy.unknown_conversion}</Status>}
      {file?.uncertain === "admission" && <Status>{copy.unknown_admission}</Status>}
      {file?.interrupted && <Status>{copy.interrupted}</Status>}
      {file?.conversion && !automatic && <dl className="er-import__facts"><div className="er-import__fact"><dt>{copy.conversion_state}</dt><dd>{conversionLabel(file.conversion.state)}</dd></div></dl>}
      {file?.admission && !automatic && <dl className="er-import__facts">
        <div className="er-import__fact"><dt>{copy.admission_state}</dt><dd>{file.admission.state}</dd></div>
        <div className="er-import__fact"><dt>{copy.source_revision}</dt><dd>{file.admission.source_revision_ref}</dd></div>
      </dl>}
      {file?.admission && automatic && <details className="er-import__details"><summary>{copy.details}</summary><dl className="er-import__facts">
        <div className="er-import__fact"><dt>{copy.admission_state}</dt><dd>{file.admission.state}</dd></div>
        <div className="er-import__fact"><dt>{copy.source_revision}</dt><dd>{file.admission.source_revision_ref}</dd></div>
        {capture ? <div className="er-import__fact"><dt>{copy.captured_at}</dt><dd>{capture.captured_at}</dd></div> : null}
      </dl></details>}
      {!automatic && capture && !props.conversionRequest && !file?.conversion && <p className="er-import__note">{copy.convert_unavailable}</p>}
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
