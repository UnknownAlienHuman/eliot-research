// Adapted from apps/eliotr-web/src/app/ChatModelPicker.tsx and model-selection.css
// at 7c034569b908d3b03a8b821b7c537477a24b10f7. Copyright (c) 2026 ELIOT Project, MIT.
// Pair-key codec also from apps/eliotr-web/src/query/modelCatalog.ts at the same pin.
// Provider/search/paging/controlled selection only; no donor runtime/qualification/key handling.
import { useId, useState } from 'react';
import { MaterialSymbol } from './ui/MaterialSymbol';
import './model-picker.css';

export interface ModelRoute {
  readonly route: string;
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly label: string;
  readonly enabled: boolean;
  readonly unavailableReason?: string | null;
  readonly provider?: string;
  readonly contextTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly outputReserveTokens?: number;
  readonly inputMicrousdPerMillion: number | null;
  readonly cachedMicrousdPerMillion: number | null;
  readonly outputMicrousdPerMillion: number | null;
  readonly checkedOn: string | null;
}

function providerId(model: ModelRoute): string {
  return (model.route.startsWith('gateway:')
    ? model.route.slice('gateway:'.length).split('/')[0] : model.route.split(':')[0]) ?? '';
}
function providerLabel(model: ModelRoute): string {
  const provider = model.provider ?? providerId(model);
  if (provider === 'workers-ai') return 'Workers AI';
  if (provider === 'openrouter') return 'OpenRouter';
  if (provider === 'command-code') return 'Command Code';
  return provider || 'Unknown provider';
}
function optionLabel(model: ModelRoute): string {
  return model.label + (model.enabled ? '' : ' — unavailable');
}
export function modelCatalogEntryKey(model: ModelRoute): string {
  const provider = providerId(model);
  return `${provider.length}:${provider}${model.id}`;
}
function capacity(value: number | null): string {
  return value == null ? 'Unknown' : value.toLocaleString('en-US') + ' tokens';
}
function price(value: number | null): string {
  return value == null ? 'Unknown' : new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6,
  }).format(value / 1000000);
}

