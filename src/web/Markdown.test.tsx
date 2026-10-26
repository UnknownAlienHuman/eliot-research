import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

const compact = '[S1:14]';
const persistent = '[R11111111-1111-4111-8111-111111111111:14]';
const href = '/p/project/source/source?revisionId=11111111-1111-4111-8111-111111111111&start=42&end=87';
const references = [{ text: compact, href }, { text: persistent, href }];
function render(text: string) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Markdown, { text, references })));
}

describe('Markdown citation rendering', () => {
  it('links paragraph, tight-list and GFM table labels to their exact reader range', () => {
    const html = render(`Paragraph ${compact}\n\n- Tight list ${compact}\n- Saved label ${persistent}\n\n| Evidence ${compact} | Value |\n| --- | --- |\n| Table cell ${persistent} | **Emphasis ${compact}** |`);
    expect(html.match(/<a /g)).toHaveLength(6);
    expect(html.match(/href="\/p\/project\/source\/source\?revisionId=11111111-1111-4111-8111-111111111111&amp;start=42&amp;end=87"/g)).toHaveLength(6);
    expect(html).toContain('<li>Tight list <a ');
    expect(html).toContain('<th>Evidence <a ');
    expect(html).toContain('<td>Table cell <a ');
    expect(html).toContain('<strong>Emphasis <a ');
  });

  it('keeps citation-looking labels in inline and fenced code literal', () => {
    const html = render(`Prose ${compact}, inline \`${compact}\`.\n\n- Code \`${persistent}\`\n\n\`\`\`text\n${compact} ${persistent}\n\`\`\``);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(`<code>${compact}</code>`);
    expect(html).toContain(`<code>${persistent}</code>`);
    expect(html).toContain(`<pre><code class="language-text">${compact} ${persistent}\n</code></pre>`);
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
