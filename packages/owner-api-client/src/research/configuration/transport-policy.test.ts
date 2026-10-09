import { describe, expect, it } from 'vitest';

import { createTransportPolicyDecoder } from './transport-policy';
import type { LegacyErrorDetails, LegacyErrorFactory } from '../../legacy/http';

const details: LegacyErrorDetails[] = [];
const errors: LegacyErrorFactory = (detail) => {
  details.push(detail);
  return new Error(`${detail.code}:${detail.status}`);
};

const decode = createTransportPolicyDecoder(errors).decodeResearchModelTransportPolicy;

const basePolicy = {
  version: 1,
  transport: 'cloudflare-ai-gateway',
  api: 'openrouter-chat-completions',
  provider: 'openrouter',
  model: 'stealth/space-bunny-alpha',
  billing: { mode: 'byok', alias: 'default' },
  capabilities: { max_output_tokens_field: 'max_output_tokens', reasoning_efforts: ['max'] },
};

describe('transport policy decoder', () => {
  it('decodes the exact OpenRouter chat policy while preserving optional wire capabilities', () => {
    const policy = {
      ...basePolicy,
      capabilities: {
        max_output_tokens_field: 'max_output_tokens',
        reasoning_efforts: ['max'],
        reasoning_effort_normalizations: { medium: 'max' },
        response_format_normalization: 'json-schema-to-json-object',
      },
    };
    expect(decode(policy)).toEqual(policy);
  });

  it('preserves the native free-only billing marker', () => {
    const policy = {
      ...basePolicy,
      billing: { mode: 'byok', alias: 'openrouter-test', free_only: true },
    };
    expect(decode(policy).billing).toEqual({ mode: 'byok', alias: 'openrouter-test', free_only: true });
  });

  it('rejects an unrecognized transport-policy field instead of displaying guessed behavior', () => {
    const policy = { ...basePolicy, extra_field: 'unknown-capability' };
    expect(() => decode(policy)).toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
    expect(details.at(-1)).toMatchObject({ status: 502, traceId: null, retryable: false });
  });

  it('rejects a model identifier outside the accepted shape', () => {
    const policy = { ...basePolicy, model: 'bad model with spaces' };
    expect(() => decode(policy)).toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });

  it('rejects inconsistent effort normalizations', () => {
    const policy = {
      ...basePolicy,
      capabilities: {
        max_output_tokens_field: 'max_tokens',
        reasoning_efforts: ['max'],
        // key must be an effort the policy does NOT list; 'max' is listed, so this is inconsistent
        reasoning_effort_normalizations: { max: 'high' },
      },
    };
    expect(() => decode(policy)).toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });

  it('rejects a native api whose provider identity or billing is not byok', () => {
    const policy = { ...basePolicy, api: 'openai-chat-completions', provider: 'openai', billing: { mode: 'unified' } };
    expect(() => decode(policy)).toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });

  it('rejects free-only billing on a non-OpenRouter native endpoint', () => {
    const policy = { ...basePolicy, api: 'compat-chat-completions', billing: { mode: 'byok', alias: 'a', free_only: true } };
    expect(() => decode(policy)).toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });

  it('requires an explicit true for free-only billing', () => {
    const policy = { ...basePolicy, billing: { mode: 'byok', alias: 'a', free_only: false } };
    expect(() => decode(policy)).toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });

  it('rejects response format normalization on an unsupported api', () => {
    const policy = {
      ...basePolicy,
      api: 'anthropic-messages',
      provider: 'anthropic',
      capabilities: {
        max_output_tokens_field: 'max_tokens',
        reasoning_efforts: ['max'],
        response_format_normalization: 'json-schema-to-json-object',
      },
    };
    expect(() => decode(policy)).toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });
});
