'use client'

import { type FC, type ReactNode, memo, useMemo } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { CodeBlock } from '@/shared/components/CodeBlock'
import type { MarkdownRendererProps } from './types'
import { scrollToAnchor, useInPageAnchorRenderer } from './anchor-context'
import { getLanguageFromClassName } from './utils'

function getTextFromChildren(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getTextFromChildren).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return getTextFromChildren((node as React.ReactElement).props.children)
  }
  return ''
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Stabilize half-arrived markdown DURING streaming so partial syntax doesn't
 * flip the layout token-by-token.
 *
 * Two failure modes are smoothed:
 *  1. An odd number of ``` fences — the trailing prose after a just-opened fence
 *     would otherwise render as a giant code card until its closing fence lands.
 *     We append a synthetic closing fence so the in-progress block renders as a
 *     (small) code block instead of swallowing everything below it.
 *  2. A GFM table whose delimiter row (`|---|`) hasn't streamed in yet — the
 *     header row alone would be mis-parsed. We hold the trailing header-only
 *     table lines back until the delimiter row exists, rendering them as plain
 *     text for the moment (they re-parse as a table once the delimiter arrives).
 *
 * This only runs while `isStreaming` is true; finalized content is passed
 * through untouched so the fully-formed markdown always wins.
 */
function stabilizeStreamingMarkdown(raw: string): string {
  let content = raw

  // 1) Auto-close an odd number of ``` fences.
  const fenceCount = (content.match(/```/g) ?? []).length
  if (fenceCount % 2 === 1) {
    // Ensure the synthetic fence starts on its own line.
    content += content.endsWith('\n') ? '```' : '\n```'
  }

  // 2) Defer a header-only GFM table (last block is table rows with no
  //    delimiter row yet). Only touch the trailing run of pipe lines.
  const lines = content.split('\n')
  let end = lines.length
  // Skip a trailing blank line so we look at the actual last content lines.
  while (end > 0 && lines[end - 1].trim() === '') end--
  let start = end
  while (start > 0 && lines[start - 1].trim().startsWith('|')) start--
  if (end - start >= 1) {
    const tableLines = lines.slice(start, end)
    const hasDelimiterRow = tableLines.some((l) => /^\s*\|?\s*:?-{1,}/.test(l) && l.includes('-'))
    if (!hasDelimiterRow) {
      // Escape the leading pipes so react-markdown renders them as text, not a
      // broken table, until the delimiter row streams in.
      for (let i = start; i < end; i++) {
        lines[i] = lines[i].replace(/\|/g, '\\|')
      }
      content = lines.join('\n')
    }
  }

  return content
}

/**
 * MarkdownRenderer - Renders markdown content with shadcn-idiomatic styling
 *
 * @param content - Markdown string to render
 * @param isStreaming - Whether content is still streaming (disables memoization)
 * @param className - Additional CSS classes
 * @param compact - Use smaller text sizes for chat bubbles
 */
export const MarkdownRenderer: FC<MarkdownRendererProps> = memo(
  ({ content, className = '', compact = false, isStreaming = false }) => {
    const renderInPageAnchor = useInPageAnchorRenderer()
    // While streaming, run partial content through the stabilizer so half-formed
    // fences/tables don't thrash the layout token-by-token. Finalized content is
    // rendered verbatim.
    const renderedContent = useMemo(
      () => (isStreaming ? stabilizeStreamingMarkdown(content) : content),
      [isStreaming, content]
    )
    // Custom component mappings
    const components: Components = useMemo(
      () => ({
        code: ({
          children,
          className: codeClassName,
          ...props
        }: React.ComponentPropsWithoutRef<'code'> & ExtraProps) => {
          // Check if this is a block code (has language class) vs inline
          const isBlock = codeClassName?.startsWith('language-')
          const codeContent = String(children).replace(/\n$/, '')

          if (isBlock) {
            const language = getLanguageFromClassName(codeClassName)
            const lineCount = codeContent.split('\n').length

            return (
              <CodeBlock
                value={codeContent}
                language={language}
                collapsible={lineCount > 15}
                maxLines={15}
              />
            )
          }

          // Inline code
          return (
            <code
              className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.875em] text-foreground"
              {...props}
            >
              {children}
            </code>
          )
        },

        // Skip default pre rendering since CodeBlock handles it
        pre: ({ children }) => <>{children}</>,

        // Headings — include id for in-page anchor navigation
        h1: ({ children }) => {
          const id = slugify(getTextFromChildren(children))
          return (
            <h1 id={id} className="mb-3 mt-6 block scroll-mt-4 text-2xl font-semibold tracking-tight text-foreground">
              {children}
            </h1>
          )
        },
        h2: ({ children }) => {
          const id = slugify(getTextFromChildren(children))
          return (
            <h2 id={id} className="mb-2 mt-5 block scroll-mt-4 text-xl font-semibold tracking-tight text-foreground">
              {children}
            </h2>
          )
        },
        h3: ({ children }) => {
          const id = slugify(getTextFromChildren(children))
          return (
            <h3 id={id} className="mb-2 mt-4 block scroll-mt-4 text-base font-semibold tracking-tight text-foreground">
              {children}
            </h3>
          )
        },
        h4: ({ children }) => {
          const id = slugify(getTextFromChildren(children))
          return (
            <h4 id={id} className="mb-1 mt-3 block scroll-mt-4 text-sm font-semibold text-foreground">
              {children}
            </h4>
          )
        },

        // Paragraphs
        p: ({ children }) => (
          <p className={`mb-3 block leading-relaxed text-foreground ${compact ? 'text-sm' : 'text-base'}`}>
            {children}
          </p>
        ),

        // Lists
        ul: ({ children }) => (
          <ul className="mb-3 list-outside list-disc space-y-1 pl-5 text-foreground">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-3 list-outside list-decimal space-y-1 pl-5 text-foreground">{children}</ol>
        ),
        li: ({ children }) => (
          <li className={`text-foreground ${compact ? 'text-sm' : 'text-base'}`}>{children}</li>
        ),

        // Links — anchor hrefs scroll in-page; external hrefs open new tabs
        a: ({ href, children }) => {
          if (href?.startsWith('#')) {
            // A surface that knows what this anchor MEANS can render it itself
            // — the chat answer turns its `[3]` into a citation with a preview.
            // Without a provider this falls through to the plain scroll link,
            // which is what every other markdown surface wants.
            if (renderInPageAnchor) {
              return <>{renderInPageAnchor({ href, children })}</>
            }
            return (
              <a
                href={href}
                className="text-brand underline underline-offset-2 hover:opacity-80"
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault()
                  scrollToAnchor(href.slice(1))
                }}
              >
                {children}
              </a>
            )
          }
          return (
            <a
              href={href ?? '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand underline underline-offset-2 hover:opacity-80"
            >
              {children}
            </a>
          )
        },

        // Emphasis
        strong: ({ children }) => (
          <strong className="font-semibold text-foreground">{children}</strong>
        ),
        em: ({ children }) => <em className="italic text-foreground">{children}</em>,

        // Blockquotes
        blockquote: ({ children }) => (
          <blockquote className="border-base text-subtle my-3 border-l-2 pl-4 italic leading-relaxed">
            {children}
          </blockquote>
        ),

        // Horizontal rule
        hr: () => <hr className="border-base my-4" />,

        // Tables (GFM)
        table: ({ children }) => (
          <div className="border-base my-4 overflow-x-auto rounded-xl border">
            <table className="min-w-full">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
        tbody: ({ children }) => <tbody>{children}</tbody>,
        tr: ({ children }) => <tr className="border-base border-b last:border-b-0">{children}</tr>,
        th: ({ children }) => (
          <th className="px-3 py-2 text-left text-sm font-semibold text-foreground">{children}</th>
        ),
        td: ({ children }) => (
          <td className="px-3 py-2 text-sm text-foreground">{children}</td>
        ),
      }),
      [compact, renderInPageAnchor]
    )

    return (
      <div className={`markdown-content break-words [overflow-wrap:anywhere] [&>*:last-child]:mb-0 ${className}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
          components={components}
        >
          {renderedContent}
        </ReactMarkdown>
      </div>
    )
  }
)

MarkdownRenderer.displayName = 'MarkdownRenderer'
