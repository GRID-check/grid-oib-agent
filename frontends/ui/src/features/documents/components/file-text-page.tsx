'use client'

/**
 * A text document, rendered as a page.
 *
 * `.txt`, `.md` and `.csv` are accepted at upload and had no viewer: they drew
 * the same grey "download it to read it" mock as a format we genuinely cannot
 * open. They are the formats where that mock was least defensible — the bytes
 * ARE the content, and every other pane in this product renders text.
 *
 * The three shapes get three renderings rather than one `<pre>`, because the
 * difference is the whole point of opening the file: a Markdown checklist read
 * as headings and boxes is a checklist, and read as asterisks it is a diff.
 */

import { useMemo } from 'react'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { parseDelimited } from '@/lib/text/delimited'
import { cn } from '@/lib/utils'

/** Content types this page can render — the client half of `TEXT_PREVIEW_CONTENT_TYPES`. */
export const TEXT_PAGE_TYPES = ['text/plain', 'text/markdown', 'text/x-markdown', 'text/csv']

export function isTextPageType(contentType: string | null | undefined): boolean {
  return TEXT_PAGE_TYPES.includes(contentType ?? '')
}

export function FileTextPage({
  text,
  truncated,
  contentType,
  truncatedLabel,
  peeking,
  className,
}: {
  text: string
  truncated: boolean
  contentType: string | null | undefined
  /** "Only the beginning of this file is shown…" — the caller owns the wording. */
  truncatedLabel: string
  peeking?: boolean
  className?: string
}) {
  const kind = contentType === 'text/csv' ? 'csv' : contentType === 'text/plain' ? 'plain' : 'markdown'

  return (
    <div
      className={cn(
        // The same page the PDF iframe and the image get: a sheet on the well's
        // ground, on the elevation step the surrounding pane already uses.
        'bg-background h-fit w-full max-w-[720px] overflow-hidden rounded-lg border',
        peeking ? 'shadow-sm' : 'shadow-lg',
        className
      )}
    >
      <div className={cn('overflow-x-auto', peeking ? 'p-4' : 'p-6')}>
        {kind === 'csv' ? (
          <DelimitedTable text={text} />
        ) : kind === 'plain' ? (
          // `break-words` because a log line or a pasted URL has no spaces and
          // would otherwise set the width of the page it is on.
          <pre className="text-foreground whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed">
            {text}
          </pre>
        ) : (
          <MarkdownRenderer content={text} />
        )}
      </div>
      {truncated && (
        <p className="text-muted-foreground border-t bg-muted/30 px-6 py-2.5 text-xs leading-relaxed">
          {truncatedLabel}
        </p>
      )}
    </div>
  )
}

/**
 * The first row is treated as a header — which is a guess, and the right one:
 * an export without headers renders its first data row in bold, which misleads
 * nobody, while a header row rendered as data loses the only labels the table
 * has.
 */
function DelimitedTable({ text }: { text: string }) {
  const { rows } = useMemo(() => parseDelimited(text), [text])
  if (rows.length === 0) return null

  const [head, ...body] = rows
  // Ragged rows are normal in exports; pad to the widest so the header never
  // sits over a cell from the wrong column.
  const columns = Math.max(...rows.map((row) => row.length))

  return (
    <table className="w-full border-collapse text-left text-sm">
      <thead>
        <tr>
          {Array.from({ length: columns }, (_, index) => (
            <th
              key={index}
              className="text-foreground border-b px-2.5 py-1.5 align-bottom font-medium"
            >
              {head[index] ?? ''}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((row, rowIndex) => (
          <tr key={rowIndex} className="border-b last:border-b-0">
            {Array.from({ length: columns }, (_, index) => (
              <td key={index} className="text-foreground/90 px-2.5 py-1.5 align-top">
                {row[index] ?? ''}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
