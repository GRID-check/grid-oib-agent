'use client'

/**
 * The decision about one mail, pinned to the bottom of the detail: „Verwerfen“
 * on the left, the one primary action on the right, and between them only
 * what the press still needs.
 *
 * The primary label is computed from the draft and says exactly what will
 * happen („2 Dateien und den E-Mail-Text ablegen“, „In E-Mail-Verlauf
 * „Stellplatznachweis“ ablegen (wird Fassung 4)“, „Nichts ablegen“). Above it:
 * the sender confirmation where filing needs it („Domain nicht bestätigt.
 * Trotzdem ablegen“), what still blocks the press, and the one consequence a
 * person would not guess (without the text, the original is erased).
 *
 * On a phone the bar is the bottom edge: the two buttons stack full width
 * with the primary nearest the thumb, and the home indicator's inset pads it.
 * Busy is not disabled: a pressed button keeps its focus and its width.
 */

import type { JSX } from 'react'
import { Info, ShieldAlert } from 'lucide-react'
import { BusyButton } from '@/components/ui/busy-button'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { DraftBlocker, DraftSummary } from '../lib/draft'
import { CheckLine, FactLine } from './inbound-mail-atoms'

export interface DecisionBarProps {
  summary: DraftSummary
  acknowledgeSender: boolean
  onAcknowledgeSender: (value: boolean) => void
  onFile: () => void
  onDismiss: () => void
  filing: boolean
  dismissing: boolean
  className?: string
}

function blockerText(blocker: DraftBlocker, t: (key: string, vars?: Record<string, string | number>) => string): string | null {
  switch (blocker.kind) {
    case 'sender':
      return null
    case 'project_closed':
    case 'thread_name_missing':
      return t(`bar.blockers.${blocker.kind}`)
    case 'folder_missing':
    case 'name_stop':
    case 'risk':
      return t(`bar.blockers.${blocker.kind}`, { count: blocker.count })
  }
}

/** The primary label for a draft, as the bar shows it; shared with the keyboard's „Wie gezeigt ablegen“. */
export function primaryLabel(summary: DraftSummary, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (summary.files > 0 && summary.text) return t('bar.fileBoth', { count: summary.files })
  if (summary.files > 0) return t('bar.fileFiles', { count: summary.files })
  if (summary.text && summary.thread) return t('bar.fileThread', { name: summary.thread.name, version: summary.thread.nextVersion })
  if (summary.text) return t('bar.fileText')
  return t('bar.fileNothing')
}

export function DecisionBar({
  summary,
  acknowledgeSender,
  onAcknowledgeSender,
  onFile,
  onDismiss,
  filing,
  dismissing,
  className,
}: DecisionBarProps): JSX.Element {
  const t = useTranslations('inboundMail')
  const nothing = summary.files === 0 && !summary.text
  const blockers = summary.blockers.filter((blocker) => blocker.kind !== 'sender')
  const blocked = !nothing && summary.blockers.length > 0
  const busy = filing || dismissing
  const messages = blockers.map((blocker) => blockerText(blocker, t)).filter((text): text is string => text !== null)

  return (
    <div
      data-testid="decision-bar"
      className={cn(
        'bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky bottom-0 z-10 flex flex-col gap-2 border-t px-3 pt-3 backdrop-blur sm:px-4',
        'pb-[max(0.75rem,env(safe-area-inset-bottom))]',
        className
      )}
    >
      {(summary.needsSenderAcknowledgement || messages.length > 0 || (summary.originalErased && !nothing)) && (
        <div className="flex flex-col gap-1.5">
          {summary.needsSenderAcknowledgement && (
            <CheckLine checked={acknowledgeSender} onCheckedChange={onAcknowledgeSender} disabled={busy} testId="acknowledge-sender">
              <span className="text-foreground inline-flex items-center gap-1.5 font-medium">
                <ShieldAlert className="text-warning size-3.5 shrink-0" aria-hidden />
                {t('bar.acknowledgeSender')}
              </span>
            </CheckLine>
          )}
          {messages.map((text) => (
            <p key={text} className="text-muted-foreground text-xs" role="status" data-testid="decision-blocker">
              {text}
            </p>
          ))}
          {summary.originalErased && !nothing && (
            <FactLine icon={Info} testId="original-erased">
              {t('bar.originalErased')}
            </FactLine>
          )}
        </div>
      )}
      {/* DOM order is the phone's stacking order: „Verwerfen“ first, the primary last, nearest the thumb. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <BusyButton
          type="button"
          variant="ghost"
          busy={dismissing}
          busyLabel={t('bar.dismissBusy')}
          onClick={onDismiss}
          blocked={filing}
          className="w-full sm:w-auto"
          data-testid="decision-dismiss"
        >
          {t('bar.dismiss')}
        </BusyButton>
        <BusyButton
          type="button"
          busy={filing}
          busyLabel={t('bar.busy')}
          onClick={nothing ? onDismiss : onFile}
          blocked={dismissing}
          disabled={blocked}
          className="w-full min-w-0 sm:w-auto sm:max-w-[min(32rem,100%)] [&_*]:truncate"
          data-testid="decision-file"
        >
          {primaryLabel(summary, t)}
        </BusyButton>
      </div>
    </div>
  )
}
