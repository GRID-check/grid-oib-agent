'use client'

/**
 * Einreichen · Freigeben · Änderungen anfordern · Piloti überarbeiten lassen ·
 * Ablehnen · Veröffentlichen · Archivieren — the controls a person gets on the
 * version in front of them.
 *
 * Presentational on purpose: which controls exist is
 * {@link availableLifecycleGestures} (one filter over the transition table), and
 * what happens when one is pressed belongs to the panel that owns the versions.
 * This component decides one thing on its own — that a refusal is typed before
 * it is sent — and it decides it from the table too
 * ({@link reviewOpRequiresComment}), not from a list of its own.
 *
 * A control that is not offered is ABSENT, not disabled. Every rule that hides
 * one here is a fact about the reader or the state that the reader cannot change
 * by clicking: they do not hold the permission, or they are the person who
 * submitted it. A disabled button is a promise that something could unlock it.
 */

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { DocumentVersionView } from '@/lib/documents/lifecycle-types'
import {
  DELEGATE_REVISION,
  availableLifecycleGestures,
  lifecycleRequestFor,
  reviewOpRequiresComment,
  type DocumentLifecycleGesture,
  type DocumentLifecycleViewer,
} from '../lib/document-lifecycle'

/** The i18n leaf per gesture — exhaustive, so a new op has to be worded. */
const ACTION_LABEL: Record<DocumentLifecycleGesture, string> = {
  submit: 'lifecycle.actions.submit',
  approve: 'lifecycle.actions.approve',
  request_changes: 'lifecycle.actions.requestChanges',
  [DELEGATE_REVISION]: 'lifecycle.actions.delegateRevision',
  reject: 'lifecycle.actions.reject',
  publish: 'lifecycle.actions.publish',
  archive: 'lifecycle.actions.archive',
}

/**
 * The one gesture that reads as the obvious next step gets the ink button; the
 * rest are outlines. Only ever ONE per state — „Freigeben" and „Ablehnen" are
 * not two equal offers, and two filled buttons side by side would say they are.
 */
const PRIMARY_ACTION: Partial<Record<DocumentLifecycleGesture, true>> = {
  submit: true,
  approve: true,
  publish: true,
}

/** One person the version may be sent to — `GET …/versions/reviewers`. */
export interface ReviewerOption {
  userId: string
  name: string
}

/** „alle Bearbeiter": the value the picker holds when nobody is singled out. */
const EVERY_EDITOR = '__every_editor__'

export interface DocumentReviewControlsProps {
  version: Pick<DocumentVersionView, 'id' | 'state' | 'submittedBy'> | null
  lifecycle: 'active' | 'archived'
  viewer: DocumentLifecycleViewer
  /** The gesture currently in flight; its control shows as busy. */
  pending?: DocumentLifecycleGesture | null
  /**
   * Run the gesture. `comment` is present exactly for the ops whose transition
   * row requires it — the panel resolves the gesture to an op and passes both
   * straight to the typed client. `reviewerUserIds` is present only for
   * `submit`, and only when the reader singled somebody out.
   */
  onAct: (
    gesture: DocumentLifecycleGesture,
    options?: { comment?: string; reviewerUserIds?: readonly string[] },
  ) => void
  /**
   * Who may be asked. Loaded by the panel that owns the document, because this
   * component is presentational and because the list is worth exactly one
   * request per document rather than one per render.
   */
  reviewers?: readonly ReviewerOption[]
  className?: string
}

