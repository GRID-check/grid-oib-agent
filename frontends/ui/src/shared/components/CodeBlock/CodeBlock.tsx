/**
 * CodeBlock Component
 *
 * Bespoke replacement for KUI's CodeSnippet: a `<pre>` block with a language
 * label, a copy-to-clipboard button, and optional collapse/expand behavior
 * for long code blocks (> `maxLines`).
 */

'use client'

import { type FC, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Check, ChevronDown, ChevronUp, Copy } from 'lucide-react'
import { AnimatePresence, motion, springSnappy } from '@/components/motion'
import { useTranslations } from '@/i18n'

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
  const t = useTranslations('common')
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
      // Clipboard API unavailable or blocked (e.g. insecure context, denied
      // permission) — surface the failure instead of swallowing it silently.
      toast.error(t('states.copyFailed'))
    }
  }

  return (
    <div className={`border-base my-3 overflow-hidden rounded-xl border bg-muted ${className}`}>
      <div className="border-base flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-subtle text-xs font-medium uppercase tracking-wide">
          {language || 'text'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
          className="text-subtle hover:text-primary inline-flex min-h-7 items-center gap-1 rounded-full px-2 text-xs transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {/* Icon swap with a brief scale pop on copy feedback */}
          <AnimatePresence mode="popLayout" initial={false}>
            {copied ? (
              <motion.span
                key="check"
                className="inline-flex"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={springSnappy}
              >
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              </motion.span>
            ) : (
              <motion.span
                key="copy"
                className="inline-flex"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={springSnappy}
              >
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              </motion.span>
            )}
          </AnimatePresence>
          {copied ? t('codeBlock.copied') : t('codeBlock.copy')}
        </button>
      </div>

      <pre className="overflow-x-auto p-3 font-mono text-sm leading-relaxed">
        <code>{displayValue}</code>
      </pre>

      {isCollapsible && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="border-base text-subtle hover:text-primary flex min-h-8 w-full items-center justify-center gap-1 border-t px-3 py-1.5 text-xs transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
          aria-expanded={expanded}
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              {t('codeBlock.showLess')}
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              {t('codeBlock.showAll', { count: lines.length })}
            </>
          )}
        </button>
      )}
    </div>
  )
}
