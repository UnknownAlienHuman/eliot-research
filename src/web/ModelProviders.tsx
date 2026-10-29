// K2 provider configuration editor. Owner edits stored provider routing;
// Save writes D1 only via PUT /api/models/providers and never refreshes
// the catalogue or starts a model job. Root mounts this inside Settings.

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
    onChange([...drafts, { isNew: true, id: 'new-provider', type: 'openai-compatible', baseUrl: '', gatewaySlug: '', gatewayPath: 'v1', enabled: true, modelsUrl: '', metadataUrl: '', dataCollection: 'deny' }]);
  }
  function removeProvider(index: number): void {
    if (drafts === null || disabled) return;
    onChange(drafts.filter((_, i) => i !== index));
  }





  if (drafts === null) return <p className="er-status" role="status"><span>Loading providers…</span></p>;
  return (
    <div className="er-providers">
      <h3 className="er-providers__title">Providers</h3>
      {drafts.length === 0 ? <p className="er-status"><span>No providers configured.</span></p> : null}
      <ul className="er-providers__list">
        {drafts.map((d, i) => {
          const quota = quotas?.[d.id] ?? null;
          const quotaText = typeof quota === 'string' && quota !== '' ? quota : 'Quota unknown';
          const fieldError = fieldErrors[i];
          return (
            <li key={i} className="er-card er-providers__item">
              <div className="er-providers__summary">
                <h3 className="er-providers__id"><span>{d.id === '' ? 'Unnamed provider' : d.id}</span></h3>
                <p className="er-providers__type"><span>{d.type === 'workers-ai' ? 'Workers AI (native)' : 'OpenAI compatible'}</span></p>
                <label className="er-providers__check">
                  <input type="checkbox" disabled={disabled} checked={d.enabled} onChange={(e) => update(i, { enabled: e.currentTarget.checked })} />
                  <span className="er-providers__checktext">Enabled</span>
                </label>
                <p className="er-providers__quota"><span>{quotaText}</span></p>
              </div>
              <details className="er-providers__details" open={d.isNew}>
                <summary>Connection details</summary>
                <div className="er-providers__fields">
                  <label className="er-field er-providers__row">
                    <span className="er-providers__label">Type</span>
                    <select value={d.type} disabled={disabled} onChange={(e) => update(i, { type: e.currentTarget.value as Draft['type'] })}>
                      <option value="workers-ai">Workers AI (native)</option>
                      <option value="openai-compatible">OpenAI compatible</option>
                    </select>
                  </label>
                  <label className="er-field er-providers__row">
                    <span className="er-providers__label">ID</span>
                    <input value={d.id} onChange={(e) => update(i, { id: e.currentTarget.value })} autoComplete="off" disabled={disabled || d.type === 'workers-ai'} aria-invalid={fieldError !== undefined} />
                  </label>
                  {d.type === 'workers-ai' ? (
                    <p className="er-status"><span>Native binding.</span></p>
                  ) : (
                    <>
                      <label className="er-field er-providers__row">
                        <span className="er-providers__label">Base URL<span className="er-providers__help">Provider HTTPS base URL, no keys.</span></span>
                        <input type="url" inputMode="url" value={d.baseUrl} onChange={(e) => update(i, { baseUrl: e.currentTarget.value })} placeholder="https://" autoComplete="off" disabled={disabled} aria-invalid={fieldError !== undefined} />
                      </label>
                      <label className="er-field er-providers__row">
                        <span className="er-providers__label">Gateway provider slug<span className="er-providers__help">Routing slug, e.g. custom-command-code. Not the Gateway ID.</span></span>
                        <input value={d.gatewaySlug} onChange={(e) => update(i, { gatewaySlug: e.currentTarget.value })} placeholder="custom-command-code" autoComplete="off" disabled={disabled} aria-invalid={fieldError !== undefined} />
                      </label>
                      <label className="er-field er-providers__row">
                        <span className="er-providers__label">Path prefix<span className="er-providers__help">Optional path prefix, e.g. v1. Blank for none.</span></span>
                        <input value={d.gatewayPath} onChange={(e) => update(i, { gatewayPath: e.currentTarget.value })} placeholder="v1" autoComplete="off" disabled={disabled} aria-invalid={fieldError !== undefined} />
                      </label>
                      {isOpenRouterApiBase(d.baseUrl) ? (
                        <label className="er-field er-providers__row">
                          <span className="er-providers__label">Data use<span className="er-providers__help">Allow permits providers that may retain inputs or use them for training; account settings can add restrictions.</span></span>
                          <select value={d.dataCollection} disabled={disabled} onChange={(e) => update(i, { dataCollection: e.currentTarget.value as Draft['dataCollection'] })}>
                            <option value="deny">Disallow collection (default)</option>
                            <option value="allow">Allow collection</option>
                          </select>
                        </label>
                      ) : null}
                    </>
                  )}
                  <div className="er-providers__actions">
                    <button className="er-button er-button--text" type="button" disabled={disabled} onClick={() => removeProvider(i)}>Remove</button>
                  </div>
                </div>
              </details>
              {fieldError !== undefined ? <p className="er-status er-status--error" role="alert"><span>{fieldError}</span></p> : null}
            </li>
          );
        })}
      </ul>
      <div className="er-providers__actions">
        <button className="er-button er-button--text" type="button" disabled={disabled} onClick={() => addProvider()}>Add provider</button>
      </div>
    </div>
  );
}
