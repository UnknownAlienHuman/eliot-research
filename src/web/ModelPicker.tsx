// Adapted from apps/eliotr-web/src/app/ChatModelPicker.tsx and model-selection.css
// at 7c034569b908d3b03a8b821b7c537477a24b10f7. Copyright (c) 2026 ELIOT Project, MIT.
// Pair-key codec also from apps/eliotr-web/src/query/modelCatalog.ts at the same pin.
// Provider/search display-only filtering with controlled selection; no donor
// runtime/qualification/key handling, no pricing output, no paging.
// Selection metadata is context/output tokens only.
import { useEffect, useId, useRef, useState } from 'react';
import { MaterialSymbol } from './ui/MaterialSymbol';
import './model-picker.css';

export interface ModelRoute {
  readonly route: string;
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly unavailableReason?: string | null;
  readonly provider?: string;
  readonly contextTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly mayTrainOnYourPrompts?: boolean;
  readonly outputReserveTokens?: number;
  readonly checkedOn: string | null;
}

function providerId(model: ModelRoute): string {
  return model.route.startsWith('gateway:')
    ? model.route.slice('gateway:'.length).split('/')[0] ?? ''
    : model.route.split(':')[0] ?? '';
}
function routeProviderId(route: string): string {
  return route.startsWith('gateway:')
    ? route.slice('gateway:'.length).split('/')[0] ?? ''
    : route.split(':')[0] ?? '';
}
function providerLabel(model: ModelRoute): string {
  const provider = model.provider ?? providerId(model);
  if (provider === 'workers-ai') return 'Workers AI';
  if (provider === 'openrouter') return 'OpenRouter';
  if (provider === 'command-code') return 'Command Code';
  return provider || 'Unknown provider';
}
function optionLabel(model: ModelRoute): string {
  return model.label
    + (model.mayTrainOnYourPrompts === true ? ' — may train on your prompts' : '')
    + (model.enabled ? '' : ' — unavailable');
}
export function modelCatalogEntryKey(model: ModelRoute): string {
  const provider = providerId(model);
  return `${provider.length}:${provider}${model.id}`;
}

