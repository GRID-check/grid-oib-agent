'use client'

/**
 * The bulk bar under a selection: „{n} ausgewählt · Wie vorgeschlagen ablegen
 * · Verwerfen“ (DECISION §9, „Bulk“).
 *
 * „Wie vorgeschlagen ablegen“ is offered only when every selected mail is
 * complete (`incompleteReason`): one request about several mails carries no
 * acknowledgement (RT-S5), so a mail that needs one is filed on its own. The
 * reason it is not offered is said in a toggletip a finger can open, never in
 * a tooltip only a mouse can. Both actions confirm first; the filing's
 * confirmation lists where everything goes, grouped by folder and thread.
 */

import type { JSX } from 'react'
import { Info, X } from 'lucide-react'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { Toggletip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { IncompleteReason } from '../lib/completeness'

/** Why the selection cannot be filed as suggested, with how many mails it concerns; null when it can. */
export type BulkBlock = { reason: IncompleteReason | 'too_many'; count: number } | null

export interface SelectionBarProps {
  count: number
  /** Still reading the selected mails to decide whether they are complete. */
  checking: boolean
  block: BulkBlock
  max: number
  filing: boolean
  dismissing: boolean
  onFile: () => void
  onDismiss: () => void
  onClear: () => void
  className?: string
}

export function SelectionBar({ count, checking, block, max, filing, dismissing, onFile, onDismiss, onClear, className }: SelectionBarProps): JSX.Element {
  const t = useTranslations('inboundMail')
  const reason = block ? t(`bulk.blocked.${block.reason}`, { count: block.count, max }) : checking ? t('bulk.checking') : null
  return (
    <div
      role="toolbar"
      aria-label={t('bulk.selected', { count })}
      data-testid="inbound-mail-selection-bar"
      className={cn(
        'bg-card flex flex-col gap-1.5 rounded-md border p-1.5 shadow-sm',
        'animate-in fade-in-0 slide-in-from-bottom-1 duration-base motion-reduce:animate-none',
        className
      )}
    >
      {/* Two rows on purpose: the list is 22rem, and the count, the reason and both actions in one row wrapped one button alone. */}
      <div className="flex items-center gap-1">
        <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t('bulk.clear')} onClick={onClear} data-testid="selection-clear">
          <X className="size-4" aria-hidden />
        </Button>
        <span className="text-sm font-medium tabular-nums">{t('bulk.selected', { count })}</span>
        {reason && (
          <Toggletip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground touch-target ml-auto inline-flex size-7 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                aria-label={reason}
                data-testid="selection-why"
              >
                <Info className="size-4" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">{reason}</TooltipContent>
          </Toggletip>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <BusyButton
          type="button"
          size="sm"
          busy={filing}
          busyLabel={t('bulk.fileSuggestedBusy')}
          blocked={dismissing}
          disabled={checking || block !== null}
          onClick={onFile}
          className="min-w-0 flex-1"
          data-testid="selection-file"
        >
          {t('bulk.fileSuggested')}
        </BusyButton>
        <BusyButton
          type="button"
          size="sm"
          variant="outline"
          busy={dismissing}
          busyLabel={t('bar.dismissBusy')}
          blocked={filing}
          onClick={onDismiss}
          data-testid="selection-dismiss"
        >
          {t('bulk.dismiss')}
        </BusyButton>
      </div>
    </div>
  )
}