export function DocumentReviewControls({
  version,
  lifecycle,
  viewer,
  pending = null,
  onAct,
  reviewers = [],
  className,
}: DocumentReviewControlsProps): JSX.Element | null {
  const t = useTranslations('files')
  const [typing, setTyping] = useState<DocumentLifecycleGesture | null>(null)
  const [comment, setComment] = useState('')
  const [reviewer, setReviewer] = useState<string>(EVERY_EDITOR)

  // A version that moved on is a different question; a name picked for the last
  // one must not ride along into the next round.
  useEffect(() => setReviewer(EVERY_EDITOR), [version?.id])

  const gestures = availableLifecycleGestures(version, lifecycle, viewer)
  if (gestures.length === 0) return null

  const start = (gesture: DocumentLifecycleGesture) => {
    // Read off the OP the gesture runs, so „Piloti überarbeiten lassen" inherits
    // the comment requirement from the row it shares rather than restating it.
    const { action } = lifecycleRequestFor(gesture)
    if (action !== 'archive' && reviewOpRequiresComment(action)) {
      setComment('')
      setTyping(gesture)
      return
    }
    onAct(gesture, gesture === 'submit' ? { reviewerUserIds: namedReviewer() } : undefined)
  }

  // `undefined` and not `[]`: „niemanden benannt" is what makes the fallback
  // chain run (assignees, then every editor), and an empty array means the
  // same thing one layer down — but only one of the two says so at the call
  // site.
  const namedReviewer = (): readonly string[] | undefined =>
    reviewer === EVERY_EDITOR ? undefined : [reviewer]

  const send = () => {
    if (!typing || comment.trim() === '') return
    onAct(typing, { comment: comment.trim() })
    setTyping(null)
    setComment('')
  }

  const offersSubmit = gestures.includes('submit')

  return (
    <div className={cn('space-y-2', className)} data-testid="document-review-controls">
      {/* Optional, and its default is the honest one: an unassigned draft goes
          to everybody who may release it, because the round is open and
          whoever gets there first answers it. Singling somebody out is the
          exception („leg das der Anna vor"), so it is a picker beside the
          button and not a step in front of it. Absent when there is nobody to
          choose between — a one-person project picks itself. */}
      {offersSubmit && reviewers.length > 0 && (
        <Select value={reviewer} onValueChange={setReviewer}>
          <SelectTrigger className="h-8 w-full" data-testid="document-review-reviewer">
            <SelectValue placeholder={t('lifecycle.reviewer.every')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={EVERY_EDITOR}>{t('lifecycle.reviewer.every')}</SelectItem>
            {reviewers.map((person) => (
              <SelectItem key={person.userId} value={person.userId}>
                {person.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {gestures.map((gesture) => (
          <Button
            key={gesture}
            type="button"
            size="sm"
            variant={PRIMARY_ACTION[gesture] ? 'default' : 'outline'}
            className="h-8"
            disabled={pending !== null}
            aria-busy={pending === gesture}
            data-testid={`document-lifecycle-${gesture}`}
            onClick={() => start(gesture)}
          >
            {t(ACTION_LABEL[gesture])}
          </Button>
        ))}
      </div>

      {typing && (
        /* The reason, typed where the decision is taken. A dialog would put the
           version out of sight at the moment the reviewer is describing what is
           wrong with it. */
        <div className="space-y-2 rounded-lg border p-2.5" data-testid="document-review-comment">
          <label
            htmlFor="document-review-comment-input"
            className="text-muted-foreground block text-xs"
          >
            {t(
              typing === 'reject'
                ? 'lifecycle.comment.reasonLabel'
                : 'lifecycle.comment.changesLabel',
            )}
          </label>
          {/* What pressing this one does BEYOND sending the version back, said
              where the reviewer is deciding rather than in a tooltip: the label
              names the gesture, and this names its consequence. */}
          {typing === DELEGATE_REVISION && (
            <p className="text-muted-foreground text-xs" data-testid="document-review-delegate-note">
              {t('lifecycle.comment.delegateNote')}
            </p>
          )}
          <Textarea
            id="document-review-comment-input"
            value={comment}
            autoFocus
            rows={3}
            onChange={(event) => setComment(event.target.value)}
            placeholder={t('lifecycle.comment.placeholder')}
          />
          <div className="flex items-center justify-end gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() => {
                setTyping(null)
                setComment('')
              }}
            >
              {t('lifecycle.comment.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8"
              // Empty is refused here AND by the schema AND by a CHECK on the
              // row. The button is disabled rather than the send rejected,
              // because the reader can fix this one by typing.
              disabled={comment.trim() === '' || pending !== null}
              data-testid="document-review-comment-send"
              onClick={send}
            >
              {t(ACTION_LABEL[typing])}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
