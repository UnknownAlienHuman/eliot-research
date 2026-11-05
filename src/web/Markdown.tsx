import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Link } from 'react-router';
import ReactMarkdown, { type ExtraProps } from 'react-markdown';
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
  position?: ReturnType<typeof fromMarkdown>['position'];
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

function DisplayMath({ children }: { readonly children: ReactNode }) {
  const scroll = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const measure = () => setOverflow(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const math = element.querySelector('math');
    if (math) observer.observe(math);
    return () => observer.disconnect();
  }, [children]);
  return <div className='er-math-block'>
    <div ref={scroll} className='er-math-scroll' tabIndex={overflow ? 0 : undefined}
      role={overflow ? 'region' : undefined} aria-label={overflow ? 'Scrollable mathematical expression' : undefined}
      aria-describedby={overflow ? hintId : undefined}>{children}</div>
    {overflow ? <p id={hintId} className='er-math-hint'>↔ Swipe or use arrow keys to read the full formula.</p> : null}
  </div>;
}

function MathSpan({ node, children, ...props }: ComponentProps<'span'> & ExtraProps) {
  const span = <span {...props}>{children}</span>;
  return node?.children.some(child => child.type === 'element' && child.tagName === 'math' && child.properties.display === 'block')
    ? <DisplayMath>{span}</DisplayMath> : span;
}

export function Markdown({ text, references = [] }: { readonly text: string; readonly references?: readonly MarkdownReference[] }) {
  const markdown = mathDelimiters(text);
  // Micromark omits exactly one leading BOM from its source offsets.
  const sourceOffset = markdown.charCodeAt(0) === 0xfeff ? 1 : 0;
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
  // Code and explicit links are literal boundaries, including their descendants.
  // A definition must not redirect exact registered citation atoms, even when
  // adjacent atoms parse as one full-reference link.
  function citationLinks() {
    function visit(node: MarkdownNode): void {
      if (!node.children || node.tagName === 'code' || node.tagName === 'pre' || node.tagName === 'a') return;
      node.children = node.children.flatMap((child) => {
        if (child.type === 'text' && child.value !== undefined) return linkify(child.value);
        if (child.tagName === 'a') {
          const start = child.position?.start.offset, end = child.position?.end.offset;
          const source = start === undefined || end === undefined ? '' : markdown.slice(start + sourceOffset, end + sourceOffset);
          const labels = source.match(/\[(?:S\d+|R[\da-fA-F]{8}(?:-[\da-fA-F]{4}){3}-[\da-fA-F]{12}):\d+\]/g);
          if (labels?.join('') === source && labels.every(label => references.some(ref => ref.text === label))) {
            return labels.flatMap(linkify);
          }
        }
        visit(child);
        return [child];
      });
    }
    return visit;
  }
  return <ReactMarkdown skipHtml remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]} rehypePlugins={[citationLinks, [rehypeKatex, { output: 'mathml', trust: false, errorColor: 'currentColor' }]]} components={{ img: () => null,
    span: MathSpan,
    a: ({ href, children, title }) => references.some((ref) => ref.href === href)
      ? <Link className='er-citation' to={href ?? ''} title={title}>{children}</Link>
      : <a href={href} title={title}>{children}</a>,
  }}>{markdown}</ReactMarkdown>;
}
