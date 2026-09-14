'use client'

/**
 * Einreichen · Freigeben · Änderungen anfordern · Piloti überarbeiten lassen ·
 * Ablehnen · Veröffentlichen · Archivieren — the controls a person gets on the
 * version in front of them.
 *
 * Presentational on purpose: which controls exist is
 * {@link availableLifecycleGestures} (one filter over the transition table), and
 * what happens when one is pressed belongs to the panel that owns the versions.
 * This component decides two things on its own — that a refusal is typed before
 * it is sent, and that a liability act is explicit before it is sent — and it
 * decides both from the table ({@link reviewOpRequiresComment}) plus the shape
 * of the act, not from a list of its own.
 *
 * Approval is a liability act with minimum ceremony: never one click, never
 * silent. Einreichen names its reviewer and states its order in one sentence
 * (both gate the button, with the reason inline); Freigeben names its
 * Geltungsstand, the acting person and the moment, and is signed with a
 * checkbox; Veröffentlichen is its own act in its own section, never a sibling
 * button beside approval.
 *
 * A control that is not offered is a muted WAITING LINE, not nothing: the
 * reader sees what the version is waiting for and — where that is a known
 * fact — who submitted it. Who was ASKED is resolved server-side (the reviewer
 * chain in `lib/documents/reviewers.ts`), so no name is invented for them.
 * Every rule that hides a control is still a fact about the reader or the
 * state that the reader cannot change by clicking.
 */

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime } from '@/lib/format'
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
 * The one gesture in the ROW that gets the ink button. Submit and publish own
 * their sections and carry their own emphasis there; `submit` and `publish`
 * are therefore absent here rather than unstyled.
 */
const PRIMARY_ACTION: Partial<Record<DocumentLifecycleGesture, true>> = {
  approve: true,
}

/** One person the version may be sent to — `GET …/versions/reviewers`. */
export interface ReviewerOption {
  userId: string
  name: string
}

export interface DocumentReviewControlsProps {
  version: Pick<
    DocumentVersionView,
    'id' | 'state' | 'submittedBy' | 'versionNumber' | 'updatedAt'
  > | null
  lifecycle: 'active' | 'archived'
  viewer: DocumentLifecycleViewer
  /** The gesture currently in flight; its control shows as busy. */
  pending?: DocumentLifecycleGesture | null
  /**
   * Run the gesture. `comment` is present exactly for the ops whose transition
   * row requires it — the panel resolves the gesture to an op and passes both
   * straight to the typed client. `reviewerUserIds` is present only for
   * `submit`, and only when the reader singled somebody out. `orderMessage`
   * and `dueAt` ride the same `submit` call into the round's inbox payload.
   */
  onAct: (
    gesture: DocumentLifecycleGesture,
    options?: {
      comment?: string
      reviewerUserIds?: readonly string[]
      orderMessage?: string
      dueAt?: string
    },
  ) => void
  /**
   * Who may be asked. Loaded by the panel that owns the document, because this
   * component is presentational and because the list is worth exactly one
   * request per document rather than one per render.
   */
  reviewers?: readonly ReviewerOption[]
  /** Display name of the acting person (the viewer), when the surface knows it. */
  actingName?: string | null
  /** Names the surface already knows, by user id — for the waiting line. */
  names?: Readonly<Record<string, string>>
  className?: string
}

