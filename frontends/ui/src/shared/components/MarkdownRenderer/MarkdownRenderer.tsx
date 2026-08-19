'use client'

import { type FC, type ReactNode, memo, useCallback, useMemo } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import type { PluggableList } from 'unified'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { CodeBlock } from '@/shared/components/CodeBlock'
import type { MarkdownRendererProps } from './types'
import { scrollToAnchor, useInPageAnchorRenderer } from './anchor-context'
import { MARKDOWN_SLOT_TAG, useMarkdownSlotRenderer } from './slot-context'
import { isInternalHref, useInternalLinkRenderer } from './internal-link-context'
import { markdownHeadings } from './headings'
import { getLanguageFromClassName, headingAnchorId } from './utils'

function getTextFromChildren(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getTextFromChildren).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return getTextFromChildren((node as React.ReactElement).props.children)
  }
  return ''
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
// Exported for its own spec. It is the one part of this module with a cost that
// depends on the shape of the input rather than its size, so it is measured
// directly: timing it through a React render measures the render.
export function stabilizeStreamingMarkdown(raw: string): string {
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
    // `(?:\|\s*)?` rather than `\|?\s*`: the earlier form put two `\s*` either
    // side of an optional pipe, and on a line of pure whitespace the engine can
    // split that whitespace between them in quadratically many ways — 32k tabs
    // took 1,034ms. Requiring a literal pipe to enter the group removes the
    // overlap, and this runs on every token of every streaming answer.
    const hasDelimiterRow = tableLines.some((l) => /^\s*(?:\|\s*)?:?-/.test(l) && l.includes('-'))
    if (!hasDelimiterRow) {
      // Escape the leading pipes so react-markdown renders them as text, not a
      // broken table, until the delimiter row streams in. Backslashes first:
      // a pipe that is already escaped (`\|`) must not have its escape
      // re-escaped, which would leave the pipe unescaped (js/incomplete-sanitization).
      for (let i = start; i < end; i++) {
        lines[i] = lines[i].replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
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
 * @param remarkPlugins - Extra remark plugins, run after GFM and math
 */
export const MarkdownRenderer: FC<MarkdownRendererProps> = memo(
  ({ content, className = '', compact = false, isStreaming = false, remarkPlugins }) => {
    const renderInPageAnchor = useInPageAnchorRenderer()
    const renderInternalLink = useInternalLinkRenderer()
    const renderSlot = useMarkdownSlotRenderer()
    const plugins = useMemo(
      (): PluggableList => [remarkGfm, remarkMath, ...(remarkPlugins ?? [])],
      [remarkPlugins]
    )
    // While streaming, run partial content through the stabilizer so half-formed
    // fences/tables don't thrash the layout token-by-token. Finalized content is
    // rendered verbatim.
    const renderedContent = useMemo(
      () => (isStreaming ? stabilizeStreamingMarkdown(content) : content),
      [isStreaming, content]
    )
    /**
     * The id of every heading in this document, keyed by the source line it was
     * written on.
     *
     * Ids are unique per document — two „Bewertung" sections are `bewertung`
     * and `bewertung-2` — and that uniqueness cannot be established from inside
     * a per-heading callback, which knows nothing about the headings before it
     * and runs whenever React decides to run it. So it is settled here, by a
     * pure pass over the same string `ReactMarkdown` is handed, and the
     * callbacks only look their answer up. See {@link markdownHeadings} for why
     * every counting variant of this fails, and `report-outline` for the other
     * caller — the outline offers exactly the ids this map assigns.
     */
    const headingIds = useMemo(() => {
      const byLine = new Map<number, string>()
      for (const heading of markdownHeadings(renderedContent)) byLine.set(heading.line, heading.id)
      return byLine
    }, [renderedContent])

    /**
     * The id for one heading element. The line the heading was written on is a
     * property of the text, not of the render, so it survives a render React
     * restarts or interleaves with another instance's.
     *
     * The fallback is the id this heading carried before ids were made unique:
     * a setext heading (which the scan deliberately does not read) and a
     * heading a remark plugin invented (which has no source line) still get an
     * anchor, just not a disambiguated one.
     */
    const headingId = useCallback(
      (node: ExtraProps['node'], children: ReactNode): string => {
        const line = node?.position?.start.line
        const assigned = line === undefined ? undefined : headingIds.get(line)
        return assigned ?? headingAnchorId(getTextFromChildren(children))
      },
      [headingIds]
    )

    // Custom component mappings
    const components: Components = useMemo(
      () => ({
        // A position a remark plugin marked for the surface to fill (see
        // `slot-context`). Cast because `Components` is keyed by intrinsic
        // elements and this tag is deliberately not one of them — that is what
        // guarantees the markdown itself can never produce it.
        [MARKDOWN_SLOT_TAG]: ({ index }: { index?: string }) => {
          const position = Number(index)
          if (!renderSlot || !Number.isInteger(position)) return null
          return <>{renderSlot(position)}</>
        },

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
        h1: ({ children, node }: React.ComponentPropsWithoutRef<'h1'> & ExtraProps) => {
          const id = headingId(node, children)
          return (
            <h1 id={id} className="mb-3 mt-6 block scroll-mt-4 text-2xl font-semibold tracking-tight text-foreground">
              {children}
            </h1>
          )
        },
        h2: ({ children, node }: React.ComponentPropsWithoutRef<'h2'> & ExtraProps) => {
          const id = headingId(node, children)
          return (
            <h2 id={id} className="mb-2 mt-5 block scroll-mt-4 text-xl font-semibold tracking-tight text-foreground">
              {children}
            </h2>
          )
        },
        h3: ({ children, node }: React.ComponentPropsWithoutRef<'h3'> & ExtraProps) => {
          const id = headingId(node, children)
          return (
            <h3 id={id} className="mb-2 mt-4 block scroll-mt-4 text-base font-semibold tracking-tight text-foreground">
              {children}
            </h3>
          )
        },
        h4: ({ children, node }: React.ComponentPropsWithoutRef<'h4'> & ExtraProps) => {
          const id = headingId(node, children)
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
          // In-app links stay in the app. A surface that knows the destination
          // may render something better than a link — the chat answer turns a
          // model deep link into an element chip.
          if (isInternalHref(href)) {
            if (renderInternalLink) {
              return <>{renderInternalLink({ href, children })}</>
            }
            return (
              <a href={href} className="text-brand underline underline-offset-2 hover:opacity-80">
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
      }) as Components,
      [compact, headingId, renderInPageAnchor, renderInternalLink, renderSlot]
    )

    return (
      <div className={`markdown-content break-words [overflow-wrap:anywhere] [&>*:last-child]:mb-0 ${className}`}>
        <ReactMarkdown
          remarkPlugins={plugins}
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
