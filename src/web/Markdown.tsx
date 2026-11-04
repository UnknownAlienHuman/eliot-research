import { Link } from 'react-router';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Citation } from '../citations';
import './markdown.css';

export function citationHref(projectId: string, citation: Citation): string {
  return '/p/' + encodeURIComponent(projectId) + '/source/' + encodeURIComponent(citation.sourceId)
    + '?revisionId=' + encodeURIComponent(citation.revisionId) + '&start=' + citation.start + '&end=' + citation.end;
}

export function citationLabel(citation: Citation): string {
  return citation.sourceTitle + ' · ' + citation.block + (citation.deleted ? ' (deleted)' : '');
}

export interface MarkdownReference { readonly text: string; readonly href: string; readonly label?: string; }
interface MarkdownNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: object;
  children?: MarkdownNode[];
}
interface SourceNode {
  type: string;
  children?: SourceNode[] | undefined;
  position?: ReturnType<typeof fromMarkdown>['position'];
}

// Adapt complete TeX delimiters to remark-math syntax; KaTeX owns math parsing.
// Unfinished streaming expressions and code stay literal.
function mathDelimiters(text: string): string {
  if (!text.includes('\\(') && !text.includes('\\[')) return text;
  const literalRanges: Array<{ start: number; end: number }> = [];
  function protect(node: SourceNode): void {
    if (['code', 'inlineCode', 'link', 'linkReference', 'definition', 'image', 'imageReference', 'html'].includes(node.type)) {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) literalRanges.push({ start, end });
      return;
    }
    node.children?.forEach(protect);
  }
  protect(fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
  return text.replace(/(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)|(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g,
    (match: string, inline: string | undefined, display: string | undefined, at: number) => {
      if (literalRanges.some((range) => at < range.end && at + match.length > range.start)) return match;
      return display === undefined ? '$$' + inline + '$$' : '\n$$\n' + display.trim() + '\n$$\n';
    });
}

export function Markdown({ text, references = [] }: { readonly text: string; readonly references?: readonly MarkdownReference[] }) {
  function linkify(value: string): MarkdownNode[] {
    const hits = references.filter((ref) => ref.text !== '').flatMap((ref) => {
      const found: { at: number; ref: MarkdownReference }[] = [];
      let at = value.indexOf(ref.text);
      while (at !== -1) { found.push({ at, ref }); at = value.indexOf(ref.text, at + ref.text.length); }
      return found;
    }).sort((a, b) => a.at - b.at || b.ref.text.length - a.ref.text.length);
    const parts: MarkdownNode[] = [];
    let pos = 0;
    for (const { at, ref } of hits) {
      if (at < pos) continue;
      parts.push({ type: 'text', value: value.slice(pos, at) }, {
        type: 'element', tagName: 'a', properties: { href: ref.href },
        children: [{ type: 'text', value: ref.label ?? ref.text }],
      });
      pos = at + ref.text.length;
    }
    parts.push({ type: 'text', value: value.slice(pos) });
    return parts;
  }
  // Transform text nodes at every prose depth, before React components render.
  // Code and existing links are literal boundaries, including their descendants.
  function citationLinks() {
    function visit(node: MarkdownNode): void {
      if (!node.children || node.tagName === 'code' || node.tagName === 'pre' || node.tagName === 'a') return;
      node.children = node.children.flatMap((child) => {
        if (child.type === 'text' && child.value !== undefined) return linkify(child.value);
        visit(child);
        return [child];
      });
    }
    return visit;
  }
  return <ReactMarkdown skipHtml remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]} rehypePlugins={[citationLinks, [rehypeKatex, { output: 'mathml', trust: false, errorColor: 'currentColor' }]]} components={{ img: () => null,
    a: ({ href, children, title }) => references.some((ref) => ref.href === href)
      ? <Link className='er-citation' to={href ?? ''} title={title}>{children}</Link>
      : <a href={href} title={title}>{children}</a>,
  }}>{mathDelimiters(text)}</ReactMarkdown>;
}
