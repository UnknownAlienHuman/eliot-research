import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatModelPicker } from './ChatModelPicker';
import { modelCatalogEntryKey } from '../query/modelCatalog';
import { workersAiCatalogFixture } from '../query/workersAiCatalog.test-fixture';

describe('chat model picker availability labels', () => {
  it.each([
    { locale: 'en', expected: 'Availability check needed', available: 'Available' },
    { locale: 'ru', expected: 'Нужно проверить доступность', available: 'Доступна' },
  ] as const)('labels selectable, unchecked catalog models honestly in $locale', ({ locale, expected, available }) => {
    const model = workersAiCatalogFixture.models[0];
    const markup = renderToStaticMarkup(createElement(ChatModelPicker, { locale,
      choices: [{ model, providerLabel: 'Cloudflare Workers AI', key: modelCatalogEntryKey(model),
        canRun: true, builtin: true, availabilityCheckRequired: true }], selected: model, search: '', page: 1,
      onSearchChange() {}, onPageChange() {}, onSelect() {},
    }));
    const option = markup.slice(markup.indexOf('<option value="' + modelCatalogEntryKey(model)), markup.indexOf('</select>'));
    expect(option).toContain(' — ' + expected);
    expect(option).not.toContain(' — ' + available);
    expect(option).not.toContain('disabled');
  });

  it('keeps confirmed model choices available', () => {
    const model = workersAiCatalogFixture.models[0];
    const markup = renderToStaticMarkup(createElement(ChatModelPicker, { locale: 'en',
      choices: [{ model, providerLabel: 'Cloudflare Workers AI', key: modelCatalogEntryKey(model),
        canRun: true, builtin: true, availabilityCheckRequired: false }], selected: model, search: '', page: 1,
      onSearchChange() {}, onPageChange() {}, onSelect() {},
    }));
    expect(markup).toContain(' — Available');
    expect(markup).not.toContain(' — Availability check needed');
  });

  it.each([true, false])('offers a read-only availability check for failed or missing metadata (failed=%s)', failed => {
    const model = workersAiCatalogFixture.models[0];
    const markup = renderToStaticMarkup(createElement(ChatModelPicker, { locale: 'ru', choices: [], selected: model,
      failed, qualificationState: 'idle', search: '', page: 1, checkDisabled: false,
      onCheck() {}, onSearchChange() {}, onPageChange() {}, onSelect() {},
    }));
    expect(markup).toContain('Проверить доступность');
    expect(markup).toContain(model.model_id);
    expect(markup).not.toContain(' — Доступна');
  });
});
