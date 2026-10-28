// K2 provider registry editor. Owner edits stored provider routing;
// Save writes D1 only via PUT /api/models/providers and never refreshes
// the catalogue or starts a model job. Root mounts this inside Settings.
import { useEffect, useRef, useState } from 'react';
import type { ModelProvider } from '../models';
import './model-providers.css';

export interface ModelProvidersProps {
  readonly quotas?: Readonly<Record<string, string | null>>;
  readonly onSaved?: (providers: ModelProvider[]) => void;
}

interface Draft {
  isNew: boolean;
  id: string;
  type: 'workers-ai' | 'openai-compatible';
  baseUrl: string;
  gatewaySlug: string;
  gatewayPath: string;
  enabled: boolean;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PATH_RE = /^(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/;

async function apiErrorMessage(res: Response): Promise<string> {
  try {
    const b = (await res.json()) as { error?: { message?: string } };
    if (b.error && b.error.message) return b.error.message;
  } catch { /* status text */ }
  return 'Request failed with status ' + res.status + '.';
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (res.ok) return (await res.json()) as T;
  throw new Error(await apiErrorMessage(res));
}

function toDraft(p: ModelProvider): Draft {
  return { isNew: false, id: p.id, type: p.type, baseUrl: p.baseUrl ?? '', gatewaySlug: p.gatewaySlug ?? '', gatewayPath: p.gatewayPath, enabled: p.enabled };
}

function validateDrafts(drafts: Draft[]): { providers: ModelProvider[] | null; errors: Record<number, string> } {
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
    out.push({ id, type: 'openai-compatible', baseUrl: baseUrl === '' ? null : baseUrl, gatewaySlug: gatewaySlug === '' ? null : gatewaySlug, gatewayPath, enabled: d.enabled });
  });
  return { providers: Object.keys(errors).length > 0 ? null : out, errors };
}

