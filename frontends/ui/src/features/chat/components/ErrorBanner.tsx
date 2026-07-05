/**
 * ErrorBanner Component
 *
 * Displays persistent error messages in the chat area using shadcn Alert.
 * Uses the error registry for consistent error metadata across the application.
 */

'use client'

import { type FC, useState } from 'react'
import { ChevronDown, ChevronUp, AlertTriangle, XCircle, X } from 'lucide-react'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
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
}

/**
 * Error banner for displaying connection, file, auth, and system errors
 */
export const ErrorBanner: FC<ErrorBannerProps> = ({
  code,
  message,
  details,
  timestamp,
  onDismiss,
}) => {
  const [isExpanded, setIsExpanded] = useState(false)
  const errorMeta = getErrorMeta(code)

  // Use custom message if provided, otherwise use default from registry
  const displayMessage = message || errorMeta.defaultMessage
  const variant = errorMeta.status === 'error' ? 'destructive' : errorMeta.status
  const StatusIcon = errorMeta.status === 'error' ? XCircle : AlertTriangle

  return (
    <div className="flex w-full flex-col gap-1">
      <Alert variant={variant} className="relative">
        <StatusIcon />
        <AlertTitle>{errorMeta.title}</AlertTitle>
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
                  {isExpanded ? 'Hide details' : 'Show details'}
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
        </AlertDescription>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close"
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
