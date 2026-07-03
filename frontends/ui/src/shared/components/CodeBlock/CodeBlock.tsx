// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CodeBlock Component
 *
 * Bespoke replacement for KUI's CodeSnippet: a `<pre>` block with a language
 * label, a copy-to-clipboard button, and optional collapse/expand behavior
 * for long code blocks (> `maxLines`).
 */

'use client'

import { type FC, useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Copy } from 'lucide-react'

export interface CodeBlockProps {
  /** Raw code content to display */
  value: string
  /** Language label shown in the header (e.g. "typescript") */
  language?: string
  /** Whether the block should collapse when it exceeds maxLines */
  collapsible?: boolean
  /** Number of lines to show before collapsing (default 15) */
  maxLines?: number
  /** Additional CSS classes for the wrapper */
  className?: string
}

export const CodeBlock: FC<CodeBlockProps> = ({
  value,
  language,
  collapsible = false,
  maxLines = 15,
  className = '',
}) => {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const lines = useMemo(() => value.split('\n'), [value])
  const isCollapsible = collapsible && lines.length > maxLines
  const displayValue = isCollapsible && !expanded ? lines.slice(0, maxLines).join('\n') : value

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API unavailable — silently ignore
    }
  }

  return (
    <div className={`bg-surface-raised border-base my-3 overflow-hidden rounded-lg border ${className}`}>
      <div className="border-base flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-subtle text-xs font-medium uppercase tracking-wide">
          {language || 'text'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          className="text-subtle hover:text-primary inline-flex items-center gap-1 text-xs"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <pre className="overflow-x-auto p-3 text-sm">
        <code>{displayValue}</code>
      </pre>

      {isCollapsible && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="border-base text-subtle hover:text-primary flex w-full items-center justify-center gap-1 border-t px-3 py-1.5 text-xs"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              Show all ({lines.length} lines)
            </>
          )}
        </button>
      )}
    </div>
  )
}
