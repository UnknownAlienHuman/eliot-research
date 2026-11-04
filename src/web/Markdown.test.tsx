import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { Markdown, citationHref, citationLabel, type MarkdownReference } from './Markdown';

const compact = '[S1:14]';
const persistent = '[R11111111-1111-4111-8111-111111111111:14]';
const href = '/p/project/source/source?revisionId=11111111-1111-4111-8111-111111111111&start=42&end=87';
const references = [{ text: compact, href }, { text: persistent, href }];
function render(text: string, refs: readonly MarkdownReference[] = references) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Markdown, { text, references: refs })));
}

describe('Markdown citation rendering', () => {
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
