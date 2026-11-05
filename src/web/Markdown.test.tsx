import { createElement } from 'react';
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
    expect(html.match(/class="er-citation"/g)).toHaveLength(1);
    expect(html).toContain(`/p/p1/source/s1?revisionId=${revisionId}&amp;start=0&amp;end=10`);
    expect(html).toContain('>Paper A · 1</a>');
    expect(html).not.toContain('href="https://example.com/not-the-source"');
    if (prefix.includes('😀')) expect(html).toContain('😀');
    if (format === 'BOM, CRLF and Unicode') expect(html).toContain('Кириллица é');
    if (format === 'two leading BOMs' || format === 'non-leading BOM') expect(html).toContain('<p>\uFEFF</p>');
  });

  it.each([compact, persistent].flatMap(token => ['', '\uFEFF'].map(prefix => ({ token, prefix }))))(
    'preserves exact $token references at prose depths after TeX adaptation ($prefix)', ({ token, prefix }) => {
    const html = render(prefix + String.raw`\[x^2\]` + `\n\nParagraph ${token}\n\n- List ${token}\n\n> Quote **${token}**\n\n`
      + `| Evidence |\n| --- |\n| ${token} |\n\n${token}: https://example.com/not-the-source "Untrusted title"`);
    expect(html.match(/class="er-citation"/g)).toHaveLength(4);
    expect(html.match(/start=42&amp;end=87/g)).toHaveLength(4);
    expect(html).not.toContain('not-the-source');
    expect(html).not.toContain('Untrusted title');
    expect(html).toContain('<math');
  });

  it('leaves explicit links, code, images and unregistered reference labels unchanged', () => {
    const html = render(`${compact}\n\n`
      + `[S1:14](https://example.com/inline) [S1:14][] [visible][S1:14]\n\n`
      + '[ordinary] [S9:99] [R22222222-2222-4222-8222-222222222222:14]\n\n'
      + `\`${compact}\`\n\n\`\`\`\n${compact}\n\`\`\`\n\n    ${compact}\n\n!${compact}\n\n`
      + `${compact}: https://example.com/reference\n[ordinary]: https://example.com/ordinary\n`
      + '[S9:99]: https://example.com/unknown\n[R22222222-2222-4222-8222-222222222222:14]: https://example.com/unknown-revision');
    expect(html.match(/class="er-citation"/g)).toHaveLength(1);
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
    expect(html).not.toContain('class="er-citation"');
  });

  it('does not promote arbitrary registered text to a citation reference', () => {
    const html = render('[ordinary]\n\n[ordinary]: https://example.com/ordinary', [{ text: '[ordinary]', href }]);
    expect(html).toContain('<a href="https://example.com/ordinary">ordinary</a>');
    expect(html).not.toContain('class="er-citation"');
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
    expect(html.match(/class="er-citation"/g)).toHaveLength(1);
    expect(html).toContain('start=42&amp;end=87');
    expect(html).not.toContain('katex-error');
  });

  it('keeps TeX and dollar expressions literal in inline and fenced code', () => {
    const literal = String.raw`\(x_1\) \[y^2\] $z$ ` + compact;
    const html = render(String.raw`Prose \(x\) ` + compact + '\n\n`' + literal + '`\n\n```tex\n' + literal + '\n```');
    expect(html.match(/<math /g)).toHaveLength(1);
    expect(html.match(/class="er-citation"/g)).toHaveLength(1);
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
    expect(html).toContain('Бумага &lt;&amp;&gt; · 14 (deleted)</a>');
    expect(html).toContain('revisionId=old%2F%23%26&amp;start=42&amp;end=87');
  });

  it('links paragraph, tight-list and GFM table labels to their exact reader range', () => {
    const html = render(`Paragraph ${compact}\n\n- Tight list ${compact}\n- Saved label ${persistent}\n\n| Evidence ${compact} | Value |\n| --- | --- |\n| Table cell ${persistent} | **Emphasis ${compact}** |`);
    expect(html.match(/<a /g)).toHaveLength(6);
    expect(html.match(/href="\/p\/project\/source\/source\?revisionId=11111111-1111-4111-8111-111111111111&amp;start=42&amp;end=87"/g)).toHaveLength(6);
    expect(html).toContain('<li>Tight list <a class="er-citation"');
    expect(html).toContain('<th>Evidence <a class="er-citation"');
    expect(html).toContain('<td>Table cell <a class="er-citation"');
    expect(html).toContain('<strong>Emphasis <a class="er-citation"');
  });

  it('keeps citation-looking labels in inline and fenced code literal', () => {
    const html = render(`Prose ${compact}, inline \`${compact}\`.\n\n- Code \`${persistent}\`\n\n\`\`\`text\n${compact} ${persistent}\n\`\`\``);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(`<code>${compact}</code>`);
    expect(html).toContain(`<code>${persistent}</code>`);
    expect(html).toContain(`<pre><code class="language-text">${compact} ${persistent}\n</code></pre>`);
  });

  it('renders an optional title label while keeping the exact token literal inside code', () => {
    const displayLabel = 'Paper title · 14';
    const labelled: MarkdownReference[] = [{ text: persistent, label: displayLabel, href }];
    const html = render(`${persistent} and inline \`${persistent}\`.\n\n\`\`\`text\n${persistent}\n\`\`\``, labelled);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('class="er-citation"');
    expect(html).toContain(`>${displayLabel}</a>`);
    expect(html).toContain(`<code>${persistent}</code>`);
    expect(html).toContain(`<pre><code class="language-text">${persistent}\n</code></pre>`);
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
