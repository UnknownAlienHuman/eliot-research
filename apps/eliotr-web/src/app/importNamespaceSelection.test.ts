import { describe, expect, it } from 'vitest';
import type { SourceNamespaceCatalog } from '@eliotr/owner-api-client';
import { defaultRawImportNamespace, rawImportQuarantineReason } from './importNamespaceSelection';

const catalog = (namespaces: SourceNamespaceCatalog['namespaces']): SourceNamespaceCatalog => ({
  protocol: 'eliotr.owner-namespaces.v1', profiles: [], namespaces, trace_id: 'trace-1', deployment_generation: 'deployment-1',
});

describe('raw import workspace selection', () => {
  it('chooses an active owner-catalog workspace whose published minimum admits degraded PDF output', () => {
    expect(defaultRawImportNamespace('', catalog([
      { source_namespace_id: 'strict', title: 'Research', minimum_quality_state: 'standard', read_access: 'ACTIVE' },
      { source_namespace_id: 'documents', title: 'Documents', minimum_quality_state: 'degraded', read_access: 'ACTIVE' },
    ]))).toBe('documents');
  });

  it('does not fall back to an expired, strict, or policy-unknown workspace', () => {
    expect(defaultRawImportNamespace('', catalog([
      { source_namespace_id: 'expired', title: 'Expired', minimum_quality_state: 'degraded', read_access: 'EXPIRED' },
      { source_namespace_id: 'strict', title: 'Research', minimum_quality_state: 'standard', read_access: 'ACTIVE' },
      { source_namespace_id: 'unknown', title: 'Unknown', read_access: 'ACTIVE' },
    ]))).toBeUndefined();
    expect(defaultRawImportNamespace('', undefined)).toBeUndefined();
  });

  it('preserves an explicit workspace choice across catalog updates', () => {
    expect(defaultRawImportNamespace('owner-selected', catalog([]))).toBe('owner-selected');
  });

  it('turns the recorded quality quarantine reason into actionable, human-readable guidance', () => {
    expect(rawImportQuarantineReason(['QUALITY_BELOW_POLICY_MINIMUM', 'QUALIFICATION_DEGRADED'], 'en'))
      .toBe('This workspace requires a higher quality level than the extracted file provides. The quarantined capture remains bound to this workspace. For a future import, choose a workspace whose published minimum is degraded. The extracted file is marked degraded because source-coordinate mapping is unavailable.');
    expect(rawImportQuarantineReason(['NEW_POLICY_CHECK'], 'en'))
      .toBe('The admission check reported new policy check.');
    expect(rawImportQuarantineReason(['QUALITY_BELOW_POLICY_MINIMUM'], 'ru'))
      .toContain('Источник в карантине привязан к этой области');
    expect(rawImportQuarantineReason([], 'en')).toBeUndefined();
  });
});
