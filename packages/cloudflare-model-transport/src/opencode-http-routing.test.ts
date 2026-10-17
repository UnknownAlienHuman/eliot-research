import { describe, expect, it } from 'vitest';
import { resolveOpenCodePreparedRequest } from './opencode-http-routing.js';
import type { ModelGatewayTransportPolicyV1 } from './model-gateway-transport-policy.js';

const provider = 'custom-opencode-go';
const root = `https://gateway.ai.cloudflare.com/v1/${'a'.repeat(32)}/eliotr-reasoning`;
describe('OpenCode HTTP preparation seam', () => {
  it.each([
    ['custom-responses', 'responses', 'openai/v1/responses', 'max_output_tokens'],
    ['custom-chat-completions', 'chat/completions', 'openai/v1/chat/completions', 'max_tokens'],
    ['custom-anthropic-messages', 'v1/messages', 'anthropic/v1/messages', 'max_tokens'],
  ] as const)('resolves %s without rewriting compiled bytes or digests', async (api, oldSuffix, suffix, tokenField) => {
    const policy: ModelGatewayTransportPolicyV1 = { version: 1, transport: 'cloudflare-ai-gateway', api, provider, model: 'exact-model',
      billing: { mode: 'byok', alias: 'saved-alias' }, capabilities: { max_output_tokens_field: tokenField, reasoning_efforts: [] } };
    const original = Object.freeze({ url: `${root}/custom-${provider}/${oldSuffix}`, method: 'POST' as const,
      headers: Object.freeze({ 'cf-aig-byok-alias': 'saved-alias' }), body: '{"model":"exact-model"}',
      body_sha256: 'a'.repeat(64), parameters_sha256: 'b'.repeat(64), request_timeout_ms: 5000 });
    const routed = await resolveOpenCodePreparedRequest(original, policy, async () => ({ slug: provider, base_url: 'https://opencode.ai' }));
    expect(routed.url).toBe(`${root}/custom-${provider}/inference/go/${suffix}`);
    expect({ ...routed, url: original.url }).toEqual(original);
    expect(routed.headers).toBe(original.headers);
    expect(new Request(routed.url, { method: routed.method, headers: routed.headers, body: routed.body }).url).toBe(routed.url);
    await expect(resolveOpenCodePreparedRequest(original, policy, undefined)).rejects.toMatchObject({ code: 'MODEL_GATEWAY_REQUEST_INVALID' });
    if (api === 'custom-anthropic-messages') {
      await expect(resolveOpenCodePreparedRequest(original, policy, async () => ({ slug: provider,
        base_url: 'https://opencode.ai/inference/go/openai/v1' }))).rejects.toMatchObject({ code: 'MODEL_GATEWAY_REQUEST_INVALID' });
    }
  });
});
