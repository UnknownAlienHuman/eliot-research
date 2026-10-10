import { queryOptions } from '@tanstack/react-query';
import { BROWSER_BUNDLE_LIMITS } from '@eliotr/owner-api-client';
import type { BrowserBundle, ImportIdentity, RawFileSelection, RawFileCaptureReceipt, RawMarkdownConversionRequest, RawMarkdownConversionResult, SourceNamespaceCatalog } from '@eliotr/owner-api-client';
import type { BoundWorkspaceApis } from '../app/runtime';
import type { PrivacyController, SessionContext } from '../app/privacy';
import { protectedQueryKey, runProtectedRead } from './client';

/** Same-identity reconciliation shares the explicit original request; no automatic request is selected. */
export function importActions(apis: BoundWorkspaceApis['sources'], privacy: PrivacyController, context: SessionContext,
  currentNamespaces: () => SourceNamespaceCatalog | undefined) {
  const read = <T>(signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>) => runProtectedRead(privacy, context, signal, action);
  const generation = context.deploymentGeneration;
  return {
    namespaces: queryOptions({ queryKey: [...protectedQueryKey(context, 'imports'), 'namespaces'], retry: false,
      queryFn: ({ signal }) => read(signal, selectedSignal => apis.namespaces.readSourceNamespaces(generation, selectedSignal)) }),
    prepare(file: File, catalog: SourceNamespaceCatalog, namespace: string, signal: AbortSignal) {
      const guard = () => { if (currentNamespaces() !== catalog || catalog.deployment_generation !== generation || !catalog.namespaces.some(item => item.source_namespace_id === namespace)) throw new Error('Import workspace is no longer current'); };
      return read(signal, async selectedSignal => {
        guard(); const selection = await apis.imports.raw.prepareRawFileSelection(file, selectedSignal, namespace); guard(); return selection;
      });
    },
    capture: (selection: RawFileSelection, signal: AbortSignal) => read(signal, selectedSignal => apis.imports.raw.captureRawFile(selection, generation, selectedSignal)),
    recoverCapture: (selection: RawFileSelection, signal: AbortSignal) => read(signal, selectedSignal => apis.imports.raw.readRawFileByIdempotency(selection, generation, selectedSignal)),
    conversionKey: (capture: RawFileCaptureReceipt, signal: AbortSignal, terminalOperation?: string) => read(signal, () => apis.imports.raw.createRawMarkdownIdempotencyKey(capture, terminalOperation)),
    convert: (capture: RawFileCaptureReceipt, request: RawMarkdownConversionRequest, signal: AbortSignal) => read(signal, selectedSignal => apis.imports.raw.convertRawFileToMarkdown(capture, request, generation, selectedSignal)),
    admit: (capture: RawFileCaptureReceipt, conversion: RawMarkdownConversionResult, signal: AbortSignal) => read(signal, selectedSignal => apis.imports.raw.admitRawFileToLibrary(capture, conversion, generation, selectedSignal)),
    admissionStatus: (capture: RawFileCaptureReceipt, conversion: RawMarkdownConversionResult, operationId: string, signal: AbortSignal) => read(signal, selectedSignal => apis.imports.raw.readRawFileAdmissionStatus(capture, conversion, operationId, generation, selectedSignal)),
    prepareBundle: (files: readonly File[], signal: AbortSignal) => read(signal, async selectedSignal => {
      if (files.length < 3 || files.length > BROWSER_BUNDLE_LIMITS.files || files.some(file => file.size < 1 || file.size > BROWSER_BUNDLE_LIMITS.file_bytes) || files.reduce((total, file) => total + file.size, 0) > BROWSER_BUNDLE_LIMITS.total_bytes) throw new Error('Selected bundle exceeds the browser import profile');
      // Flat picker paths remain exact. A real directory picker may provide webkitRelativePath.
      const input = await Promise.all(files.map(async file => ({ path: file.webkitRelativePath || file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
      if (selectedSignal.aborted) throw new Error('Import preparation stopped');
      return apis.imports.input.prepareBrowserBundle(input, selectedSignal);
    }),
    recoverBundle: (input: BrowserBundle, operationId: string, signal: AbortSignal) => read(signal, selectedSignal => apis.imports.bundle.recoverBrowserBundleImport(input, operationId, { signal: selectedSignal })),
    discoverBundle: (input: BrowserBundle, signal: AbortSignal) => read(signal, selectedSignal => apis.imports.bundle.discoverBrowserBundleImport(input, { signal: selectedSignal })),
    bundleStatus: (identity: ImportIdentity, signal: AbortSignal) => read(signal, async selectedSignal => {
      const response = await apis.imports.wire.importCall(`/api/v1/ingest/bundles/${encodeURIComponent(identity.operation)}`, { method: 'GET', signal: selectedSignal }, identity.generation);
      return apis.imports.wire.decodeImportStatus(response.data, identity);
    }),
  };
}
