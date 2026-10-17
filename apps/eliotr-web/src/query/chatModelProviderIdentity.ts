import { researchModelCatalogAdapterForRouteProvider } from '@eliotr/owner-api-client';

/** Only these registered transport slugs alias an owner catalog provider. Unknown slugs stay exact. */
const physicalCatalogProviders = new Map([
  ['custom-opencode-go', 'opencode-go'],
  ['custom-opencode-zen', 'opencode-zen'],
]);
export function chatCatalogProviderForRouteProvider(providerId: string): string {
  if (/^custom-compatible-[a-f0-9]{24}$/u.test(providerId)) return providerId.slice("custom-".length);
  return researchModelCatalogAdapterForRouteProvider(physicalCatalogProviders.get(providerId) ?? providerId);
}