export function ModelPicker({ label, choices, value, onChange, emptyLabel, defaultRoute, loading = false, error = '',
  compact = false, warnings = [], onRoutePendingChange }: {
  readonly label: string;
  readonly choices: readonly ModelRoute[];
  readonly value: string;
  readonly onChange: (route: string) => void;
  readonly emptyLabel?: string;
  readonly defaultRoute?: string;
  readonly loading?: boolean;
  readonly error?: string;
  readonly compact?: boolean;
  readonly warnings?: readonly string[];
  readonly onRoutePendingChange?: (pending: boolean) => void;
}) {
  const id = useId();
  const [search, setSearch] = useState('');
  const [provider, setProvider] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [compactProvider, setCompactProvider] = useState(() => routeProviderId(value));
  const pendingNotify = useRef(onRoutePendingChange);
  const [routePending, setRoutePending] = useState(false);
  pendingNotify.current = onRoutePendingChange;
  useEffect(() => {
    setCompactProvider(routeProviderId(value));
    setRoutePending(false);
    pendingNotify.current?.(false);
  }, [value]);

  const matches = (route: string) => choices.filter((model) => model.route === route);
  const selectedMatches = value === '' ? [] : matches(value);
  const selected = selectedMatches.length === 1 ? selectedMatches[0] : undefined;
  const defaultMatches = defaultRoute ? matches(defaultRoute) : [];
  const inherited = defaultMatches.length === 1 ? defaultMatches[0] : undefined;
  const keyCounts = new Map<string, number>();
  const providers = new Map<string, string>();
  for (const model of choices) {
    const key = modelCatalogEntryKey(model);
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    providers.set(providerId(model), providerLabel(model));
  }
  const identityIssue = (model: ModelRoute) => keyCounts.get(modelCatalogEntryKey(model)) !== 1 || matches(model.route).length !== 1;
  const selectedIssue = selected && identityIssue(selected) ? 'Not uniquely identified in the current catalogue.'
    : selected && !selected.enabled ? selected.unavailableReason || 'Model is unavailable.' : null;
  const terms = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = choices.filter((model) => {
    if (provider !== '' && providerId(model) !== provider) return false;
    if (freeOnly && !/(?:free)/i.test(model.id + ' ' + model.label)) return false;
    const haystack = (model.label + ' ' + model.route + ' ' + model.id + ' ' + providerLabel(model)).toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  const groups = new Map<string, ModelRoute[]>();
  for (const model of filtered) {
    const name = providerLabel(model);
    const group = groups.get(name);
    if (group) group.push(model); else groups.set(name, [model]);
  }
  const selectedVisible = filtered.some((model) => model.route === value);
  const effectiveProvider = compactProvider || (value === '' && defaultRoute ? routeProviderId(defaultRoute) : '');
  const compactModels = choices.filter((model) => providerId(model) === effectiveProvider);
  const currentProvider = selected ? providerId(selected) : routeProviderId(value);
  const displayedCompactValue = value !== '' && currentProvider === compactProvider ? value : '';

  function chooseProvider(nextProvider: string): void {
    setCompactProvider(nextProvider);
    if (nextProvider === '') {
      setRoutePending(false);
      pendingNotify.current?.(false);
      onChange('');
      return;
    }
    const pending = value === '' || currentProvider !== nextProvider;
    setRoutePending(pending);
    pendingNotify.current?.(pending);
  }

  function chooseModel(route: string): void {
    if (route === '' && emptyLabel !== undefined) {
      setCompactProvider('');
      setRoutePending(false);
      pendingNotify.current?.(false);
      onChange('');
      return;
    }
    const candidates = matches(route);
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (candidate?.enabled && !identityIssue(candidate)) {
      setCompactProvider(providerId(candidate));
      setRoutePending(false);
      pendingNotify.current?.(false);
      onChange(route);
    }
  }

  return (
    <div className={'er-models__row' + (compact ? ' er-models__row--compact-picker' : '')}>
      {compact ? <span className='er-models__label'>{label}</span>
        : <label className='er-models__label' htmlFor={id + '-select'}>{label}</label>}
      <div className={'er-model-picker' + (compact ? ' er-model-picker--compact' : '')}>
        {compact ? (
          <div className='er-model-picker__compact'>
            <label className='er-model-picker__control' htmlFor={id + '-provider-select'}>
              <span>Provider</span>
              <select id={id + '-provider-select'} aria-label={label + ': provider'} value={compactProvider}
                disabled={loading || error !== ''} onChange={(event) => chooseProvider(event.currentTarget.value)}>
                <option value=''>{emptyLabel ?? 'Choose a provider'}</option>
                {compactProvider !== '' && !providers.has(compactProvider)
                  ? <option value={compactProvider} disabled>Current provider unavailable</option> : null}
                {[...providers].map(([key, name]) => {
                  const available = choices.some((model) => providerId(model) === key && model.enabled && !identityIssue(model));
                  return <option key={key} value={key} disabled={!available}
                    title={available ? name : 'No available models from this provider.'}>
                    {available ? name : name + ' — unavailable'}
                  </option>;
                })}
              </select>
            </label>
            <label className='er-model-picker__control' htmlFor={id + '-compact-model-select'}>
              <span>Model</span>
              <select id={id + '-compact-model-select'} aria-label={label}
                title={selected?.label ?? inherited?.label}
                value={displayedCompactValue} disabled={loading || error !== '' || effectiveProvider === ''}
                onChange={(event) => chooseModel(event.currentTarget.value)}>
                <option value='' disabled={compactProvider !== '' || defaultRoute === undefined}>{compactProvider === '' ? inherited?.label ?? (defaultRoute ? 'Project default model' : 'Choose a provider first') : 'Choose a model'}</option>
                {value !== '' && compactProvider === currentProvider && !compactModels.some((model) => model.route === value)
                  ? <option value={value} disabled={!selected || selectedIssue !== null}>
                    {selected ? optionLabel(selected) + ' — saved selection' : 'Saved selection unavailable'}
                  </option> : null}
                {compactModels.map((model, index) => <option
                  key={identityIssue(model) ? modelCatalogEntryKey(model) + ':' + index : modelCatalogEntryKey(model)}
                  value={model.route} disabled={!model.enabled || identityIssue(model)}
                  title={identityIssue(model) ? 'Not uniquely identified in the current catalogue.' : model.unavailableReason || optionLabel(model)}>
                  {optionLabel(model)}
                </option>)}
              </select>
            </label>
          </div>
        ) : (
          <>
            <div className='er-model-picker__filters'>
              <label className='er-model-picker__search' htmlFor={id + '-provider'}>
                <span>Provider</span>
                <select id={id + '-provider'} aria-label={label + ': provider'} value={provider}
                  onChange={(event) => setProvider(event.currentTarget.value)}>
                  <option value=''>All providers</option>
                  {provider !== '' && !providers.has(provider) ? <option value={provider} disabled>{provider} — unavailable</option> : null}
                  {[...providers].map(([key, name]) => <option key={key} value={key}>{name}</option>)}
                </select>
              </label>
              <label className='er-model-picker__free'>
                <input type='checkbox' checked={freeOnly} onChange={(event) => setFreeOnly(event.currentTarget.checked)} />
                <span>Only free (name or ID contains “free”)</span>
              </label>
              <label className='er-model-picker__search' htmlFor={id + '-search'}>
                <span>Search</span>
                <input id={id + '-search'} type='search' aria-label={label + ': search models'} value={search} maxLength={512}
                  onChange={(event) => setSearch(event.currentTarget.value)} />
              </label>
              <p className='er-status' role='status'><span>{filtered.length === 0 ? 'No models match your search.' : filtered.length.toLocaleString('en-US') + ' matching models.'}</span></p>
            </div>
            <div className='er-model-picker__chip'>
              <MaterialSymbol name='spark' />
              <select id={id + '-select'} aria-label={label} value={value}
                title={selected ? selected.label + ' · ' + providerLabel(selected) : emptyLabel || 'Choose a model'}
                disabled={loading || error !== '' || (choices.length === 0 && value === '')}
                onChange={(event) => chooseModel(event.currentTarget.value)}>
                <option value='' disabled={emptyLabel === undefined}>{emptyLabel ?? 'Choose a model'}</option>
                {value !== '' && !selectedVisible ? <option value={value} disabled={!selected || selectedIssue !== null}>
                  {selected ? optionLabel(selected) + (selected.route !== value ? ' — saved selection' : '') : 'Saved selection unavailable'}
                </option> : null}
                {[...groups].map(([name, rows]) => <optgroup key={name} label={name}>
                  {rows.map((model, index) => <option key={identityIssue(model) ? modelCatalogEntryKey(model) + ':' + index : modelCatalogEntryKey(model)} value={model.route}
                    disabled={!model.enabled || identityIssue(model)}
                    title={identityIssue(model) ? 'Not uniquely identified in the current catalogue.' : model.unavailableReason || optionLabel(model)}>{optionLabel(model)}</option>)}
                </optgroup>)}
              </select>
            </div>
          </>
        )}
        {routePending ? <p className='er-status' role='status'><span>Choose a model from this provider to use it.</span></p> : null}
        {selected?.mayTrainOnYourPrompts === true ? <p className='er-status' role='note'><span>Warning: this provider may train on your prompts.</span></p> : null}
        {warnings.length > 0 ? <details className='er-model-picker__warnings'>
          <summary>Provider availability</summary>
          <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </details> : null}
        {loading ? <p className='er-status' role='status'><span>Loading model catalog…</span></p> : null}
        {error !== '' ? <p className='er-status er-status--error' role='alert'><span>{error}</span></p> : null}
        {!loading && error === '' && value !== '' && !selected
          ? <p className='er-status er-status--error' role='alert'><span>Selected model is unavailable in the current catalog. Its saved route is preserved; refresh models in Settings to update availability.</span></p> : null}
        {selectedIssue !== null ? <p className='er-status er-status--error' role='alert'><span>Selected model is unavailable: {selectedIssue}</span></p> : null}
      </div>
    </div>
  );
}
