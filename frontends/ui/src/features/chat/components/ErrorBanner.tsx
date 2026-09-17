/**
 * ErrorBanner Component
 *
 * Displays persistent error messages in the chat area using shadcn Alert.
 * Uses the error registry for consistent error metadata across the application.
 */

'use client'

import { type FC, useId, useState } from 'react'
import { ChevronDown, ChevronUp, AlertTriangle, XCircle, X, RotateCw, Check, Copy } from 'lucide-react'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useLocale, useTranslations } from '@/i18n'
import { formatTime } from '@/shared/utils/format-time'
import { shortRequestId } from '@/shared/utils/request-id'
import type { ErrorCode } from '../types'
import { getErrorMeta } from '../lib/error-registry'

export type { ErrorCode }

export interface ErrorBannerProps {
  /** Error code from the error registry */
  code: ErrorCode
  /** Optional custom message (overrides default from registry) */
  message?: string
  /** Optional expandable details */
  details?: string
  /** Timestamp of the error */
  timestamp?: Date | string
  /** Optional callback when banner is dismissed */
  onDismiss?: () => void
  /**
   * Optional retry action. When provided, the banner renders a "Erneut
   * versuchen" button (the design language mandates "helpful message + retry").
   * Left optional so callers/specs that don't wire a retry are unaffected.
   */
  onRetry?: () => void
  /**
   * The failed response's correlation id, when it carried one.
   *
   * The BFF puts it on every error as `requestId` in the body and `x-request-id`
   * on the response (`lib/api/request-id`), and prints it on its own log line
   * for a 500. Shown here because the reader is the only person who knows WHICH
   * request failed, and without something quotable a report is "es hat gestern
   * nicht funktioniert" — which no operator can look up. Optional: an error
   * raised in the client (a dropped socket, a parse failure) has no id, and the
   * banner says nothing rather than inventing one.
   */
  requestId?: string | null
}

/**
 * Error banner for displaying connection, file, auth, and system errors.
 *
 * Motion: the banner arrives in the transcript with the same entrance every
 * other chat turn uses — a 200ms fade-and-rise (`animate-in fade-in-0
 * slide-in-from-bottom-1 duration-quick ease-out`) on mount only, never on
 * re-render, so a banner that appears mid-conversation reads as the same class
 * of object as the answer beside it. Dropped entirely under
 * `prefers-reduced-motion` via `motion-reduce:animate-none` (design language
 * §Motion vocabulary): the banner is fully legible without it, so no
 * information depends on the animation.
 */
export const ErrorBanner: FC<ErrorBannerProps> = ({
  code,
  message,
  details,
  timestamp,
  onDismiss,
  onRetry,
  requestId,
}) => {
  const t = useTranslations('chat')
  const tc = useTranslations('common')
  // Same reason AgentResponse threads it: without the locale `formatTime` uses
  // the RUNTIME default, so a German user on an en-US browser read "03:35 PM"
  // under this card while every answer beside it said "15:35".
  const { locale } = useLocale()
  const [isExpanded, setIsExpanded] = useState(false)
  // Unique per banner: two error cards in one thread with a shared literal id
  // would point both disclosures at the first card's <pre>.
  const detailsId = useId()
  const errorMeta = getErrorMeta(code)

  // Prefer the caller-supplied (already-localized / interpolated) message.
  // Otherwise localize the registry default via `messageKey`, falling back to
  // the static English `defaultMessage` when the entry opts out or no provider
  // is present.
  const displayMessage =
    message || (errorMeta.messageKey ? t(errorMeta.messageKey) : errorMeta.defaultMessage)
  // Localize the title when the registry entry opts in via `titleKey`;
  // otherwise fall back to the static (English) registry title.
  const displayTitle = errorMeta.titleKey ? t(errorMeta.titleKey) : errorMeta.title
  const variant = errorMeta.status === 'error' ? 'destructive' : errorMeta.status
  const StatusIcon = errorMeta.status === 'error' ? XCircle : AlertTriangle

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex w-full flex-col gap-1 duration-base ease-entrance motion-reduce:animate-none">
      <Alert variant={variant} className="relative">
        <StatusIcon />
        <AlertTitle>{displayTitle}</AlertTitle>
        <AlertDescription>
          <span>
            {displayMessage}
            {details && (
              <>
                {' '}
                <button
                  type="button"
                  onClick={() => setIsExpanded(!isExpanded)}
                  aria-expanded={isExpanded}
                  aria-controls={detailsId}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-xs border-none bg-transparent p-0 text-xs font-medium no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {isExpanded ? t('error.hideDetails') : t('error.showDetails')}
                  {isExpanded ? (
                    <ChevronUp className="size-3" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="size-3" aria-hidden="true" />
                  )}
                </button>
              </>
            )}
          </span>
          {isExpanded && details && (
            <pre
              id={detailsId}
              className="text-error bg-surface-raised mt-2 max-h-48 w-full overflow-auto whitespace-pre-wrap rounded p-2 font-mono text-xs"
            >
              {details}
            </pre>
          )}
          {requestId && <RequestReference requestId={requestId} />}
          {onRetry && (
            <div className="mt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onRetry}
                aria-label={t('error.retry')}
              >
                <RotateCw className="size-3.5" aria-hidden="true" />
                {t('error.retry')}
              </Button>
            </div>
          )}
        </AlertDescription>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={tc('actions.close')}
            className="text-muted-foreground hover:text-foreground absolute right-3 top-3 rounded-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        )}
      </Alert>

      {timestamp && (
        <span className="text-subtle mr-2 self-end text-xs">{formatTime(timestamp, locale)}</span>
      )}
    </div>
  )
}

/**
 * „Referenz für den Support": the eight characters a person reads out.
 *
 * Short on screen and long on the clipboard, on purpose. The short form is a
 * literal prefix of the full id, so either one greps to the same log line, but
 * what gets pasted into a ticket should be the whole thing — a truncated id in
 * a bug report is a second round trip.
 *
 * A copy affordance rather than plain text because this is an identifier, and
 * the failure mode of an identifier a person has to retype is a typo nobody
 * notices until the search comes back empty.
 */
const RequestReference: FC<{ requestId: string }> = ({ requestId }) => {
  const t = useTranslations('chat')
  const [copied, setCopied] = useState(false)

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(requestId)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // The id is on screen either way — it is selectable text — so a refused
      // clipboard costs the reader nothing but the shortcut.
      setCopied(false)
    }
  }

  return (
    <div className="mt-2 flex items-center gap-1.5" data-testid="error-request-id">
      <span className="text-subtle text-xs">{t('error.reference')}</span>
      <button
        type="button"
        onClick={() => void handleCopy()}
        aria-label={t('error.referenceCopyAria', { id: requestId })}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-xs font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        {shortRequestId(requestId)}
        {copied ? (
          <Check className="size-3" aria-hidden="true" />
        ) : (
          <Copy className="size-3" aria-hidden="true" />
        )}
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? t('error.referenceCopied') : ''}
      </span>
    </div>
  )
}
