import { useEffect, useId, useRef, useState } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Dialog, Field, ImportFlow, IMPORT_FLOW_COPY, type ImportFileState, type ImportBundleState, type ImportFlowBundleReview, type ImportFlowView } from '@eliotr/ui';
import type { BrowserBundle, BrowserBundleImport, ImportIdentity, RawFileSelection, RawMarkdownConversionRequest, SourceNamespaceCatalog } from '@eliotr/owner-api-client';
import { classifyMutationOutcome, RAW_MARKDOWN_MAX_OUTPUT_BYTES, RAW_MARKDOWN_MAX_TOKENS, RAW_MARKDOWN_TIMEOUT_MS } from '@eliotr/owner-api-client';
import type { BoundWorkspaceApis } from './runtime';
import { isWorkspaceRequestError } from './runtime';
import type { PrivacyController, SessionContext } from './privacy';
import { OperationFeedback } from './OperationFeedback';
import { importActions } from '../query/imports';
import { protectedQueryKey, runProtectedRead } from '../query/client';
import { useCanonicalCommitReport } from './canonicalCommit';

/**
 * Terminality comes from the accepted status contract, never from COMMITTED alone.
 *
 * PREPARING, UPLOAD_REQUIRED, VERIFIED, AUTHORIZED and PROMOTED are nonterminal and keep the original
 * attempt identity locked. An unknown or absent state is nonterminal for the same reason: a missing
 * status is not evidence of terminality. A network failure, a malformed identity or an unknown
 * settlement therefore never releases the local attempt.
 */
const BUNDLE_TERMINAL_STATES = new Set(['COMMITTED', 'REJECTED', 'QUARANTINED']);
function isTerminalBundleState(state: string | undefined): boolean {
  return state !== undefined && BUNDLE_TERMINAL_STATES.has(state);
}

/**
 * The identity a committed attempt is deduplicated by, so one accepted commit reports once.
 *
 * The bundle identity carries the canonical operation and the raw admission carries its own operation.
 * Both are frozen when the local attempt is written, so a reconciliation or a repeated status read
 * resolves to the same key. No caller identity, network attempt or click timestamp participates, and
 * nothing reports while the outcome is uncertain, rejected or quarantined.
 */
function bundleCommitKey(memory: ImportMemory): string | undefined {
  const identity = memory.identity, status = memory.bundleState?.status, receipt = status?.receipt;
  if (identity && status?.state === 'COMMITTED' && receipt &&
    receipt.operation_id === identity.operation && receipt.manifest_sha256 === identity.manifestDigest &&
    receipt.source_revision_ref === identity.sourceRevision && ['ADMITTED', 'DUPLICATE'].includes(receipt.decision)) {
    return 'bundle:' + identity.generation + ':' + identity.operation;
  }
  const admission = memory.file?.admission;
  if (admission?.state === 'COMMITTED' && admission.admission_receipt &&
    ['ADMITTED', 'DUPLICATE'].includes(admission.admission_receipt.decision)) {
    return 'admission:' + admission.admission_operation_id;
  }
  return undefined;
}

