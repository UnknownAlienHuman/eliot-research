import { describe, expect, it } from 'vitest';

import type { LegacyErrorFactory, LegacyHttpAdapter } from '../../legacy/http';
import { createSessionEpoch } from '../../transport/session/epoch';
import { createResearchConfigurationApi } from './readiness';

const deploymentGeneration = 'deploy-1';

const errors: LegacyErrorFactory = (detail) => new Error(`${detail.code}:${detail.status}`);

const readinessBody = {
  protocol: 'eliotr.research-configuration-readiness.v1',
  configuration: 'present',
  model_transport: 'available',
  qualification_state: 'current',
  run_readiness: 'ready',
  readiness_reason: 'QUALIFICATION_PROOFS_CURRENT',
  model_route: 'route/research',
  qualification_expires_at: '2026-10-04T12:00:00.000Z',
  missing_fields: [],
  invalid_fields: [],
  checked_at: '2026-10-03T12:00:00.000Z',
};

const envelope = (data: unknown) => ({
  data,
  trace_id: 'trace-1',
  deployment_generation: deploymentGeneration,
});

interface Call { readonly path: string }

function recorder(response: unknown): { http: LegacyHttpAdapter; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    http: {
      requestApi(path: string) {
        calls.push({ path });
        return Promise.resolve(response);
      },
    } as unknown as LegacyHttpAdapter,
  };
}

describe('research configuration readiness', () => {
  it('passes the selected project id as an encoded query parameter', async () => {
    const { http, calls } = recorder(envelope(readinessBody));
    const api = createResearchConfigurationApi(http, errors, createSessionEpoch());
    const view = await api.readResearchConfiguration(deploymentGeneration, { projectId: 'project/one' });
    expect(calls).toEqual([{ path: '/api/v1/system/research-configuration?project_id=project%2Fone' }]);
    expect(view.run_readiness).toBe('ready');
  });

  it('rejects malformed project ids before sending a request', async () => {
    const { http, calls } = recorder(envelope(readinessBody));
    const api = createResearchConfigurationApi(http, errors, createSessionEpoch());
    await expect(api.readResearchConfiguration(deploymentGeneration, { projectId: '../other' }))
      .rejects.toThrow('RESEARCH_PROJECT_ID_INVALID:400');
    expect(calls).toHaveLength(0);
  });

  it('rejects a ready row whose reason is not QUALIFICATION_PROOFS_CURRENT', async () => {
    const { http } = recorder(envelope({
      ...readinessBody,
      readiness_reason: 'QUALIFICATION_RENEWAL_AT_RUN',
    }));
    const api = createResearchConfigurationApi(http, errors, createSessionEpoch());
    await expect(api.readResearchConfiguration(deploymentGeneration))
      .rejects.toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });

  it('decodes a lazy_renewal row as a distinct state, not as blocked', async () => {
    const { http } = recorder(envelope({
      ...readinessBody,
      qualification_state: 'renewal_required',
      run_readiness: 'lazy_renewal',
      readiness_reason: 'QUALIFICATION_RENEWAL_AT_RUN',
    }));
    const api = createResearchConfigurationApi(http, errors, createSessionEpoch());
    const view = await api.readResearchConfiguration(deploymentGeneration);
    expect(view.run_readiness).toBe('lazy_renewal');
  });

  it('decodes the legacy status protocol as forced unavailable and blocked', async () => {
    const { http } = recorder(envelope({
      protocol: 'eliotr.research-configuration-status.v1',
      configuration: 'present',
      model_transport: 'unavailable',
      missing_fields: [],
      invalid_fields: [],
      checked_at: '2026-10-03T12:00:00.000Z',
    }));
    const api = createResearchConfigurationApi(http, errors, createSessionEpoch());
    const view = await api.readResearchConfiguration(deploymentGeneration);
    expect(view.protocol).toBe('eliotr.research-configuration-status.v1');
    expect(view.qualification_state).toBe('unavailable');
    expect(view.run_readiness).toBe('blocked');
    expect(view.model_route).toBeNull();
  });

  it('rejects a response for a different deployment generation with 409', async () => {
    // The generation fence reads the envelope field, not a data-level field.
    const { http } = recorder({
      data: readinessBody,
      trace_id: 'trace-1',
      deployment_generation: 'deploy-2',
    });
    const api = createResearchConfigurationApi(http, errors, createSessionEpoch());
    await expect(api.readResearchConfiguration(deploymentGeneration))
      .rejects.toThrow('API_GENERATION_MISMATCH:409');
  });

  it('rejects a caller-supplied generation that is not a safe identifier', async () => {
    const { http, calls } = recorder(envelope(readinessBody));
    const api = createResearchConfigurationApi(http, errors, createSessionEpoch());
    await expect(api.readResearchConfiguration('../other'))
      .rejects.toThrow('API_GENERATION_MISMATCH:409');
    expect(calls).toHaveLength(0);
  });

  it('rejects a decoded view produced after the shared epoch advanced', async () => {
    const epoch = createSessionEpoch();
    const { http } = recorder(envelope(readinessBody));
    const api = createResearchConfigurationApi(http, errors, epoch);
    const pending = api.readResearchConfiguration(deploymentGeneration);
    // The response resolves and decodes cleanly; the fence alone rejects the stale result.
    epoch.advance();
    await expect(pending).rejects.toThrow('API_SESSION_CLOSED:503');
  });

  it('refuses to start a request against an already-closed session', async () => {
    const epoch = createSessionEpoch();
    epoch.close();
    const { http, calls } = recorder(envelope(readinessBody));
    const api = createResearchConfigurationApi(http, errors, epoch);
    await expect(api.readResearchConfiguration(deploymentGeneration))
      .rejects.toThrow('API_SESSION_CLOSED:503');
    expect(calls).toHaveLength(0);
  });
});
