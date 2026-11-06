import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { verifyClaims } from '../quotes';
import type { Understanding } from '../understanding';
import { SourceUnderstanding } from './Understanding';

describe('Source claim evidence presentation', () => {
  it('shows the exact excerpt without presenting literal checks as semantic verification', () => {
    // The real BERT failure: the same 512 occurs in a bound and batch arithmetic.
    const quote = '50% of the time B is the actual next sentence that follows A and 50% of the time it is a random sentence, which is done for the ‘next sentence prediction’ task. '
      + 'They are sampled such that the combined length is ≤ 512 tokens. The LM masking is applied after WordPiece tokenization with a uniform masking rate of 15%, and no special consideration given to partial word pieces. '
      + 'We train with batch size of 256 sequences (256 sequences * 512 tokens = 128,000 tokens/batch) for 1,000,000 steps, which is approximately 40 epochs over the 3.3 billion word corpus. '
      + 'We use Adam with learning rate of 1e-4, β1 = 0.9, β2 = 0.999, L2 weight decay of 0.01, learning rate warmup over the first 10,000 steps, and linear decay of the learning rate. '
      + 'We use a dropout probability of 0.1 on all layers. We use a gelu activation (Hendrycks and Gimpel, 2016) rather than the standard relu, following OpenAI GPT. '
      + 'The training loss is the sum of the mean masked LM likelihood and the mean next sentence prediction likelihood.';
    const end = new TextEncoder().encode(quote).byteLength;
    const checked = verifyClaims(quote, [{ id: 91, type: 'paragraph', start: 0, end, heading: null }], [{
      kind: 'method', statement: '1 000 000 шагов при batch 256 последовательностей по 512 токенов',
      quote, block: 91, task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null,
    }]);
    expect(checked.claims).toHaveLength(1); // Literal/quote checks do not establish the bound's meaning.
    const view: Understanding = {
      sourceId: 's1', revisionId: 'r1', state: 'done', error: null, canRecover: false,
      attemptId: 'r1', currentAttemptId: 'r1', authors: '', published: null,
      recordedUsage: { tokenLimit: null, tokenLimitKind: 'unknown', calls: 0, inputTokens: null,
        cachedTokens: null, outputTokens: null, estimatedCostMicrousd: null, pricingCheckedOn: null, startedAt: null, wallMs: null },
      progress: { attempts: 0, limit: 2, maximumTokens: null, model: null, configuredModel: null },
      guide: null, digest: null, glossary: [], report: null,
      claims: checked.claims.map((claim, index) => ({ ...claim, id: String(index) })),
      citations: [{ block: 91, start: 0, end }],
    };
    const client = new QueryClient();
    client.setQueryData(['understanding', 's1', 'r1', ''], view);
    try {
      const render = () => renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter>
        <SourceUnderstanding projectId='p1' sourceId='s1' revisionId='r1' sourceTitle='BERT' />
      </MemoryRouter></QueryClientProvider>);
      const html = render();
      expect(html).toContain('<h3>Claims and source excerpts</h3>');
      expect(html).not.toContain('Verified claims');
      expect(html).toContain('<blockquote class="er-und__quote">' + quote + '</blockquote>');
      expect(html).toContain('по 512 токенов');
      expect(html).toContain('revisionId=r1&amp;start=0&amp;end=' + end);
      client.setQueryData(['understanding', 's1', 'r1', ''], { ...view, claims: [], citations: [] });
      const empty = render();
      expect(empty).toContain('No claims stored for this revision.');
      expect(empty).not.toContain('verified claims');
    } finally { client.clear(); }
  });
});