interface ImportMemory {
  readonly selection?: RawFileSelection;
  readonly file?: ImportFileState;
  readonly request?: RawMarkdownConversionRequest;
  readonly bundle?: BrowserBundle;
  readonly attempt?: BrowserBundleImport;
  readonly review?: ImportFlowBundleReview;
  readonly identity?: ImportIdentity;
  readonly bundleState?: ImportBundleState;
  readonly submitted?: boolean;
  readonly admissionRejected?: boolean;
  readonly bundleRejected?: boolean;
}
const copy = {
  en: { working: 'Checking the current import step.', prepared: 'The selected file is ready for capture.', captured: 'The exact file was captured.', converted: 'Processing finished. Review the captured file.', admitted: 'The source was added to the Library.', rejected: 'The source was not admitted. Review its saved status.', bundleReady: 'The exact bundle files are ready for review.', bundleCommitted: 'The import is committed with a verified receipt.', unknown: 'The import step is unresolved. Check the same request before continuing.', namespaces: 'Workspaces loaded.', namespaceError: 'Workspaces could not be loaded.', open: 'Import sources', close: 'Back to sources', workspace: 'Save the file in', choose: 'Choose a workspace', read: 'Refresh workspaces', options: 'Choose processing limits', size: 'Maximum result size (bytes)', tokens: 'Maximum processing tokens', timeout: 'Time limit (milliseconds)', review: 'Review processing options', waiting: 'Choose each limit before processing. No request is selected automatically.', error: 'The last step could not be verified. Check its saved status before starting again.' },
  ru: { working: 'Проверяем текущий шаг импорта.', prepared: 'Выбранный файл готов к захвату.', captured: 'Точный файл захвачен.', converted: 'Обработка завершена. Проверьте захваченный файл.', admitted: 'Источник добавлен в библиотеку.', rejected: 'Источник не допущен. Проверьте сохранённый статус.', bundleReady: 'Точные файлы набора готовы к проверке.', bundleCommitted: 'Импорт завершён и подтверждён проверенной квитанцией.', unknown: 'Исход шага импорта не определён. Проверьте тот же запрос перед продолжением.', namespaces: 'Рабочие области прочитаны.', namespaceError: 'Не удалось прочитать рабочие области.', open: 'Импортировать источники', close: 'Вернуться к источникам', workspace: 'Сохранить файл в', choose: 'Выберите рабочую область', read: 'Обновить рабочие области', options: 'Выбрать ограничения обработки', size: 'Максимальный размер результата (байт)', tokens: 'Максимум токенов обработки', timeout: 'Ограничение времени (миллисекунды)', review: 'Проверить параметры обработки', waiting: 'Укажите каждое ограничение перед обработкой. Запрос не выбирается автоматически.', error: 'Последний шаг не удалось проверить. Прочитайте сохранённый статус перед повторным действием.' },
} as const;
const withoutUncertainty = (file: ImportFileState | undefined) => {
  const { uncertain: _uncertain, ...rest } = file ?? { phase: 'useful' as const };
  return rest;
};