export function ModelPicker({ label, choices, value, onChange, emptyLabel, loading = false, error = '', onReload }: {
  readonly label: string;
  readonly choices: readonly ModelRoute[];
  readonly value: string;
  readonly onChange: (route: string) => void;
  readonly emptyLabel?: string;
  readonly loading?: boolean;
  readonly error?: string;
  readonly onReload?: () => void;
}) {
  const id = useId();
  const [search, setSearch] = useState('');
  const [provider, setProvider] = useState('');
  const [page, setPage] = useState(1);
  const matches = (route: string) => choices.filter((model) => model.route === route || model.aliases?.includes(route));
  const selectedMatches = value === '' ? [] : matches(value);
  const selected = selectedMatches.length === 1 ? selectedMatches[0] : undefined;
  const keyCounts = new Map<string, number>();
  const providers = new Map<string, string>();
  for (const model of choices) {
    const key = modelCatalogEntryKey(model);
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    providers.set(providerId(model), providerLabel(model));
  }
  const identityIssue = (model: ModelRoute) => keyCounts.get(modelCatalogEntryKey(model)) !== 1 || matches(model.route).length !== 1;
  const selectedIssue = selected && identityIssue(selected) ? 'Catalogue identity is ambiguous.'
    : selected && !selected.enabled ? selected.unavailableReason || 'Model is unavailable.' : null;
  const terms = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = choices.filter((model) => {
    if (provider !== '' && providerId(model) !== provider) return false;
    const haystack = (model.label + ' ' + model.route + ' ' + (model.id ?? '') + ' ' + providerLabel(model)).toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * 50, currentPage * 50);
  const groups = new Map<string, ModelRoute[]>();
  for (const model of visible) {
    const provider = providerLabel(model);
    const group = groups.get(provider);
    if (group) group.push(model); else groups.set(provider, [model]);
  }
  const selectedVisible = visible.some((model) => model.route === value);
  const bound = selected?.outputReserveTokens ?? selected?.maxOutputTokens ?? null;
  const jobOutput = bound !== null && selected?.maxOutputTokens != null ? Math.min(bound, selected.maxOutputTokens) : bound;
  return (
    <div className='er-models__row'>
      <label className='er-models__label' htmlFor={id + '-select'}>{label}</label>
      <div className='er-model-picker'>
        <div className='er-model-picker__chip'>
          <MaterialSymbol name='spark' />
          <select id={id + '-select'} value={value} title={selected ? selected.label + ' · ' + providerLabel(selected) : value || emptyLabel || 'Choose a model'}
            disabled={loading || error !== '' || (choices.length === 0 && value === '')}
            onChange={(event) => {
              const route = event.currentTarget.value;
              if (route === '' && emptyLabel !== undefined) onChange('');
              else {
                const candidates = matches(route);
                const candidate = candidates.length === 1 ? candidates[0] : undefined;
                if (candidate?.enabled && !identityIssue(candidate)) onChange(route);
              }
            }}>
            <option value='' disabled={emptyLabel === undefined}>{emptyLabel ?? 'Choose a model'}</option>
            {value !== '' && !selectedVisible ? <option value={value} disabled={!selected || selectedIssue !== null}>
              {selected ? optionLabel(selected) + (selected.route !== value ? ' — saved selection' : '') : value + ' — unavailable'}
            </option> : null}
            {[...groups].map(([provider, rows]) => <optgroup key={provider} label={provider}>
              {rows.map((model, index) => <option key={identityIssue(model) ? modelCatalogEntryKey(model) + ':' + index : modelCatalogEntryKey(model)} value={model.route}
                disabled={!model.enabled || identityIssue(model)}
                title={identityIssue(model) ? 'Catalogue identity is ambiguous.' : model.unavailableReason || model.route}>{optionLabel(model)}</option>)}
            </optgroup>)}
          </select>
        </div>
        <details className='er-model-picker__find'>
          <summary>Find a model</summary>
          <label className='er-model-picker__search' htmlFor={id + '-provider'}>
            <span>Provider</span>
            <select id={id + '-provider'} aria-label={label + ': provider'} value={provider}
              onChange={(event) => { setProvider(event.currentTarget.value); setPage(1); }}>
              <option value=''>All providers</option>
              {provider !== '' && !providers.has(provider) ? <option value={provider} disabled>{provider} — unavailable</option> : null}
              {[...providers].map(([key, name]) => <option key={key} value={key}>{name}</option>)}
            </select>
          </label>
          <label className='er-model-picker__search' htmlFor={id + '-search'}>
            <span>Search models</span>
            <input id={id + '-search'} type='search' aria-label={label + ': search models'} value={search} maxLength={512}
              onChange={(event) => { setSearch(event.currentTarget.value); setPage(1); }} />
          </label>
          <p className='er-status' role='status'><span>{filtered.length === 0 ? 'No models match your search.' : filtered.length.toLocaleString('en-US') + ' matching models.'}</span></p>
          <nav className='er-model-picker__pages' aria-label={label + ': model pages'}>
            <button className='er-button er-button--text' type='button' disabled={loading || currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous models</button>
            <span>{currentPage} / {pageCount}</span>
            <button className='er-button er-button--text' type='button' disabled={loading || currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>More models</button>
          </nav>
          {onReload && error === '' ? <button className='er-button er-button--text' type='button' disabled={loading} onClick={onReload}>Reload catalog</button> : null}
        </details>
        {loading ? <p className='er-status' role='status'><span>Loading model catalog…</span></p> : null}
        {error !== '' ? <p className='er-status er-status--error' role='alert'><span>{error}</span>{onReload ? <button className='er-button er-button--text' type='button' onClick={onReload}>Reload catalog</button> : null}</p> : null}
        {!loading && error === '' && value !== '' && !selected ? <p className='er-status er-status--error' role='alert'><span>{selectedMatches.length > 1 ? 'Selected model alias is ambiguous' : 'Selected model is missing from the current catalog'}: {value}.</span></p> : null}
        {selectedIssue !== null ? <p className='er-status er-status--error' role='alert'><span>Selected model is unavailable: {selectedIssue}</span></p> : null}
        {selected ? <details className='er-models__details'>
          <summary>Model details</summary>
          <p className='er-status'><span>{selected.label} — context {capacity(selected.contextTokens)}, max output {capacity(selected.maxOutputTokens)}. Output bound per job: {capacity(jobOutput)}. {price(selected.inputMicrousdPerMillion)} in / {price(selected.cachedMicrousdPerMillion)} cached / {price(selected.outputMicrousdPerMillion)} out per 1M tokens. Catalog checked: {selected.checkedOn || 'Unknown'}.</span></p>
          <p className='er-model-picker__identity'>{selected.route}</p>
        </details> : null}
      </div>
    </div>
  );
}
