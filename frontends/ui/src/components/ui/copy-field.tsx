'use client'

/**
 * CopyField — a read-only value in monospace with a copy button beside it.
 *
 * For a value the reader takes somewhere else rather than edits: an address, a
 * token, an identifier. The value WRAPS rather than scrolling inside an
 * `<input>`: on a phone a 45-character address in a one-line field shows its
 * first 20 characters, and the reader cannot check what they are about to hand
 * out. One click selects all of it (`select-all`), so it can still be copied by
 * hand where the Clipboard API is refused. Below `sm` the button moves under
 * the value, which then gets the full width.
 *
 * The button says what happened, in words: its label turns to `copiedLabel` for
 * a moment and the change is announced (`aria-live`). A refused copy calls
 * `onCopyError` and never shows "copied".
 *
 * Knows no domain and no dictionary: the caller passes the labels, like
 * `ConfirmDialog`.
 */

import type { JSX } from 'react'
import { useId } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { cn } from '@/lib/utils'

export interface CopyFieldProps {
  value: string
  /** Accessible name of the value, e.g. "Projektadresse". */
  label: string
  copyLabel: string
  copiedLabel: string
  onCopyError?: () => void
  className?: string
}

export function CopyField({
  value,
  label,
  copyLabel,
  copiedLabel,
  onCopyError,
  className,
}: CopyFieldProps): JSX.Element {
  const valueId = useId()
  const { copied, copy } = useCopyToClipboard()

  const handleCopy = async (): Promise<void> => {
    const ok = await copy(value)
    if (!ok) onCopyError?.()
  }

  return (
    <div
      role="group"
      aria-label={label}
      className={cn('flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center', className)}
    >
      <code
        id={valueId}
        className="border-input bg-input-background flex min-h-10 min-w-0 items-center sm:flex-1 rounded-lg border px-3.5 py-2 font-mono text-sm break-all select-all"
      >
        {value}
      </code>
      <Button
        type="button"
        variant="outline"
        onClick={() => void handleCopy()}
        aria-controls={valueId}
        className="shrink-0"
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        <span aria-live="polite">{copied ? copiedLabel : copyLabel}</span>
      </Button>
    </div>
  )
}

/** The CopyField's footprint while its value loads, so nothing shifts when it lands. */
export function CopyFieldSkeleton({ className }: { className?: string }): JSX.Element {
  return (
    <div
      className={cn('flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center', className)}
      aria-hidden="true"
    >
      <Skeleton className="h-10 w-full min-w-0 rounded-lg sm:flex-1" />
      <Skeleton className="h-9 w-full shrink-0 pointer-coarse:h-11 sm:w-28" />
    </div>
  )
}
