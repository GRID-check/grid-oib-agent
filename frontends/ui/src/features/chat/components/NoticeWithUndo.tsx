'use client'

/**
 * A durable change, said out loud in the transcript, with the way back beside
 * it (ADR-0054, and now ADR-0055).
 *
 * Extracted from `MountNotice`, which was the first of these and is now its
 * first caller. Two facts fit this shape and a third would have been written
 * twice: a project came into view, and a note replaced an earlier one. Both are
 * changes to what LATER turns read, both are undoable minutes after the fact,
 * and both must read in one voice — a second lookalike drifts on the first
 * token retune (`frontends/ui/AGENTS.md`).
 *
 * ## Not a toast
 *
 * The design language reserves toasts for transient action failures. These are
 * durable changes whose undo a reader may reach for three turns later, so they
 * belong in the record: the same visual class as `DeepResearchBanner` and
 * `NoSourcesBanner`, with the chat-turn entrance.
 *
 * ## Undo does not delete the notice
 *
 * The thing HAPPENED and the transcript is a history. Undoing replaces the
 * control with the sentence saying it was undone; a transcript that edits its
 * own past is not a record of anything.
 */

import { type FC, type ReactNode } from 'react'
import { type LucideIcon } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

export interface NoticeWithUndoProps {
  /** Glyph for the KIND of change — a project, a note. */
  icon: LucideIcon
  /** The sentence: what happened, or what was undone. Already localized. */
  children: ReactNode
  /** A second, quieter line under it — the detail the sentence does not carry. */
  detail?: ReactNode
  /** Label of the undo control. Absent together with `onUndo`. */
  undoLabel?: string
  /** Absent when there is nothing to undo (or it has already been undone). */
  onUndo?: () => void
  /** The undo itself failed — the control stays, so a retry is one press away. */
  failureText?: string
  /** Undo is in flight: the control is held rather than removed. */
  pending?: boolean
  /** Test hook, so each caller keeps the id its own spec looks for. */
  testId?: string
}

export const NoticeWithUndo: FC<NoticeWithUndoProps> = ({
  icon: Icon,
  children,
  detail,
  undoLabel,
  onUndo,
  failureText,
  pending = false,
  testId,
}) => (
  // `role="status"` (polite): it reports something that already happened and
  // must not interrupt a streaming answer.
  <Alert
    role="status"
    aria-live="polite"
    data-testid={testId}
    className="animate-in fade-in-0 slide-in-from-bottom-1 duration-base ease-entrance motion-reduce:animate-none"
  >
    <Icon aria-hidden="true" />
    <AlertDescription className="flex w-full flex-col gap-1">
      <span className="flex w-full flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-foreground">{children}</span>
        {onUndo && undoLabel && (
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={onUndo}
            disabled={pending}
            className="h-auto p-0 text-xs"
          >
            {undoLabel}
          </Button>
        )}
        {failureText && <span className="text-muted-foreground text-xs">{failureText}</span>}
      </span>
      {detail && <span className="text-muted-foreground text-xs leading-snug">{detail}</span>}
    </AlertDescription>
  </Alert>
)