export function ModelProviders({ quotas, onSaved }: ModelProvidersProps) {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<number, string>>({});
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    let live = true;
    const gen = ++generation.current;
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void apiJson<{ providers: ModelProvider[] }>('/api/models/providers', { signal: controller.signal })
      .then((d) => { if (!live || generation.current !== gen) return; setDrafts(d.providers.map(toDraft)); })
      .catch((err: unknown) => {
        if (!live || generation.current !== gen) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setDrafts(null);
        setLoadError(err instanceof Error ? err.message : 'Could not load providers.');
      })
      .finally(() => { if (live && generation.current === gen) setLoading(false); });
    return () => { live = false; controller.abort(); generation.current++; };
  }, []);
  function update(index: number, patch: Partial<Draft>): void {
    setDrafts((prev) => {
      if (prev === null) return prev;
      return prev.map((d, i) => {
        if (i !== index) return d;
        const next: Draft = { ...d, ...patch };
        if (patch.type === 'workers-ai') { next.id = 'workers-ai'; next.baseUrl = ''; next.gatewaySlug = ''; next.gatewayPath = ''; }
        return next;
      });
    });
  }
  function addProvider(): void {
    setFieldErrors({});
    setNote('');
    setDrafts((prev) => [...(prev ?? []), { isNew: true, id: 'new-provider', type: 'openai-compatible', baseUrl: '', gatewaySlug: '', gatewayPath: 'v1', enabled: true }]);
  }
  function removeProvider(index: number): void {
    setFieldErrors({});
    setNote('');
    setDrafts((prev) => (prev ?? []).filter((_, i) => i !== index));
  }
  async function save(): Promise<void> {
    if (drafts === null || saving) return;
    const checked = validateDrafts(drafts);
    setFieldErrors(checked.errors);
    if (checked.providers === null) { setNote('Check the highlighted fields.'); return; }
    setNote('');
    setSaving(true);
    try {
      const d = await apiJson<{ providers: ModelProvider[] }>('/api/models/providers', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers: checked.providers }) });
      setDrafts(d.providers.map(toDraft));
      setFieldErrors({});
      setNote('Saved.');
      onSaved?.(d.providers);
    } catch (err) { setNote(err instanceof Error ? err.message : 'Could not save providers.'); }
    finally { setSaving(false); }
  }
  if (loading) return <p className="er-status" role="status"><span>Loading providers…</span></p>;
  if (loadError !== '') return <p className="er-status er-status--error" role="alert"><span>{loadError}</span></p>;
  if (drafts === null) return <p className="er-status er-status--error" role="alert"><span>Providers are unavailable.</span></p>;
  return (
    <div className="er-providers">
      <div className="er-providers__head">
        <h2 className="er-providers__title">Providers</h2>
        <p className="er-status"><span>Stored routing only. Save writes settings.</span></p>
      </div>
      {drafts.length === 0 ? <p className="er-status"><span>No providers configured.</span></p> : null}
      <ul className="er-providers__list">
        {drafts.map((d, i) => {
          const quota = quotas?.[d.id] ?? null;
          const quotaText = typeof quota === 'string' && quota !== '' ? quota : 'Quota unknown';
          const fieldError = fieldErrors[i];
          return (
            <li key={i} className="er-providers__item">
              <div className="er-providers__summary">
                <h3 className="er-providers__id"><span>{d.id === '' ? 'Unnamed provider' : d.id}</span></h3>
                <p className="er-providers__type"><span>{d.type === 'workers-ai' ? 'Workers AI (native)' : 'OpenAI compatible'}</span></p>
                <label className="er-providers__check">
                  <input type="checkbox" checked={d.enabled} onChange={(e) => update(i, { enabled: e.currentTarget.checked })} />
                  <span className="er-providers__checktext">Enabled</span>
                </label>
                <p className="er-providers__quota"><span>{quotaText}</span></p>
              </div>
              <details className="er-providers__details" open={d.isNew}>
                <summary>Connection details</summary>
                <div className="er-providers__fields">
                  <label className="er-providers__row">
                    <span className="er-providers__label">Type</span>
                    <select value={d.type} onChange={(e) => update(i, { type: e.currentTarget.value as Draft['type'] })}>
                      <option value="workers-ai">Workers AI (native)</option>
                      <option value="openai-compatible">OpenAI compatible</option>
                    </select>
                  </label>
                  <label className="er-providers__row">
                    <span className="er-providers__label">ID</span>
                    <input value={d.id} onChange={(e) => update(i, { id: e.currentTarget.value })} autoComplete="off" disabled={d.type === 'workers-ai'} aria-invalid={fieldError !== undefined} />
                  </label>
                  {d.type === 'workers-ai' ? (
                    <p className="er-status"><span>Native binding.</span></p>
                  ) : (
                    <>
                      <label className="er-providers__row">
                        <span className="er-providers__label">Base URL<span className="er-providers__help">Provider HTTPS base URL, no keys.</span></span>
                        <input type="url" inputMode="url" value={d.baseUrl} onChange={(e) => update(i, { baseUrl: e.currentTarget.value })} placeholder="https://" autoComplete="off" aria-invalid={fieldError !== undefined} />
                      </label>
                      <label className="er-providers__row">
                        <span className="er-providers__label">Gateway provider slug<span className="er-providers__help">Routing slug, e.g. custom-command-code. Not the Gateway ID.</span></span>
                        <input value={d.gatewaySlug} onChange={(e) => update(i, { gatewaySlug: e.currentTarget.value })} placeholder="custom-command-code" autoComplete="off" aria-invalid={fieldError !== undefined} />
                      </label>
                      <label className="er-providers__row">
                        <span className="er-providers__label">Path prefix<span className="er-providers__help">Optional path prefix, e.g. v1. Blank for none.</span></span>
                        <input value={d.gatewayPath} onChange={(e) => update(i, { gatewayPath: e.currentTarget.value })} placeholder="v1" autoComplete="off" aria-invalid={fieldError !== undefined} />
                      </label>
                    </>
                  )}
                  <div className="er-providers__actions">
                    <button className="er-button er-button--text" type="button" onClick={() => removeProvider(i)}>Remove</button>
                  </div>
                </div>
              </details>
              {fieldError !== undefined ? <p className="er-status er-status--error" role="alert"><span>{fieldError}</span></p> : null}
            </li>
          );
        })}
      </ul>
      <div className="er-providers__actions">
        <button className="er-button er-button--text" type="button" onClick={addProvider}>Add provider</button>
        <button className="er-button er-button--primary" type="button" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save providers'}
        </button>
        {note !== '' ? <p className="er-status" role="status"><span>{note}</span></p> : null}
      </div>
    </div>
  );
}