/** Protected, memory-only recovery. Closing a sheet never creates a replacement operation. */
export function ImportPanel({ apis, privacy, context, locale, onImportCommitted }: {
  readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController; readonly context: SessionContext; readonly locale: 'en' | 'ru';
  readonly onImportCommitted?: () => void;
}) {
  const client = useQueryClient(), key = [...protectedQueryKey(context, 'imports'), 'local-intent'];
  // One report is emitted per canonical committed identity, deduplicated by the original admission
  // operation or the bundle operation identity.
  const commitReport = useCanonicalCommitReport(onImportCommitted);
  const memory = useQuery<ImportMemory>({ queryKey: key, queryFn: skipToken, gcTime: Infinity });
  const namespaceKey = [...protectedQueryKey(context, 'imports'), 'namespaces'];
  const actions = importActions(apis.sources, privacy, context, () => client.getQueryData<SourceNamespaceCatalog>(namespaceKey));
  const [open, setOpen] = useState(false), [view, setView] = useState<ImportFlowView>('file');
  const [namespace, setNamespace] = useState(''), [selectedFile, setSelectedFile] = useState<File>();
  const [files, setFiles] = useState<readonly File[]>([]);
  const [size, setSize] = useState(''), [tokens, setTokens] = useState(''), [timeout, setTimeoutValue] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const operation = useRef<AbortController | undefined>(undefined), mounted = useRef(true), running = useRef(false);
  const selectId = useId(), text = copy[locale];
  const namespaces = useQuery({ ...actions.namespaces, enabled: open });
  const read = () => client.getQueryData<ImportMemory>(key) ?? {};
  const write = (update: (old: ImportMemory) => ImportMemory) => {
    if (privacy.isCurrent(context)) client.setQueryData<ImportMemory>(key, old => update(old ?? {}));
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current?.abort(); };
  }, []);
  const run = (action: (signal: AbortSignal) => Promise<void>, failure: (error: unknown) => void) => {
    if (running.current || !privacy.isCurrent(context)) return;
    running.current = true; operation.current = new AbortController();
    const signal = operation.current.signal; setBusy(true); setError(false);
    void action(signal).catch(error => { if (privacy.isCurrent(context)) { failure(error); if (mounted.current) setError(true); } })
      .finally(() => { running.current = false; if (mounted.current) setBusy(false); });
  };
  const capture = () => {
    const saved = read();
    if (!saved.selection || saved.file?.receipt || saved.file?.uncertain) return;
    const selection = saved.selection;
    // A synchronous uncertainty fence precedes dispatch, including a lost acknowledgement.
    write(old => ({ ...old, file: { ...old.file, phase: 'loading', uncertain: 'capture' } }));
    run(async signal => { const receipt = await actions.capture(selection, signal); write(old => ({ ...old, file: { phase: 'useful', receipt } })); },
      () => write(old => ({ ...old, file: { ...old.file, phase: 'degraded', uncertain: 'capture' } })));
  };
  const reconcileCapture = () => {
    const selection = read().selection; if (!selection) return;
    run(async signal => {
      const receipt = await actions.recoverCapture(selection, signal);
      write(old => ({ ...old, file: receipt ? { phase: 'useful', receipt } : { phase: 'useful' } }));
    }, () => write(old => ({ ...old, file: { ...old.file, phase: 'degraded', uncertain: 'capture' } })));
  };
  const convert = (request: RawMarkdownConversionRequest) => {
    const saved = read(); if (!saved.file?.receipt || saved.request !== request) return;
    const receipt = saved.file.receipt;
    write(old => ({ ...old, file: { ...old.file, phase: 'loading', uncertain: 'conversion' } }));
    run(async signal => {
      const conversion = await actions.convert(receipt, request, signal);
      write(old => ({ ...old, file: { ...withoutUncertainty(old.file), phase: conversion.state === 'UNKNOWN' || conversion.state === 'STARTED' ? 'degraded' : conversion.state === 'FAILED' ? 'error' : 'useful', conversion,
        ...(conversion.state === 'UNKNOWN' || conversion.state === 'STARTED' ? { uncertain: 'conversion' } : {}) } }));
    }, () => write(old => ({ ...old, file: { ...old.file, phase: 'degraded', uncertain: 'conversion' } })));
  };
  const admit = () => {
    const saved = read(); if (!saved.file?.receipt || saved.file.conversion?.state !== 'COMPLETE') return;
    const receipt = saved.file.receipt, conversion = saved.file.conversion, priorAdmission = saved.file.admission;
    write(old => ({ ...old, admissionRejected: false, file: { ...old.file, phase: 'loading', uncertain: 'admission' } }));
    run(async signal => {
      const admission = priorAdmission
        ? await actions.admissionStatus(receipt, conversion, priorAdmission.admission_operation_id, signal)
        : await actions.admit(receipt, conversion, signal);
      write(old => ({ ...old, file: { ...withoutUncertainty(old.file), phase: admission.state === 'COMMITTED' ? 'useful' : 'degraded', admission,
        ...(admission.state === 'COMMITTED' || admission.state === 'REJECTED' || admission.state === 'QUARANTINED' ? {} : { uncertain: 'admission' }) } }));
    }, error => {
      // Classify before touching any protected intent. The admission POST is the only step whose
      // pre-effect refusal is provable, so a repeated status read never reclassifies as a refusal.
      const refused = !priorAdmission && isWorkspaceRequestError(error) &&
        classifyMutationOutcome({ operation: 'import.raw.admit', code: error.code, status: error.status, dispatched: true }).clearsIntent;
      write(old => refused
        ? { ...old, admissionRejected: true, file: { ...withoutUncertainty(old.file), phase: 'error' } }
        : { ...old, file: { ...old.file, phase: 'degraded', uncertain: 'admission' } });
    });
  };
  const saved = memory.data ?? {};
  // The report derives from the committed identity itself, so an admission reconciliation or a repeated
  // status read cannot report the same canonical commit twice. Nothing reports while the outcome is
  // uncertain, BLOCKED, rejected or quarantined.
  const committedKey = bundleCommitKey(saved);
  useEffect(() => {
    if (committedKey !== undefined) commitReport(committedKey);
  }, [commitReport, committedKey]);
  const fileState = saved.file;
  const phase = busy ? 'loading' : fileState?.phase ?? 'useful';
  const canChooseAnotherFile = saved.selection !== undefined && saved.file?.uncertain === undefined &&
    (saved.file?.conversion === undefined || saved.file.conversion.state === 'FAILED' ||
      saved.admissionRejected === true || saved.file.admission?.state === 'COMMITTED' || saved.file.admission?.state === 'REJECTED' || saved.file.admission?.state === 'QUARANTINED');
  const clearFile = () => {
    if (running.current || !canChooseAnotherFile || !privacy.isCurrent(context)) return;
    write(old => {
      const { selection: _selection, file: _file, request: _request, admissionRejected: _admissionRejected, ...rest } = old;
      return rest;
    });
    setSelectedFile(undefined); setSize(''); setTokens(''); setTimeoutValue('');
  };
  // Terminality follows the accepted status contract, not COMMITTED alone. An unsaved bundle is still
  // freely replaceable. Once submitted, the attempt is released only by the owner's explicit
  // acknowledgement after a canonical terminal readback; the terminal reason and receipt stay visible
  // until then, so a REJECTED or QUARANTINED outcome is never silently dropped and an uncertain
  // outcome never releases anything.
  const bundleTerminal = isTerminalBundleState(saved.bundleState?.status?.state);
  const canDismissBundle = saved.bundle !== undefined && (bundleTerminal || saved.bundleRejected === true) &&
    saved.bundleState?.interrupted !== true;
  const clearBundle = () => {
    if (running.current || !canDismissBundle || !privacy.isCurrent(context)) return;
    const current = read();
    if (!current.bundle || !(isTerminalBundleState(current.bundleState?.status?.state) || current.bundleRejected === true) || current.bundleState?.interrupted) return;
    current.attempt?.dispose();
    // Disposal is exactly once: the shared attempt object is released and the local memory entry is
    // removed. No replacement attempt is minted and no re-run is scheduled.
    write(old => {
      const { bundle: _bundle, attempt: _attempt, review: _review, identity: _identity, bundleState: _bundleState, submitted: _submitted, bundleRejected: _bundleRejected, ...rest } = old;
      return rest;
    });
    setFiles([]);
  };
  const inspectBundle = () => {
    const intent = read(); if (!intent.identity && !intent.bundle) return;
    run(async signal => {
      const recovered = !intent.identity && intent.bundle ? await actions.discoverBundle(intent.bundle, signal) : undefined;
      const identity = intent.identity ?? recovered?.identity; if (!identity || identity.generation !== context.deploymentGeneration) throw new Error('Import generation changed');
      if (recovered) write(old => ({ ...old, identity, attempt: recovered.attempt }));
      const status = await actions.bundleStatus(identity, signal);
      write(old => ({ ...old, bundleState: { ...old.bundleState, phase: status.state === 'COMMITTED' ? 'useful' : 'degraded', status,
        ...(status.receipt ? { receipt: status.receipt } : {}), uncertain: !isTerminalBundleState(status.state), interrupted: false } }));
    }, () => write(old => ({ ...old, bundleState: { ...old.bundleState, phase: 'degraded', uncertain: true } })));
  };
  const refused = view === 'bundle' ? saved.bundleRejected : saved.admissionRejected;
  const refusedText = locale === 'ru'
    ? 'Запрос импорта отклонён до выполнения. Проверьте исходные данные и доступ перед продолжением.'
    : 'The import request was refused before execution. Review the input and access before continuing.';
  const operationMessage = busy ? text.working : refused ? refusedText : error ? text.error
    : view === 'bundle' ? saved.bundleState?.uncertain ? text.unknown
      : saved.bundleState?.status?.state === 'COMMITTED' && saved.bundleState.receipt ? text.bundleCommitted
      : saved.review ? text.bundleReady : ''
    : fileState?.uncertain ? text.unknown
    : fileState?.admission?.state === 'COMMITTED' ? text.admitted
    : fileState?.admission?.state === 'REJECTED' || fileState?.admission?.state === 'QUARANTINED' ? text.rejected
    : fileState?.conversion?.state === 'COMPLETE' ? text.converted
    : fileState?.conversion?.state === 'FAILED' ? text.error
    : fileState?.receipt ? text.captured : saved.selection ? text.prepared
    : namespaces.isFetching ? text.working : namespaces.isError ? text.namespaceError : namespaces.data ? text.namespaces : '';
  return <>
    <Button variant="tonal" onClick={() => setOpen(true)}>{text.open}</Button>
    <Dialog open={open} title={text.open} onClose={() => setOpen(false)}>
      {open && <OperationFeedback key={view} message={operationMessage} />}
      {view === 'file' && !saved.selection && <div className="er-live-import-settings">
        <label className="er-field__label" htmlFor={selectId}>{text.workspace}</label>
        <select className="er-field__control" id={selectId} value={namespace} onChange={event => setNamespace(event.target.value)} disabled={busy}>
          <option value="">{text.choose}</option>
          {namespaces.data?.namespaces.map(item => <option key={item.source_namespace_id} value={item.source_namespace_id}>{item.title}</option>)}
        </select>
        {namespaces.isError && <Button variant="text" onClick={() => { void namespaces.refetch(); }}>{text.read}</Button>}
      </div>}
      {error && <p>{refused ? refusedText : text.error}</p>}
      <ImportFlow locale={locale} copy={IMPORT_FLOW_COPY[locale]} view={view} active={open} onViewChange={busy ? undefined : setView}
        fileState={{ ...fileState, phase }} bundleState={busy && view === 'bundle' ? { ...saved.bundleState, phase: 'loading' } : saved.bundleState}
        bundleReview={saved.review} conversionRequest={saved.request} selectionName={saved.selection?.original_file_name ?? selectedFile?.name}
        onSelectFile={!saved.selection ? setSelectedFile : undefined}
        onPrepareFile={selectedFile && namespace && namespaces.data && !saved.selection ? () => {
          const file = selectedFile, catalog = namespaces.data; if (!catalog) return;
          run(async signal => { const selection = await actions.prepare(file, catalog, namespace, signal); write(old => ({ ...old, selection, file: { phase: 'useful' } })); }, () => {});
        } : undefined}
        onCapture={saved.selection && !saved.file?.uncertain && !saved.file?.receipt ? capture : undefined}
        onRecoverCapture={saved.selection && saved.file?.uncertain === 'capture' ? reconcileCapture : undefined}
        onConvert={convert} onReconcileConversion={saved.request && saved.file?.uncertain === 'conversion' ? () => { const request = read().request; if (request) convert(request); } : undefined}
        onRetryConvert={saved.file?.conversion?.state === 'FAILED' && saved.request ? operationId => {
          const previous = read(); if (previous.file?.conversion?.state !== 'FAILED' || previous.file.conversion.operation_id !== operationId || !previous.file.receipt || !previous.request) return;
          const receipt = previous.file.receipt, request = previous.request;
          run(async signal => { const idempotency_key = await actions.conversionKey(receipt, signal, operationId);
            write(old => ({ ...old, request: { ...request, idempotency_key }, file: { phase: 'useful', receipt } })); }, () => {});
        } : undefined}
        onAdmit={admit} onAdmissionStatus={saved.file?.admission || saved.file?.uncertain === 'admission' ? admit : undefined}
        onSelectBundle={!saved.bundle ? setFiles : undefined}
        onPrepareBundle={files.length && !saved.bundle ? () => {
          run(async signal => {
            const bundle = await actions.prepareBundle(files, signal); const idempotencyKey = apis.sources.mintIntent();
            const attempt = apis.sources.imports.bundle.createBrowserBundleImport(bundle, idempotencyKey);
            write(old => ({ ...old, bundle, attempt, review: { files: bundle.files.map(file => ({ path: file.path, bytes: file.bytes.byteLength, digestPrefix: bundle.hashes[file.path]?.slice(0, 12) ?? '' })), totalBytes: bundle.totalBytes, idempotencyKey }, bundleState: { phase: 'useful' } }));
          }, () => {});
        } : undefined}
        onRunBundle={saved.attempt && !saved.submitted ? () => {
          const intent = read(); if (!intent.attempt || intent.submitted || running.current) return;
          const attempt = intent.attempt;
          let mutationFinished = false;
          write(old => ({ ...old, submitted: true, bundleState: { phase: 'loading', uncertain: true } }));
          run(async signal => {
            const receipt = await runProtectedRead(privacy, context, signal, selectedSignal => attempt.run({ signal: selectedSignal,
              onIdentity(identity) { if (!privacy.isCurrent(context) || identity.generation !== context.deploymentGeneration) throw new Error('Import generation changed'); write(old => ({ ...old, identity })); },
              onProgress(progress) { write(old => ({ ...old, bundleState: { ...old.bundleState, phase: 'loading', progress } })); },
            }));
            mutationFinished = true;
            const identity = read().identity;
            if (!identity || !receipt) { write(old => ({ ...old, bundleState: { ...old.bundleState, phase: 'degraded', uncertain: true } })); return; }
            const status = await actions.bundleStatus(identity, signal);
            write(old => ({ ...old, bundleState: { ...old.bundleState, phase: status.state === 'COMMITTED' ? 'useful' : 'degraded', receipt, status, uncertain: !isTerminalBundleState(status.state), interrupted: false } }));
          }, error => {
            // A local refusal proves the request never left the browser, so the held attempt is
            // released. Once any part of the composite import has taken effect, the owned identity
            // must survive the failure for a same-identity status read.
            const rejected = !mutationFinished && isWorkspaceRequestError(error) &&
              classifyMutationOutcome({ operation: 'import.bundle.import', code: error.code, status: error.status, dispatched: true }).clearsIntent;
            write(old => rejected
              ? { ...old, bundleRejected: true, bundleState: { ...old.bundleState, phase: 'error', uncertain: false, interrupted: false } }
              : { ...old, bundleState: { ...old.bundleState, phase: 'degraded', uncertain: true, interrupted: operation.current?.signal.aborted ?? false } });
          });
        } : undefined}
        onInspectBundle={!saved.bundleRejected && (saved.identity || saved.bundle && saved.submitted) ? inspectBundle : undefined} onStopBundle={busy ? () => operation.current?.abort() : undefined}
        onDisposeBundle={canDismissBundle ? clearBundle : undefined}
      />
      {view === 'file' && saved.file?.receipt && !saved.request && !saved.file.conversion && <form className="er-live-import-settings" onSubmit={event => {
        event.preventDefault(); const values = [Number(size), Number(tokens), Number(timeout)];
        if (!values.every(value => Number.isSafeInteger(value) && value > 0)) return;
        if (Number(size) > RAW_MARKDOWN_MAX_OUTPUT_BYTES || Number(tokens) > RAW_MARKDOWN_MAX_TOKENS || Number(timeout) > RAW_MARKDOWN_TIMEOUT_MS) return;
        const receipt = read().file?.receipt; if (!receipt) return;
        run(async signal => { const idempotency_key = await actions.conversionKey(receipt, signal);
          write(old => ({ ...old, request: { idempotency_key, max_output_bytes: Number(size), max_tokens: Number(tokens), timeout_ms: Number(timeout) } })); }, () => {});
      }}>
        <h3>{text.options}</h3><p>{text.waiting}</p>
        <Field label={text.size} type="number" min={1} max={RAW_MARKDOWN_MAX_OUTPUT_BYTES} required value={size} onChange={event => setSize(event.target.value)} />
        <Field label={text.tokens} type="number" min={1} max={RAW_MARKDOWN_MAX_TOKENS} required value={tokens} onChange={event => setTokens(event.target.value)} />
        <Field label={text.timeout} type="number" min={1} max={RAW_MARKDOWN_TIMEOUT_MS} required value={timeout} onChange={event => setTimeoutValue(event.target.value)} />
        <Button type="submit" variant="tonal" loading={busy}>{text.review}</Button>
      </form>}
      {view === 'file' && canChooseAnotherFile && !busy && <Button variant="text" onClick={clearFile}>{locale === 'ru' ? 'Выбрать другой файл' : 'Choose another file'}</Button>}
      <Button variant="text" onClick={() => setOpen(false)}>{text.close}</Button>
    </Dialog>
  </>;
}
