// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { Markdown, citationHref, citationLabel, type MarkdownReference } from './Markdown';
import { persistentResolvedAnswer, resolveCitations } from '../citations';

const compact = '[S1:14]';
const persistent = '[R11111111-1111-4111-8111-111111111111:14]';
const href = '/p/project/source/source?revisionId=11111111-1111-4111-8111-111111111111&start=42&end=87';
const references = [{ text: compact, href }, { text: persistent, href }];
function render(text: string, refs: readonly MarkdownReference[] = references) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Markdown, { text, references: refs })));
}

describe('Markdown citation rendering', () => {
  it.each(['chat', 'saved'])('keeps %s citations visible after escaped literal backticks', (kind) => {
    const revisionId = '11111111-1111-4111-8111-111111111111';
    const text = String.raw`The \` delimiter is literal [S1:14], as is this \` delimiter.`;
    const resolved = resolveCitations(text, [{ sourceId: 's1', revisionId, title: 'Paper A', alias: 'S1',
      blocks: [{ id: 14, type: 'paragraph', start: 42, end: 87, heading: null }] }]);
    const answer = kind === 'saved' ? persistentResolvedAnswer(resolved.text, resolved.citations) : resolved;
    const refs = answer.citations.map(citation => ({ text: citation.label,
      href: citationHref('p1', citation), label: citationLabel(citation) }));
    const html = render(answer.text, refs);
    expect(html).not.toContain('<code>');
    expect(html.match(/class="er-citation er-citation--inline"/g)).toHaveLength(1);
    expect(html).toContain(`revisionId=${revisionId}&amp;start=42&amp;end=87`);
    expect(answer.citations).toHaveLength(1);
    expect(resolved.text).toBe(text);
  });

  it.each(['.er-citation--inline', 'a:not(.er-citation--inline)'])(
    'preserves focused %s across snapshot and streaming rerenders', async (selector) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    const text = `${compact} and ${persistent}. [Ordinary](https://example.com)`;
    const update = async (body: string) => {
      // Chat snapshots rebuild citation references even when the answer is unchanged.
      await act(async () => root.render(createElement(MemoryRouter, null,
        createElement(Markdown, { text: body, references: references.map(ref => ({ ...ref })) }))));
    };
    try {
      await update(text);
      const anchor = host.querySelector<HTMLAnchorElement>(selector);
      if (!anchor) throw new Error('Missing link: ' + selector);
      anchor.focus();
      expect(document.activeElement).toBe(anchor);
      for (const body of [text, text + ' More streamed text.']) {
        await update(body);
        expect(document.activeElement).toBe(anchor);
        expect(host.querySelector(selector)).toBe(anchor);
        expect(anchor.getAttribute('href')).toBe(selector.startsWith('.') ? href : 'https://example.com');
        expect([...host.querySelectorAll('.er-citation--inline')].map(el => el.textContent)).toEqual(['1', '1']);
      }
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it.each(['chat', 'saved'].flatMap(kind => [
    { format: 'plain', prefix: 'Claim ' },
    { format: 'leading BOM', prefix: '\uFEFF\n\n' },
    { format: 'BOM, CRLF and Unicode', prefix: '\uFEFF\r\n\r\n😀 Кириллица é ' },
    { format: 'two leading BOMs', prefix: '\uFEFF\uFEFF\r\n\r\n😀 ' },
    { format: 'non-leading BOM', prefix: '\n\uFEFF\n\n😀 ' },
  ].map(input => ({ kind, ...input }))))('keeps $kind citation authority with $format and a Markdown reference', ({ kind, prefix, format }) => {
    const revisionId = '11111111-1111-4111-8111-111111111111';
    const resolved = resolveCitations(prefix + '[S1:1].\n\n[S1:1]: https://example.com/not-the-source', [{
      sourceId: 's1', revisionId, title: 'Paper A', alias: 'S1',
      blocks: [{ id: 1, type: 'paragraph', start: 0, end: 10, heading: null }],
    }]);
    expect(resolved.invalidLabels).toBe(0);
    expect(resolved.citations).toHaveLength(1);
    const answer = kind === 'saved' ? persistentResolvedAnswer(resolved.text, resolved.citations) : resolved;
    const refs = answer.citations.map((citation) => ({ text: citation.label,
      href: citationHref('p1', citation), label: citationLabel(citation) }));
    const html = render(answer.text, refs);
    expect(html.match(/class="er-citation er-citation--inline"/g)).toHaveLength(1);
    expect(html).toContain(`/p/p1/source/s1?revisionId=${revisionId}&amp;start=0&amp;end=10`);
    expect(html).toContain('title="Paper A · 1"');
    expect(html).toContain('aria-label="Citation 1: Paper A · 1"');
    expect(html).toContain('>1</a>');
    expect(html).not.toContain('href="https://example.com/not-the-source"');
    if (prefix.includes('😀')) expect(html).toContain('😀');
    if (format === 'BOM, CRLF and Unicode') expect(html).toContain('Кириллица é');
    if (format === 'two leading BOMs' || format === 'non-leading BOM') expect(html).toContain('<p>\uFEFF</p>');
  });

  it.each([compact, persistent].flatMap(token => ['', '\uFEFF'].map(prefix => ({ token, prefix }))))(
    'preserves exact $token references at prose depths after TeX adaptation ($prefix)', ({ token, prefix }) => {
    const html = render(prefix + String.raw`\[x^2\]` + `\n\nParagraph ${token}\n\n- List ${token}\n\n> Quote **${token}**\n\n`
      + `| Evidence |\n| --- |\n| ${token} |\n\n${token}: https://example.com/not-the-source "Untrusted title"`);
    expect(html.match(/class="er-citation er-citation--inline"/g)).toHaveLength(4);
    expect(html.match(/start=42&amp;end=87/g)).toHaveLength(4);
    expect(html).not.toContain('not-the-source');
    expect(html).not.toContain('Untrusted title');
    expect(html).toContain('<math');
  });

  it.each(['chat', 'saved'].flatMap(kind => [false, true].map(defineBoth => ({ kind, defineBoth }))))(
    'restores adjacent registered $kind citations with defineBoth=$defineBoth', ({ kind, defineBoth }) => {
    const revisionId = '11111111-1111-4111-8111-111111111111';
    const text = '\uFEFF😀 Claim [S1:14][S1:15].\r\n\r\n'
      + (defineBoth ? '[S1:14]: https://example.com/wrong-one\r\n' : '')
      + '[S1:15]: https://example.com/wrong-two';
    const resolved = resolveCitations(text, [{ sourceId: 's1', revisionId, title: 'Paper A', alias: 'S1', blocks: [
      { id: 14, type: 'paragraph', start: 42, end: 87, heading: null },
      { id: 15, type: 'paragraph', start: 87, end: 120, heading: null },
    ] }]);
    expect(resolved.invalidLabels).toBe(0);
    expect(resolved.citations).toHaveLength(2);
    const answer = kind === 'saved' ? persistentResolvedAnswer(resolved.text, resolved.citations) : resolved;
    const refs = answer.citations.map(citation => ({ text: citation.label,
      href: citationHref('p1', citation), label: citationLabel(citation) }));
    const html = render(answer.text, refs);
    expect(html.match(/class="er-citation er-citation--inline"/g)).toHaveLength(2);
    expect(html).toContain(`revisionId=${revisionId}&amp;start=42&amp;end=87`);
    expect(html).toContain(`revisionId=${revisionId}&amp;start=87&amp;end=120`);
    expect(html).toContain('aria-label="Citation 1: Paper A · 14"');
    expect(html).toContain('title="Paper A · 14"');
    expect(html).toContain('>1</a>');
    expect(html).toContain('aria-label="Citation 2: Paper A · 15"');
    expect(html).toContain('title="Paper A · 15"');
    expect(html).toContain('>2</a>');
    expect(html).not.toContain('https://example.com/wrong-');
  });

  it('keeps adjacent citations and their repeated persistent alias as separate targets', () => {
    const second = '[S1:15]', secondHref = href.replace('start=42&end=87', 'start=87&end=120');
    const refs = [...references, { text: second, href: secondHref }];
    const html = render(`${compact}${second} repeated ${persistent}.\n\n`
      + `${compact}: https://example.com/wrong-one\n${second}: https://example.com/wrong-two\n`
      + `${persistent}: https://example.com/wrong-alias`, refs);
    expect(html.match(/class="er-citation er-citation--inline"/g)).toHaveLength(3);
    expect(html.match(/start=42&amp;end=87/g)).toHaveLength(2);
    expect(html.match(/start=87&amp;end=120/g)).toHaveLength(1);
    expect(html).not.toContain('https://example.com/wrong-');
  });

  it.each(['[visible][S1:15]', '[S1:14][ordinary]', '[S9:14][S1:15]', '[S1:14][S9:15]',
    String.raw`[S1\:14][S1:15]`, '[S1&#58;14][S1:15]', '[s1:14][S1:15]', '[**S1:14**][S1:15]'])(
    'preserves the ordinary full-reference link %s', (link) => {
    const html = render(`${link}\n\n[S1:15]: https://example.com/reference\n[ordinary]: https://example.com/reference\n`
      + '[S9:15]: https://example.com/reference', [...references, { text: '[S1:15]', href: href + '#second' }]);
    expect(html).toContain('href="https://example.com/reference"');
    expect(html).not.toContain('class="er-citation er-citation--inline"');
  });

  it('leaves explicit links, code, images and unregistered reference labels unchanged', () => {
    const html = render(`${compact}\n\n`
      + `[S1:14](https://example.com/inline) [S1:14][] [visible][S1:14]\n\n`
      + '[ordinary] [S9:99] [R22222222-2222-4222-8222-222222222222:14]\n\n'
      + `\`${compact}\`\n\n\`\`\`\n${compact}\n\`\`\`\n\n    ${compact}\n\n!${compact}\n\n`
      + `${compact}: https://example.com/reference\n[ordinary]: https://example.com/ordinary\n`
      + '[S9:99]: https://example.com/unknown\n[R22222222-2222-4222-8222-222222222222:14]: https://example.com/unknown-revision');
    expect(html.match(/class="er-citation er-citation--inline"/g)).toHaveLength(1);
    expect(html).toContain('<a href="https://example.com/inline">S1:14</a>');
    expect(html).toContain('<a href="https://example.com/reference">S1:14</a>');
    expect(html).toContain('<a href="https://example.com/reference">visible</a>');
    expect(render('[[S1:14]](https://example.com/nested)')).toContain('<a href="https://example.com/nested">[S1:14]</a>');
    expect(html).toContain('<a href="https://example.com/ordinary">ordinary</a>');
    expect(html).toContain('<a href="https://example.com/unknown">S9:99</a>');
    expect(html).toContain('href="https://example.com/unknown-revision"');
    expect(html).toContain(`<code>${compact}</code>`);
    expect(html.match(/<pre><code>\[S1:14\]\n<\/code><\/pre>/g)).toHaveLength(2);
    expect(html).not.toContain('<img');
    expect(render(`${compact}\n\n${compact}: https://example.com/unregistered`, [])).toContain('href="https://example.com/unregistered"');
  });

  it.each([String.raw`[S1\:14]`, '[S1&#58;14]', '[s1:14]'])('does not promote non-exact reference spelling %s', (token) => {
    const html = render(`${token}\n\n${token}: https://example.com/reference`);
    expect(html).toContain('href="https://example.com/reference"');
    expect(html).not.toContain('class="er-citation er-citation--inline"');
  });

  it('does not promote arbitrary registered text to a citation reference', () => {
    const html = render('[ordinary]\n\n[ordinary]: https://example.com/ordinary', [{ text: '[ordinary]', href }]);
    expect(html).toContain('<a href="https://example.com/ordinary">ordinary</a>');
    expect(html).not.toContain('class="er-citation er-citation--inline"');
  });

  it('renders the saved C4 TeX delimiters with accessible math and an unchanged evidence link', () => {
    // Exact public Transformer formula syntax from the saved C4 rendering failure.
    const formula = String.raw`\[
PE_{(pos,2i)} = \sin\!\left(pos/10000^{2i/d_{\text{model}}}\right),\qquad
PE_{(pos,2i+1)} = \cos\!\left(pos/10000^{2i/d_{\text{model}}}\right),
\]`;
    const html = render(String.raw`Width \(d_{\text{model}}\). ` + compact + '\n\n' + formula);
    expect(html.match(/<math /g)).toHaveLength(2);
    expect(html.match(/display="block"/g)).toHaveLength(1);
    expect(html).toContain('encoding="application/x-tex"');
    expect(html).not.toContain('katex-html');
    expect(html.match(/class="er-citation er-citation--inline"/g)).toHaveLength(1);
    expect(html).toContain('start=42&amp;end=87');
    expect(html).not.toContain('katex-error');
  });

  it('keeps TeX and dollar expressions literal in inline and fenced code', () => {
    const literal = String.raw`\(x_1\) \[y^2\] $z$ ` + compact;
    const html = render(String.raw`Prose \(x\) ` + compact + '\n\n`' + literal + '`\n\n```tex\n' + literal + '\n```');
    expect(html.match(/<math /g)).toHaveLength(1);
    expect(html.match(/class="er-citation er-citation--inline"/g)).toHaveLength(1);
    expect(html).toContain('<code>' + literal + '</code>');
    expect(html).toContain('<pre><code class="language-tex">' + literal + '\n</code></pre>');
  });

  it('preserves indented-code contents and Markdown link destinations containing TeX delimiters', () => {
    const indented = render('    ' + String.raw`\(x\)` + '\n');
    expect(indented).toBe('<pre><code>' + String.raw`\(x\)` + '\n</code></pre>');
    const linked = render(String.raw`[link](https://example.test/\(x\))`);
    expect(linked).toContain('href="https://example.test/(x)"');
    expect(linked).not.toContain('$$');
    expect(linked).not.toContain('<math');
  });

  it('preserves a GFM bare autolink containing TeX delimiters', () => {
    const url = String.raw`https://example.test/\(x\)`;
    const html = render(url);
    expect(html).toContain('href="https://example.test/%5C(x%5C)"');
    expect(html).not.toContain('$$');
    expect(html).not.toContain('<math');
  });

  it('leaves unfinished streamed TeX readable until its closing delimiter arrives', () => {
    const partial = render(String.raw`Before \[\frac{1}{`);
    expect(partial).not.toContain('class="katex');
    expect(partial).toContain(String.raw`\frac{1}{`);
    const complete = render(String.raw`Before \[\frac{1}{2}\] after.`);
    expect(complete.match(/<math /g)).toHaveLength(1);
    expect(complete).toContain('after.');
    expect(() => render(String.raw`\[\unknowncommand{x}\]`)).not.toThrow();
  });

  it('supports double-dollar math, preserves currency and rejects trusted-HTML TeX commands', () => {
    const html = render('Inline $$x_1$$.\n\n$$\ny^2\n$$');
    expect(html.match(/<math /g)).toHaveLength(2);
    expect(render('Price $5 and $10 a month.')).toBe('<p>Price $5 and $10 a month.</p>');
    expect(render('Literal $x_1$.')).not.toContain('<math');
    const untrusted = render(String.raw`\(\href{javascript:alert(1)}{x}\)` + '\n\n<script>unsafe()</script>');
    expect(untrusted).not.toContain('<a ');
    expect(untrusted).not.toContain('<script');
    expect(untrusted).not.toContain('unsafe()');
  });

  it('preserves encoded evidence identity, exact byte offsets and deleted labels', () => {
    const citation = { sourceId: 'source/😀?', revisionId: 'old/#&', block: 14, start: 42, end: 87,
      sourceTitle: 'Бумага <&>', deleted: false, label: compact };
    const target = citationHref('project/я?', citation);
    expect(target).toBe('/p/project%2F%D1%8F%3F/source/source%2F%F0%9F%98%80%3F?revisionId=old%2F%23%26&start=42&end=87');
    expect(citationLabel(citation)).toBe('Бумага <&> · 14');
    const html = render(compact, [{ text: compact, href: target, label: citationLabel({ ...citation, deleted: true }) }]);
    expect(html).toContain('aria-label="Citation 1: Бумага &lt;&amp;&gt; · 14 (deleted)"');
    expect(html).toContain('title="Бумага &lt;&amp;&gt; · 14 (deleted)"');
    expect(html).toContain('>1</a>');
    expect(html).toContain('revisionId=old%2F%23%26&amp;start=42&amp;end=87');
  });

  it('links paragraph, tight-list and GFM table labels to their exact reader range', () => {
    const html = render(`Paragraph ${compact}\n\n- Tight list ${compact}\n- Saved label ${persistent}\n\n| Evidence ${compact} | Value |\n| --- | --- |\n| Table cell ${persistent} | **Emphasis ${compact}** |`);
    expect(html.match(/<a /g)).toHaveLength(6);
    expect(html.match(/href="\/p\/project\/source\/source\?revisionId=11111111-1111-4111-8111-111111111111&amp;start=42&amp;end=87"/g)).toHaveLength(6);
    expect(html).toContain('<li>Tight list <a class="er-citation er-citation--inline"');
    expect(html).toContain('<th>Evidence <a class="er-citation er-citation--inline"');
    expect(html).toContain('<td>Table cell <a class="er-citation er-citation--inline"');
    expect(html).toContain('<strong>Emphasis <a class="er-citation er-citation--inline"');
  });

  it('keeps citation-looking labels in inline and fenced code literal', () => {
    const html = render(`Prose ${compact}, inline \`${compact}\`.\n\n- Code \`${persistent}\`\n\n\`\`\`text\n${compact} ${persistent}\n\`\`\``);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(`<code>${compact}</code>`);
    expect(html).toContain(`<code>${persistent}</code>`);
    expect(html).toContain(`<pre><code class="language-text">${compact} ${persistent}\n</code></pre>`);
  });

  it('keeps the full title accessible while using a compact visible number and literal code', () => {
    const displayLabel = 'Paper title · 14';
    const labelled: MarkdownReference[] = [{ text: persistent, label: displayLabel, href }];
    const html = render(`${persistent} and inline \`${persistent}\`.\n\n\`\`\`text\n${persistent}\n\`\`\``, labelled);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('class="er-citation er-citation--inline"');
    expect(html).toContain(`aria-label="Citation 1: ${displayLabel}"`);
    expect(html).toContain(`title="${displayLabel}"`);
    expect(html).toContain('>1</a>');
    expect(html).toContain(`<code>${persistent}</code>`);
    expect(html).toContain(`<pre><code class="language-text">${persistent}\n</code></pre>`);
  });

  it.each(['chat', 'saved'])('numbers only visible %s citations and preserves numbers when streamed text appends', kind => {
    const revisionId = '11111111-1111-4111-8111-111111111111';
    const sources = [{ sourceId: 's1', revisionId, title: 'Paper A', alias: 'S1', blocks: [
      { id: 1, type: 'paragraph' as const, start: 0, end: 10, heading: null },
      { id: 2, type: 'paragraph' as const, start: 10, end: 20, heading: null },
    ] }];
    const text = '[S1:1]: https://example.test/hidden-definition\n\nVisible [S1:2].';
    for (const appended of ['', ' Again [R' + revisionId + ':2] and earlier [S1:1].']) {
      const resolved = resolveCitations(text + appended, sources);
      const answer = kind === 'saved' ? persistentResolvedAnswer(resolved.text, resolved.citations) : resolved;
      const html = render(answer.text, answer.citations.map(citation => ({ text: citation.label,
        href: citationHref('p1', citation), label: citationLabel(citation) })));
      expect([...html.matchAll(/>(\d+)<\/a>/g)].map(match => match[1])).toEqual(appended ? ['1', '1', '2'] : ['1']);
      expect(html).toContain('aria-label="Citation 1: Paper A · 2"');
      expect(html).toContain('start=10&amp;end=20');
      expect(html).not.toContain('href="https://example.test/hidden-definition"');
      if (appended) expect(html).toContain('aria-label="Citation 2: Paper A · 1"');
    }
  });

  it('numbers distinct passage targets and shares the number between compact and persistent aliases', () => {
    const second = href.replace('start=42&end=87', 'start=90&end=120');
    const refs = [...references.map(ref => ({ ...ref, label: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding · 14' })),
      { text: '[S1:15]', href: second, label: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding · 15' },
      { text: '[S2:14]', href: href.replace('/source/source?', '/source/source-two?').replace('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'), label: 'Attention Is All You Need · 14' }];
    const html = render(`${compact}[S1:15] another source [S2:14] repeated ${persistent}.\n\n${compact}: https://example.test/wrong-one\n`
      + `[S1:15]: https://example.test/wrong-two\n${persistent}: https://example.test/wrong-alias`, refs);
    expect([...html.matchAll(/>(\d+)<\/a>/g)].map(match => match[1])).toEqual(['1', '2', '3', '1']);
    expect(html.match(/class="er-citation er-citation--inline"/g)).toHaveLength(4);
    expect(html).toContain('aria-label="Citation 2: BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding · 15"');
    expect(html).toContain('start=90&amp;end=120');
    expect(html).toContain('aria-label="Citation 3: Attention Is All You Need · 14"');
    expect(html).toContain('/source/source-two?revisionId=22222222-2222-4222-8222-222222222222&amp;start=42&amp;end=87');
    expect(html).not.toContain('https://example.test/wrong-');
    expect(render(`[Read the passage](${href})`, refs)).toContain('>Read the passage</a>');
    expect(render(`[Read the passage](${href})`, refs)).not.toContain('class="er-citation er-citation--inline"');
  });

  it('suppresses HTML and images, keeps unknown labels plain and avoids nested links', () => {
    const html = render(`<script>unsafe()</script>\n\n![external](https://example.com/image.png)\n\nUnknown [S9:99]. [Existing **${compact}**](https://example.com/read)\n\n[unsafe](javascript:alert%281%29)`);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('unsafe()');
    expect(html).not.toContain('<img');
    expect(html).toContain('Unknown [S9:99]');
    expect(html).toContain(`<a href="https://example.com/read">Existing <strong>${compact}</strong></a>`);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a href="https://example.com/read">Existing <a');
  });
});
