'use client'

/**
 * A document's ingest failure in the reader's language, with the stored text
 * behind a „Details" disclosure. The file card, preview pane, upload tray and
 * the chat's file chips all say it through this, so one failure reads the same
 * everywhere. The category comes from `lib/ingest-failure.ts`.
 */

import { useState, type FC } from 'react'
import { ChevronDown } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { classifyIngestFailure, ingestFailureSentence } from '../lib/ingest-failure'

/**
 * The sentence for a stored ingest failure, plus the raw text when it says
 * something the sentence does not. `null` when there is no failure message.
 */
export function useIngestFailureText(
  errorMessage: string | null | undefined
): { sentence: string; raw: string } | null {
  const t = useTranslations('files')
  const failure = classifyIngestFailure(errorMessage)
  if (!failure) return null
  return { sentence: ingestFailureSentence(failure, t), raw: failure.raw }
}

export interface IngestFailureNoticeProps {
  errorMessage: string | null | undefined
  /** Classes for the sentence, so each surface keeps its own type ramp. */
  sentenceClassName?: string
  className?: string
  testId?: string
}

export const IngestFailureNotice: FC<IngestFailureNoticeProps> = ({
  errorMessage,
  sentenceClassName,
  className,
  testId = 'ingest-failure',
}) => {
  const t = useTranslations('files')
  const [open, setOpen] = useState(false)
  const text = useIngestFailureText(errorMessage)

  const sentence = text?.sentence ?? t('ingestFailure.unknown')
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={className} data-testid={testId}>
      <p className={cn('break-words text-xs', sentenceClassName)}>{sentence}</p>
      {text && (
        <>
          <CollapsibleTrigger
            className={cn(
              'text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 mt-0.5 flex items-center gap-1',
              'rounded-md text-xs transition-colors duration-quick ease-out',
              'focus-visible:outline-none focus-visible:ring-2'
            )}
            data-testid={`${testId}-details-trigger`}
          >
            <span>{t('ingestFailure.details')}</span>
            <ChevronDown
              className={cn(
                'size-3 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none',
                open && 'rotate-180'
              )}
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1">
            <p
              className="text-muted-foreground break-words font-mono text-[11px] leading-snug"
              data-testid={`${testId}-raw`}
            >
              {text.raw}
            </p>
          </CollapsibleContent>
        </>
      )}
    </Collapsible>
  )
}
