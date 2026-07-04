'use client'

import { type FC, type ReactNode, memo, useMemo } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from '@/shared/components/CodeBlock'
import type { MarkdownRendererProps } from './types'
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
 * MarkdownRenderer - Renders markdown content with shadcn-idiomatic styling
 *
 * @param content - Markdown string to render
 * @param isStreaming - Whether content is still streaming (disables memoization)
 * @param className - Additional CSS classes
 * @param compact - Use smaller text sizes for chat bubbles
 */
export const MarkdownRenderer: FC<MarkdownRendererProps> = memo(
  ({ content, className = '', compact = false }) => {
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
              className="text-primary rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.875em]"
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
            <h1 id={id} className="text-primary mb-3 mt-6 block scroll-mt-4 text-2xl font-semibold tracking-tight">
              {children}
            </h1>
          )
        },
        h2: ({ children }) => {
          const id = slugify(getTextFromChildren(children))
          return (
            <h2 id={id} className="text-primary mb-2 mt-5 block scroll-mt-4 text-xl font-semibold tracking-tight">
              {children}
            </h2>
          )
        },
        h3: ({ children }) => {
          const id = slugify(getTextFromChildren(children))
          return (
            <h3 id={id} className="text-primary mb-2 mt-4 block scroll-mt-4 text-base font-semibold tracking-tight">
              {children}
            </h3>
          )
        },
        h4: ({ children }) => {
          const id = slugify(getTextFromChildren(children))
          return (
            <h4 id={id} className="text-primary mb-1 mt-3 block scroll-mt-4 text-sm font-semibold">
              {children}
            </h4>
          )
        },

        // Paragraphs
        p: ({ children }) => (
          <p className={`text-primary mb-3 block leading-relaxed ${compact ? 'text-sm' : 'text-base'}`}>
            {children}
          </p>
        ),

        // Lists
        ul: ({ children }) => (
          <ul className="text-primary mb-3 list-outside list-disc space-y-1 pl-5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="text-primary mb-3 list-outside list-decimal space-y-1 pl-5">{children}</ol>
        ),
        li: ({ children }) => (
          <li className={`text-primary ${compact ? 'text-sm' : 'text-base'}`}>{children}</li>
        ),

        // Links — anchor hrefs scroll in-page; external hrefs open new tabs
        a: ({ href, children }) => {
          if (href?.startsWith('#')) {
            return (
              <a
                href={href}
                className="text-brand underline underline-offset-2 hover:opacity-80"
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault()
                  const el = document.getElementById(href.slice(1))
                  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
          <strong className="text-primary font-semibold">{children}</strong>
        ),
        em: ({ children }) => <em className="text-primary italic">{children}</em>,

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
          <th className="text-primary px-3 py-2 text-left text-sm font-semibold">{children}</th>
        ),
        td: ({ children }) => (
          <td className="text-primary px-3 py-2 text-sm">{children}</td>
        ),
      }),
      [compact]
    )

    return (
      <div className={`markdown-content break-words [overflow-wrap:anywhere] [&>*:last-child]:mb-0 ${className}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </ReactMarkdown>
      </div>
    )
  }
)

MarkdownRenderer.displayName = 'MarkdownRenderer'
