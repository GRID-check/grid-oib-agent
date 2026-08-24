/**
 * FileCard Component
 *
 * Expandable card displaying a file artifact from deep research.
 * Shows filename header with expandable content view.
 *
 * SSE Events:
 * - artifact.update (type: "file"): Creates card with filename and content
 */

'use client'

import { type FC, useState } from 'react'
import { ChevronDown, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { useLocale, useTranslations } from '@/i18n'
import { formatTime } from '@/shared/utils/format-time'

/** File artifact information from SSE events */
export interface FileInfo {
  /** Unique identifier for this file */
  id: string
  /** File name/path */
  filename: string
  /** File content */
  content: string
  /** When file was created/updated */
  timestamp?: Date | string
}

interface FileCardProps {
  /** File artifact information */
  file: FileInfo
}

/**
 * Get file extension for display styling
 */
const getFileExtension = (filename: string): string => {
  const parts = filename.split('.')
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
}

/**
 * Check if file content should be rendered as markdown
 */
const isMarkdownFile = (filename: string): boolean => {
  const ext = getFileExtension(filename)
  return ['md', 'markdown'].includes(ext)
}

/**
 * Expandable card showing a file artifact's details.
 */
export const FileCard: FC<FileCardProps> = ({ file }) => {
  const [isExpanded, setIsExpanded] = useState(false)
  const t = useTranslations('research')
  const { locale } = useLocale()

  // Content preview (first 100 chars)
  const contentPreview = file.content
    ? file.content.substring(0, 100).replace(/\n/g, ' ') + (file.content.length > 100 ? '...' : '')
    : ''

  const shouldRenderMarkdown = isMarkdownFile(file.filename)

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border bg-muted">
      {/* Header - always visible */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        aria-controls={`file-content-${file.id}`}
        className="w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
      >
        <div className="flex w-full items-center gap-2 px-3 py-2">
          {/* File Icon */}
          <span className="shrink-0 text-muted-foreground" aria-hidden="true">
            <FileText className="size-4" />
          </span>

          {/* File Info */}
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-semibold">{file.filename}</span>
          </div>

          {/* Line count */}
          {file.content && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {t('fileCard.lines', { count: file.content.split('\n').length })}
            </span>
          )}

          {/* Timestamp */}
          {file.timestamp && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatTime(file.timestamp, locale)}
            </span>
          )}

          {/* Expand/collapse icon */}
          <span
            className={cn(
              'text-muted-foreground transition-transform duration-quick motion-reduce:transition-none',
              isExpanded && 'rotate-180'
            )}
            aria-hidden="true"
          >
            <ChevronDown className="size-4" />
          </span>
        </div>
      </button>

      {/* Collapsed preview */}
      {!isExpanded && contentPreview && (
        <div className="flex border-t px-3 pb-2">
          <span className="mt-1 truncate font-mono text-sm text-muted-foreground">
            {contentPreview}
          </span>
        </div>
      )}

      {/* Expanded content */}
      {isExpanded && (
        <div id={`file-content-${file.id}`} className="flex flex-col gap-3 border-t px-3 pb-3">
          {/* File Content */}
          {file.content && (
            <div className="mt-2 flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase text-muted-foreground">
                {t('fileCard.content')}
              </span>
              {shouldRenderMarkdown ? (
                <div className="max-h-96 overflow-auto rounded bg-muted p-2">
                  <MarkdownRenderer content={file.content} compact />
                </div>
              ) : (
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">
                  {file.content}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
