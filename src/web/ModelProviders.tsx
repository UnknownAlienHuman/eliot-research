// K2 provider configuration editor. Owner edits stored provider routing;
// Save writes D1 only via PUT /api/models/providers and never refreshes
// the catalogue or starts a model job. Root mounts this inside Settings.

import { useEffect, useId, useRef, useState } from 'react';
import type { ModelProvider } from '../models';
import { isOpenRouterApiBase, type DataCollectionPolicy } from '../shared/api';
import './model-providers.css';

export interface ModelProvidersProps {
  readonly drafts: Draft[] | null;
  readonly onChange: (drafts: Draft[]) => void;
  readonly quotas?: Readonly<Record<string, string | null>>;
  readonly fieldErrors?: Readonly<Record<number, string>>;
  readonly disabled?: boolean;
}

export interface Draft {
  isNew: boolean;
  id: string;
  type: 'workers-ai' | 'openai-compatible';
  baseUrl: string;
  gatewaySlug: string;
  gatewayPath: string;
  enabled: boolean;
  modelsUrl: string;
  metadataUrl: string;
  dataCollection: DataCollectionPolicy;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PATH_RE = /^(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/;
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  'workers-ai': 'Workers AI',
  openrouter: 'OpenRouter',
  'command-code': 'Command Code',
  kilo: 'Kilo',
  nous: 'Nous Portal',
  'opencode-go': 'OpenCode Go',
};

function providerName(id: string): string {
  if (id === '' || id === 'new-provider') return 'New provider';
  return PROVIDER_NAMES[id] ?? id;
}

export function toDraft(p: ModelProvider): Draft {
  return { isNew: false, id: p.id, type: p.type, baseUrl: p.baseUrl ?? '', gatewaySlug: p.gatewaySlug ?? '', gatewayPath: p.gatewayPath, enabled: p.enabled, modelsUrl: p.modelsUrl ?? '', metadataUrl: p.metadataUrl ?? '', dataCollection: p.dataCollection ?? 'deny' };
}

export function validateDrafts(drafts: Draft[]): { providers: ModelProvider[] | null; errors: Record<number, string> } {
  const errors: Record<number, string> = {};
  const seen = new Set<string>();
  const out: ModelProvider[] = [];
  drafts.forEach((d, i) => {
    const id = d.id.trim();
    if (!ID_RE.test(id)) { errors[i] = 'Use a provider ID: lowercase letters, numbers, dashes.'; }
    else if (seen.has(id)) { errors[i] = 'Each provider ID must be unique.'; }
    seen.add(id);
    if (d.type === 'workers-ai') {
      if (id !== 'workers-ai') errors[i] = 'The native provider ID is workers-ai.';
      out.push({ id: 'workers-ai', type: 'workers-ai', baseUrl: null, gatewaySlug: null, gatewayPath: '', enabled: d.enabled });
      return;
    }
    if (id === 'workers-ai') errors[i] = 'workers-ai is reserved for the native provider.';
    const baseUrl = d.baseUrl.trim();
    const gatewaySlug = d.gatewaySlug.trim();
    const gatewayPath = d.gatewayPath.trim();
    let url: URL | null;
    try { url = baseUrl === '' ? null : new URL(baseUrl); } catch { url = null; }
    if (baseUrl === '' || url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || !ID_RE.test(gatewaySlug)) {
      errors[i] = 'Use a provider HTTPS base URL without credentials, query or fragment, plus a gateway slug.';
    }
    if (!PATH_RE.test(gatewayPath)) errors[i] = 'Use an optional path prefix such as v1, or leave blank.';
    const base: ModelProvider = { id, type: 'openai-compatible', baseUrl: baseUrl === '' ? null : baseUrl, gatewaySlug: gatewaySlug === '' ? null : gatewaySlug, gatewayPath, enabled: d.enabled };
    const modelsUrl = d.modelsUrl.trim();
    if (modelsUrl !== '') base.modelsUrl = modelsUrl;
    const metadataUrl = d.metadataUrl.trim();
    if (metadataUrl !== '') base.metadataUrl = metadataUrl;
    if (isOpenRouterApiBase(baseUrl)) base.dataCollection = d.dataCollection;
    out.push(base);
  });
  return { providers: Object.keys(errors).length > 0 ? null : out, errors };
}

export function ModelProviders({ drafts, onChange, quotas, fieldErrors = {}, disabled = false }: ModelProvidersProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const dialogTitleId = useId();
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const selectedDraft = editingIndex === null ? null : drafts?.[editingIndex] ?? null;
  const selectedFieldError = editingIndex === null ? undefined : fieldErrors[editingIndex];
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (editingIndex === null) {
      if (dialog.open) dialog.close();
    } else if (!dialog.open) {
      dialog.showModal();
    }
  }, [editingIndex]);

  function update(index: number, patch: Partial<Draft>): void {
    if (drafts === null || disabled) return;
    onChange(drafts.map((d, i) => {
      if (i !== index) return d;
      const next: Draft = { ...d, ...patch };
      if (patch.type === 'workers-ai') { next.id = 'workers-ai'; next.baseUrl = ''; next.gatewaySlug = ''; next.gatewayPath = ''; next.modelsUrl = ''; next.metadataUrl = ''; next.dataCollection = 'deny'; }
      return next;
    }));
  }
  function addProvider(): void {
    if (drafts === null || disabled) return;
    const newIndex = drafts.length;
    onChange([...drafts, { isNew: true, id: 'new-provider', type: 'openai-compatible', baseUrl: '', gatewaySlug: '', gatewayPath: 'v1', enabled: false, modelsUrl: '', metadataUrl: '', dataCollection: 'deny' }]);
    setEditingIndex(newIndex);
  }
  function removeProvider(index: number): void {
    if (drafts === null || disabled) return;
    onChange(drafts.filter((_, i) => i !== index));
  }

  function closeConnectionDetails(): void {
    if (dialogRef.current?.open) dialogRef.current.close();
    setEditingIndex(null);
  }

  function removeSelectedProvider(): void {
    if (editingIndex === null) return;
    removeProvider(editingIndex);
    closeConnectionDetails();
  }

  if (drafts === null) return <p className="er-status" role="status"><span>Loading providers…</span></p>;
  return (
    <div className="er-providers">
      <h3 className="er-providers__title">Providers</h3>
      {drafts.length === 0 ? <p className="er-status"><span>No providers configured.</span></p> : null}
      <ul className="er-providers__list">
        {drafts.map((d, i) => {
          const quota = quotas?.[d.id] ?? null;
          return (
            <li key={i} className="er-card er-providers__item">
              <div className="er-providers__summary">
                <h3 className="er-providers__id">{providerName(d.id)}</h3>
                <label className="er-providers__check">
                  <input type="checkbox" aria-label={'Enable ' + providerName(d.id)} disabled={disabled} checked={d.enabled} onChange={(e) => update(i, { enabled: e.currentTarget.checked })} />
                  <span className="er-providers__checktext">Enabled</span>
                </label>
                {typeof quota === 'string' && quota !== '' ? <p className="er-providers__quota">{quota}</p> : null}
                <button className="er-button er-button--text er-providers__connection" type="button" disabled={disabled}
                  aria-label={'Connection details for ' + providerName(d.id)} onClick={() => setEditingIndex(i)}>Connection</button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="er-providers__actions">
        <button className="er-button er-button--text" type="button" disabled={disabled} onClick={() => addProvider()}>Add provider</button>
      </div>
      <dialog className="er-dialog er-providers__dialog" ref={dialogRef} aria-labelledby={dialogTitleId}
        onClose={() => setEditingIndex(null)}>
        {selectedDraft !== null && editingIndex !== null ? (
          <>
            <h2 className="er-dialog__title" id={dialogTitleId}>Connection details — {providerName(selectedDraft.id)}</h2>
            <div className="er-dialog__body er-providers__dialog-body">
              <div className="er-providers__fields">
                <label className="er-field er-providers__row">
                  <span className="er-providers__label">Type</span>
                  <select value={selectedDraft.type} disabled={disabled} onChange={(e) => update(editingIndex, { type: e.currentTarget.value as Draft['type'] })}>
                    <option value="workers-ai">Workers AI</option>
                    <option value="openai-compatible">OpenAI compatible</option>
                  </select>
                </label>
                <label className="er-field er-providers__row">
                  <span className="er-providers__label">Provider ID</span>
                  <input value={selectedDraft.id} onChange={(e) => update(editingIndex, { id: e.currentTarget.value })} autoComplete="off"
                    disabled={disabled || selectedDraft.type === 'workers-ai'} aria-invalid={selectedFieldError !== undefined} />
                </label>
                {selectedDraft.type === 'workers-ai' ? (
                  <p className="er-status"><span>Uses the existing native binding.</span></p>
                ) : (
                  <>
                    <label className="er-field er-providers__row">
                      <span className="er-providers__label">Provider address</span>
                      <input type="url" inputMode="url" value={selectedDraft.baseUrl} onChange={(e) => update(editingIndex, { baseUrl: e.currentTarget.value })} placeholder="https://" autoComplete="off" disabled={disabled} aria-invalid={selectedFieldError !== undefined} />
                    </label>
                    <label className="er-field er-providers__row">
                      <span className="er-providers__label">Gateway provider slug</span>
                      <input value={selectedDraft.gatewaySlug} onChange={(e) => update(editingIndex, { gatewaySlug: e.currentTarget.value })} placeholder="custom-command-code" autoComplete="off" disabled={disabled} aria-invalid={selectedFieldError !== undefined} />
                    </label>
                    <label className="er-field er-providers__row">
                      <span className="er-providers__label">Path prefix</span>
                      <input value={selectedDraft.gatewayPath} onChange={(e) => update(editingIndex, { gatewayPath: e.currentTarget.value })} placeholder="v1" autoComplete="off" disabled={disabled} aria-invalid={selectedFieldError !== undefined} />
                    </label>
                    {isOpenRouterApiBase(selectedDraft.baseUrl) ? (
                      <label className="er-field er-providers__row">
                        <span className="er-providers__label">Data use</span>
                        <select value={selectedDraft.dataCollection} disabled={disabled} onChange={(e) => update(editingIndex, { dataCollection: e.currentTarget.value as Draft['dataCollection'] })}>
                          <option value="deny">Disallow collection (default)</option>
                          <option value="allow">Allow collection</option>
                        </select>
                      </label>
                    ) : null}
                    <p className="er-providers__help">Provider credentials stay in Cloudflare. Do not enter keys here.</p>
                  </>
                )}
              </div>
              {selectedFieldError !== undefined ? <p className="er-status er-status--error" role="alert"><span>{selectedFieldError}</span></p> : null}
              <div className="er-providers__dialog-actions">
                <button className="er-button er-button--text" type="button" disabled={disabled} onClick={removeSelectedProvider}>Remove provider</button>
                <button className="er-button er-button--primary" type="button" onClick={closeConnectionDetails}>Done</button>
              </div>
            </div>
          </>
        ) : null}
      </dialog>
    </div>
  );
}
