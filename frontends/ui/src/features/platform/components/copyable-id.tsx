'use client'

/**
 * A machine id (turn, job, conversation) shown the way an operator uses it:
 * shortened in a mono cell, the full value one click away on the clipboard.
 *
 * The platform tables used to print these as a wrapped `<code>` line under the
 * row, which was the longest thing on the row and the least read. The id is
 * still all there: in the button's accessible name, its tooltip and the copy.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** First segment of a UUID-ish id, or the head of anything else. */
export function shortId(id: string, length = 8): string {
  const head = id.split('-')[0]
  const base = head.length >= 6 && head.length <= 12 ? head : id.slice(0, length)
  return base.length < id.length ? `${base}…` : base
}

export function CopyableId({
  id,
  copyLabel,
  copiedLabel,
  failedLabel,
  className,
  idClassName,
}: {
  id: string
  /** Accessible name of the copy button; should name the id. */
  copyLabel: string
  copiedLabel: string
  failedLabel: string
  className?: string
  /** E.g. `hidden sm:inline` to keep only the copy button on a phone. */
  idClassName?: string
}): JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    const write = navigator.clipboard?.writeText(id)
    if (!write) {
      toast.error(failedLabel)
      return
    }
    write
      .then(() => {
        setCopied(true)
        toast.success(copiedLabel)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => toast.error(failedLabel))
  }

  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <code
        className={cn('text-muted-foreground font-mono text-xs tabular-nums', idClassName)}
        title={id}
      >
        {shortId(id)}
      </code>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground pointer-coarse:size-9 size-7"
            aria-label={copyLabel}
            onClick={copy}
          >
            {copied ? (
              <Check className="size-3.5" aria-hidden />
            ) : (
              <Copy className="size-3.5" aria-hidden />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <span className="font-mono">{id}</span>
        </TooltipContent>
      </Tooltip>
    </span>
  )
}
