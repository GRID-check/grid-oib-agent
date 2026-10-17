'use client'

/**
 * Why an upload row is held (ADR-0086), for every surface that lists this
 * session's uploads: the tray, the drop zone, the chat's file list.
 *
 * Two kinds of row are held. A file the content check held back carries its
 * typed verdict (`quarantineVerdictOf`, ADR-0113), which reads as its findings. A file refused
 * because the document it would replace is held (`TrackedFile.replacesHeld`)
 * has no verdict of its own: its sentence says what it waits for. Handing that
 * row to the findings would claim the reason „is not stored", which is not what
 * happened.
 */

import type { JSX } from 'react'
import type { QuarantineVerdict } from '@/lib/upload-screening/quarantine'
import { cn } from '@/lib/utils'
import type { TrackedFile } from '../types'
import { QuarantineFindings } from './quarantine-findings'

export interface HeldUploadReasonProps {
  /** The content check's verdict on this row's own file; null when it has none. */
  verdict: QuarantineVerdict | null
  replacesHeld?: TrackedFile['replacesHeld']
  /** The row's sentence for a `replacesHeld` row (`files.errors.quarantinedReplace`); unused otherwise. */
  message?: string | null
  /** Leave out the findings' sentence that explains holding back, where the surface says it already. */
  withoutSentence?: boolean
  className?: string
  testId: string
}

export function HeldUploadReason({
  verdict,
  replacesHeld,
  message,
  withoutSentence,
  className,
  testId,
}: HeldUploadReasonProps): JSX.Element {
  if (replacesHeld) {
    return (
      <p className={cn('text-muted-foreground text-xs leading-snug', className)} data-testid={`${testId}-replaces`}>
        {message}
      </p>
    )
  }
  return (
    <QuarantineFindings
      verdict={verdict}
      withoutSentence={withoutSentence}
      className={className}
      testId={testId}
    />
  )
}
