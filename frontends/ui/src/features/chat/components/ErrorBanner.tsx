/**
 * ErrorBanner Component
 *
 * Displays persistent error messages in the chat area using shadcn Alert.
 * Uses the error registry for consistent error metadata across the application.
 */

'use client'

import { type FC, useState } from 'react'
import { ChevronDown, ChevronUp, AlertTriangle, XCircle, X, RotateCw } from 'lucide-react'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { formatTime } from '@/shared/utils/format-time'
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
}

/**
 * Error banner for displaying connection, file, auth, and system errors.
 *
 * Motion: the banner arrives in the transcript with the same entrance every
 * other chat turn uses — a 200ms fade-and-rise (`animate-in fade-in-0
 * slide-in-from-bottom-1 duration-200`) on mount only, never on re-render, so a
 * banner that appears mid-conversation reads as the same class of object as the
 * answer beside it. Dropped entirely under `prefers-reduced-motion` via
 * `motion-reduce:animate-none` (design language §Motion vocabulary): the banner
 * is fully legible without it, so no information depends on the animation.
 */
export const ErrorBanner: FC<ErrorBannerProps> = ({
  code,
  message,
  details,
  timestamp,
  onDismiss,
  onRetry,
}) => {
  const t = useTranslations('chat')
  const tc = useTranslations('common')
  const [isExpanded, setIsExpanded] = useState(false)
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
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex w-full flex-col gap-1 duration-200 motion-reduce:animate-none">
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
                  aria-controls="error-details"
                  className="inline-flex cursor-pointer items-center gap-1 rounded-xs border-none bg-transparent p-0 text-xs font-medium no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {isExpanded ? t('error.hideDetails') : t('error.showDetails')}
                  {isExpanded ? (
                    <ChevronUp className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-3 w-3" aria-hidden="true" />
                  )}
                </button>
              </>
            )}
          </span>
          {isExpanded && details && (
            <pre
              id="error-details"
              className="text-error bg-surface-raised mt-2 w-full whitespace-pre-wrap rounded p-2 font-mono text-xs"
            >
              {details}
            </pre>
          )}
          {onRetry && (
            <div className="mt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onRetry}
                aria-label={t('error.retry')}
              >
                <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
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
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </Alert>

      {timestamp && (
        <span className="text-subtle mr-2 self-end text-xs">{formatTime(timestamp)}</span>
      )}
    </div>
  )
}