export function DocumentReviewControls({
  version,
  lifecycle,
  viewer,
  pending = null,
  onAct,
  reviewers = [],
  actingName = null,
  names,
  className,
}: DocumentReviewControlsProps): JSX.Element {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const [typing, setTyping] = useState<DocumentLifecycleGesture | null>(null)
  const [comment, setComment] = useState('')
  // Unselected until the reader says who: an open round nobody was told about
  // used to be one forgotten picker away, and the button below stays shut
  // until this holds a name (or there is nobody to choose between).
  const [reviewer, setReviewer] = useState<string>('')
  // The order, in one sentence, plus an optional due date. Both gate the
  // button AND ride the submit wire (`submitRequestSchema`) into the round's
  // inbox payload (excerpt + Frist) — a ceremony that transmitted nothing
  // used to be theater.
  const [order, setOrder] = useState('')
  const [due, setDue] = useState('')
  // Freigeben, opened: the checkbox inside is the signature.
  const [approving, setApproving] = useState(false)
  const [approvedChecked, setApprovedChecked] = useState(false)

  // A version that moved on is a different question; everything picked or
  // typed for the last one must not ride along into the next round.
  useEffect(() => {
    setReviewer('')
    setOrder('')
    setDue('')
    setTyping(null)
    setComment('')
    setApproving(false)
    setApprovedChecked(false)
  }, [version?.id])

  const gestures = availableLifecycleGestures(version, lifecycle, viewer)

  const nameOf = (userId: string | null): string => {
    if (!userId) return t('lifecycle.versions.someone')
    if (userId === viewer.userId) return t('lifecycle.versions.you')
    return names?.[userId] ?? t('lifecycle.versions.someone')
  }

  if (gestures.length === 0) {
    return (
      <div className={cn('space-y-2', className)} data-testid="document-review-controls">
        <p className="text-muted-foreground text-xs" data-testid="document-review-waiting">
          {waitingText()}
        </p>
      </div>
    )
  }

  function waitingText(): string {
    if (lifecycle === 'archived') return t('lifecycle.waiting.archived')
    if (!version) return t('lifecycle.waiting.none')
    switch (version.state) {
      case 'draft':
        return t('lifecycle.waiting.draft')
      case 'in_review':
        return version.submittedBy
          ? t('lifecycle.waiting.inReviewBy', { name: nameOf(version.submittedBy) })
          : t('lifecycle.waiting.inReview')
      case 'changes_requested':
        return t('lifecycle.waiting.changesRequested')
      case 'approved':
        return t('lifecycle.waiting.approved')
      case 'published':
        return t('lifecycle.waiting.published')
      case 'rejected':
        return t('lifecycle.waiting.rejected')
      case 'superseded':
        return t('lifecycle.waiting.superseded')
    }
  }

  const start = (gesture: DocumentLifecycleGesture) => {
    if (gesture === 'approve') {
      // The liability act: no comment to type, a stand to sign instead.
      setTyping(null)
      setComment('')
      setApprovedChecked(false)
      setApproving(true)
      return
    }
    setApproving(false)
    setApprovedChecked(false)
    // Read off the OP the gesture runs, so „Piloti überarbeiten lassen" inherits
    // the comment requirement from the row it shares rather than restating it.
    const { action } = lifecycleRequestFor(gesture)
    if (action !== 'archive' && reviewOpRequiresComment(action)) {
      setComment('')
      setTyping(gesture)
      return
    }
    onAct(gesture)
  }

  const send = () => {
    if (!typing || comment.trim() === '') return
    onAct(typing, { comment: comment.trim() })
    setTyping(null)
    setComment('')
  }

  const confirmApprove = () => {
    if (!approvedChecked) return
    onAct('approve')
    setApproving(false)
    setApprovedChecked(false)
  }

  const offersSubmit = gestures.includes('submit')
  const offersPublish = gestures.includes('publish')
  // The row holds the decisions and the item-level act; submit and publish own
  // their sections below and never stand here as equal siblings.
  const rowGestures = gestures.filter((gesture) => gesture !== 'submit' && gesture !== 'publish')

  // A reviewer is required wherever there is somebody to choose between. With
  // nobody (a sole editor), the round falls back to the submitter as a
  // recorded self-review — the wire's own waiver — and only the order gates.
  const needsReviewerChoice = offersSubmit && reviewers.length > 0
  const reviewerSet = !needsReviewerChoice || reviewer !== ''
  const orderSet = order.trim() !== ''
  const submitReady = reviewerSet && orderSet

  const submitNow = () => {
    if (!submitReady || pending !== null) return
    const orderMessage = order.trim()
    const dueAt = due.trim() !== '' ? due.trim() : undefined
    if (reviewer === '') {
      onAct('submit', dueAt === undefined ? { orderMessage } : { orderMessage, dueAt })
      return
    }
    onAct(
      'submit',
      dueAt === undefined
        ? { reviewerUserIds: [reviewer], orderMessage }
        : { reviewerUserIds: [reviewer], orderMessage, dueAt },
    )
  }

  const today = formatAbsoluteTime(new Date().toISOString(), locale)

  return (
    <div className={cn('space-y-2', className)} data-testid="document-review-controls">
      {offersSubmit && (
        /* The order, stated before it is sent: who shall review, and in one
           sentence what. The button stays shut with its reasons inline — a
           disabled button whose unlock the reader can see, never a refusal
           after the click and never an open round nobody was told about. */
        <div className="space-y-2 rounded-lg border p-2.5" data-testid="document-review-submit">
          {needsReviewerChoice ? (
            <div className="space-y-1">
              <label
                htmlFor="document-review-reviewer-input"
                className="text-muted-foreground block text-xs"
              >
                {t('lifecycle.submit.reviewerLabel')}
              </label>
              <Select value={reviewer} onValueChange={setReviewer}>
                <SelectTrigger
                  id="document-review-reviewer-input"
                  className="h-8 w-full"
                  data-testid="document-review-reviewer"
                >
                  <SelectValue placeholder={t('lifecycle.submit.reviewerPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {reviewers.map((person) => (
                    <SelectItem key={person.userId} value={person.userId}>
                      {person.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p
              className="text-muted-foreground text-xs"
              data-testid="document-review-submit-note"
            >
              {t('lifecycle.submit.selfReviewNote')}
            </p>
          )}
          <div className="space-y-1">
            <label
              htmlFor="document-review-order-input"
              className="text-muted-foreground block text-xs"
            >
              {t('lifecycle.submit.orderLabel')}
            </label>
            <Input
              id="document-review-order-input"
              value={order}
              onChange={(event) => setOrder(event.target.value)}
              placeholder={t('lifecycle.submit.orderPlaceholder')}
              className="h-8"
              data-testid="document-review-order"
            />
          </div>
          <div className="space-y-1">
            <label
              htmlFor="document-review-due-input"
              className="text-muted-foreground block text-xs"
            >
              {t('lifecycle.submit.dueLabel')}
            </label>
            <Input
              id="document-review-due-input"
              type="date"
              value={due}
              onChange={(event) => setDue(event.target.value)}
              className="h-8"
              data-testid="document-review-due"
            />
          </div>
          {!submitReady && (
            <ul
              className="text-muted-foreground space-y-0.5 text-xs"
              data-testid="document-review-submit-hint"
            >
              {!reviewerSet && <li>{t('lifecycle.submit.needReviewer')}</li>}
              {!orderSet && <li>{t('lifecycle.submit.needOrder')}</li>}
            </ul>
          )}
          <div className="flex items-center justify-end">
            <Button
              type="button"
              size="sm"
              className="h-8"
              disabled={!submitReady || pending !== null}
              aria-busy={pending === 'submit'}
              data-testid="document-lifecycle-submit"
              onClick={submitNow}
            >
              {t(ACTION_LABEL.submit)}
            </Button>
          </div>
        </div>
      )}

      {rowGestures.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {rowGestures.map((gesture) => (
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
      )}

      {approving && version && (
        /* The signature: which stand, who signs, when — and the checkbox that
           makes „Freigeben" an act rather than a click. Beside the version,
           like the refusal box, so the stand stays in sight while it is
           released. */
        <div
          className="space-y-2 rounded-lg border p-2.5"
          data-testid="document-review-approve-confirm"
        >
          <p className="text-xs font-medium" data-testid="document-review-approve-stand">
            {t('lifecycle.approveConfirm.stand', {
              number: version.versionNumber,
              date: formatAbsoluteTime(version.updatedAt, locale),
            })}
          </p>
          <p className="text-muted-foreground text-xs" data-testid="document-review-approve-acting">
            {actingName
              ? t('lifecycle.approveConfirm.actingWithName', { name: actingName, date: today })
              : t('lifecycle.approveConfirm.actingDateOnly', { date: today })}
          </p>
          <div className="flex items-start gap-2">
            <Checkbox
              id="document-review-approve-checkbox"
              checked={approvedChecked}
              onCheckedChange={(checked) => setApprovedChecked(checked === true)}
              data-testid="document-review-approve-checkbox"
            />
            <label
              htmlFor="document-review-approve-checkbox"
              className="text-sm leading-snug"
            >
              {t('lifecycle.approveConfirm.checkbox')}
            </label>
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() => {
                setApproving(false)
                setApprovedChecked(false)
              }}
            >
              {t('lifecycle.comment.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8"
              // Unsigned is refused here: the reader can fix this one by
              // checking the box.
              disabled={!approvedChecked || pending !== null}
              data-testid="document-review-approve-send"
              onClick={confirmApprove}
            >
              {t(ACTION_LABEL.approve)}
            </Button>
          </div>
        </div>
      )}

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

      {offersPublish && version && (
        /* The second act, in its own section: asserting the content (above) and
           issuing it to the submission set / the authority (here) are two acts
           by possibly two people — so this never stands beside approval as an
           equal sibling. */
        <div className="space-y-1.5 border-t pt-3" data-testid="document-review-publish">
          <p className="text-xs font-medium">{t('lifecycle.publishSection.heading')}</p>
          <p className="text-muted-foreground text-xs">
            {t('lifecycle.publishSection.blurb', { number: version.versionNumber })}
          </p>
          <div>
            <Button
              type="button"
              size="sm"
              className="h-8"
              disabled={pending !== null}
              aria-busy={pending === 'publish'}
              data-testid="document-lifecycle-publish"
              onClick={() => start('publish')}
            >
              {t(ACTION_LABEL.publish)}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
