'use client'

/**
 * One inbox row — the generic, registry-driven renderer (spec IB-6).
 *
 * **There is deliberately no `switch (item.type)` in this file for LOOKS.**
 * Every visual decision comes from `INBOX_TYPE_PRESENTATION[item.type]`: which
 * icon to draw, which pair of translation keys to read, and whether the row
 * reads as a request or as an FYI. That is the whole extensibility promise — a
 * new notification type is a registry entry plus two strings, never a new
 * component.
 *
 * The ONE exception below is BEHAVIOUR, not looks: a version waiting for a
 * decision carries its three decisions inline, so triage happens here instead
 * of forcing a round-trip through Files. It keys on the actionable document
 * type alone, renders through the same atoms, and resolves server-side — the
 * decision settles the round for every reviewer (`resolveReviewInbox`) and the
 * list re-reads on the `inbox.changed` nudge. Nothing persists on a chat
 * message, so `useCardDecision` does not apply here.
 *
 * The row answers **who / what / where / when without being opened** (IB-20):
 * the title carries the actor, the body the subject, the excerpt the actual
 * question, and the timestamp the when (relative, with the exact moment on hover).
 *
 * Two behaviours here are security-visible rather than cosmetic:
 *   - An **inert** item (its target was unshared, deleted or purged — IB-13/IB-14)
 *     renders as plain text, never as an anchor. `href` is null for those rows and
 *     an anchor with an empty or `#` href would be a working-looking link to
 *     content the user may no longer reach.
 *   - The **archive** control is a sibling of the row link, not a child of it.
 *     Nesting a button inside an anchor is an accessibility defect and makes the
 *     link's accessible name include the button's.
 */

import { forwardRef, useState } from 'react'
import Link from 'next/link'
import {
  Archive,
  AtSign,
  CheckCircle2,
  EyeOff,
  HardDrive,
  MessageSquare,
  UserPlus,
  type LucideIcon,
  AlertTriangle,
} from 'lucide-react'

import { useI18n, useLocale, useTranslations } from '@/i18n'
import { getByPath } from '@/i18n/translate'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import {
  INBOX_TYPE_PRESENTATION,
  UNKNOWN_TYPE_PRESENTATION,
  type InboxItemView,
} from '@/lib/inbox/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { motion, motionQuick } from '@/components/motion'
import { cn } from '@/lib/utils'
import type {
  DocumentLifecycleClient,
} from '@/lib/documents/lifecycle-client'
import { documentLifecycleClient } from '@/lib/documents/lifecycle-client'
import { DiscussDocumentButton } from '@/features/documents/components/discuss-document-button'
import { projectIdFromDocumentHref } from '@/features/documents/lib/document-question'

/**
 * The ONE place the registry's icon names become components. Keeping the map here
 * (rather than storing components in `lib/inbox/types.ts`) keeps the registry a
 * plain data module that the server half can import without pulling in React.
 */
const ICONS: Record<(typeof INBOX_TYPE_PRESENTATION)[keyof typeof INBOX_TYPE_PRESENTATION]['icon'], LucideIcon> =
  {
    'at-sign': AtSign,
    'message-square': MessageSquare,
    'user-plus': UserPlus,
    'check-circle': CheckCircle2,
    'hard-drive': HardDrive,
    'alert-triangle': AlertTriangle,
  }

/** Dictionary root for the item-type entries. */
const TYPES_PATH = 'collaboration.inbox.types'

/**
 * Pick the counted title key by hand, because this i18n layer interpolates but
 * has no plural rules (see the dictionary header): counted types ship
 * `titleOne`/`titleMany`, uncounted ones a single `title`. Reading the dictionary
 * directly — rather than calling `t()` and sniffing the returned key — keeps a
 * type that legitimately has no `titleOne` from logging a missing-key warning on
 * every render.
 */
function pickKey(dictionary: unknown, i18nKey: string, candidates: readonly string[]): string | null {
  for (const leaf of candidates) {
    if (typeof getByPath(dictionary, `${TYPES_PATH}.${i18nKey}.${leaf}`) === 'string') return leaf
  }
  return null
}

export interface InboxItemRowProps {
  item: InboxItemView
  /** Called when the row's link is followed, so the list can mark it read. */
  onOpen?: (item: InboxItemView) => void
  /** Called by the archive button. Omit to hide the control. */
  onArchive?: (itemId: string) => void
  /**
   * Runs an inline review decision. Injected by the specs; the browser gets
   * the real typed client. Narrowed to the three decisions a reviewer may
   * take — nothing else on this row writes lifecycle state.
   */
  reviewClient?: Pick<DocumentLifecycleClient, 'approve' | 'requestChanges' | 'reject'>
}

export const InboxItemRow = forwardRef<HTMLLIElement, InboxItemRowProps>(function InboxItemRow(
  { item, onOpen, onArchive, reviewClient = documentLifecycleClient },
  ref,
): JSX.Element {
  const t = useTranslations('collaboration')
  const { dictionary } = useI18n()
  const { locale } = useLocale()

  /*
    `INBOX_TYPE_PRESENTATION` is exhaustive over `InboxItemType` at COMPILE time,
    and rows come from a `text` column. A row written by a newer deploy — or read
    across a rollback — therefore has a type this map does not know, and indexing
    it produced `undefined.icon`: a TypeError that took down the whole /app/inbox
    route, not just its own row. One unknown row must cost one unremarkable row.
  */
  const presentation = INBOX_TYPE_PRESENTATION[item.type] ?? UNKNOWN_TYPE_PRESENTATION
  const Icon = ICONS[presentation.icon]

  /*
    „Besprechen", for a row whose target is a DOCUMENT.

    Still no `switch (item.type)`: the condition is the row's own
    `resourceType`, which every row carries, exactly like `href` and `state`. A
    reviewer reading „Anna bittet um Freigabe von Brandschutzkonzept" has two
    next moves — open the file, or ask about it — and only the first had a
    control. The second used to be impossible anyway: a submitted draft has no
    chunks, so Piloti could not answer about it; the turn now reads the subject
    version's bytes instead.

    The project comes back out of the link the row already holds. The inbox
    payload is deliberately type-agnostic and carries no project field, and
    widening it for one button would put a document's concern into the generic
    shape. An Archiv document has no project chat and correctly yields `null`.
  */
  const documentProjectId =
    item.resourceType === 'document' ? projectIdFromDocumentHref(item.href) : null

  const inert = item.state === 'inert'
  const unread = item.state === 'unread'
  const resolved = item.state === 'resolved'
  // A request only reads as a request while it is still outstanding; once it is
  // answered it is history, and colouring it would keep shouting for attention.
  const isRequest = presentation.tone === 'request' && item.actionable && !resolved && !inert
  // An operational warning gets the same tint for the same reason — something
  // needs attention — but it is not a REQUEST: nobody is waiting on the reader,
  // so it is not actionable and it does not resolve. Keeping the two conditions
  // apart rather than widening `isRequest` keeps that distinction readable.
  const isWarning = presentation.tone === 'warning' && !inert
  const needsAttention = isRequest || isWarning

  // A REDACTED row — inert, or its target no longer reachable — carries no href
  // and no payload, because the server withholds the conversation title exactly
  // as it withholds the quoted snippet (IB-13). Falling back to "Untitled
  // conversation" there would misstate WHY the row is nameless: the thread has a
  // title, this reader is simply no longer entitled to it.
  const redacted = !item.href

  const vars = {
    actor: item.actorName ?? t('inbox.unknownActor'),
    subject: item.subject ?? t(redacted ? 'inbox.inert' : 'inbox.untitledConversation'),
    count: item.count,
  }

  const titleLeaf =
    pickKey(
      dictionary,
      presentation.i18nKey,
      // `count` is occurrences SINCE THE ROW WAS LAST READ, so 0 is the ordinary
      // state of a read row — and picking `titleOne` for it made a group of
      // twenty that had been read claim "1 new message". Three cases, not two.
      item.count > 1 ? ['titleMany', 'title'] : item.count === 1 ? ['titleOne', 'title'] : ['titleNone', 'titleOne', 'title'],
    ) ??
    'title'
  const title = t(`inbox.types.${presentation.i18nKey}.${titleLeaf}`, vars)
  const bodyLeaf = pickKey(dictionary, presentation.i18nKey, ['body'])
  /*
    A REDACTED row gets a complete sentence of its own rather than the templated
    "in {subject}".

    The template needs a real title to read as a phrase, and interpolating the
    withheld-target placeholder into it produced German nonsense — "2 neue
    Nachrichten in Nicht mehr verfügbar" — because one string was being asked to
    work in two grammatical positions: standalone (`conversationShared`'s body is a
    bare `{subject}`) and inside a preposition. The distinction the placeholder
    exists to make is still made, and now it is a sentence: the thread HAS a name,
    this reader is simply no longer entitled to it (IB-13).
  */
  const body = redacted
    ? t('inbox.bodyUnavailable')
    : bodyLeaf
      ? t(`inbox.types.${presentation.i18nKey}.${bodyLeaf}`, vars)
      : null

  /*
    Inline triage for a version waiting for a decision (ADR-0054): the three
    decisions on the row, so the reviewer answers here instead of navigating
    to Files first. Offered only while the round is still open for this
    reader — actionable, unresolved, reachable, and naming its version. The
    server enforces who may decide (project:edit, never the submitter); a
    refusal there surfaces as an error line, never as a silent nothing.
  */
  const canDecideReview =
    item.type === 'document.review_requested' &&
    item.actionable &&
    !resolved &&
    !inert &&
    item.resourceType === 'document' &&
    item.anchorId !== null
  const [reviewing, setReviewing] = useState<'approve' | 'request_changes' | 'reject' | null>(null)
  const [reviewComment, setReviewComment] = useState('')
  const [reviewChecked, setReviewChecked] = useState(false)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewFailed, setReviewFailed] = useState(false)
  const [reviewDecided, setReviewDecided] = useState(false)

  const sendReview = async () => {
    if (!canDecideReview || !reviewing || !item.anchorId || reviewBusy) return
    // Approval is signed, refusals are worded — the transition table's own
    // requirements, read at the same point the file pane reads them.
    if (reviewing === 'approve' && !reviewChecked) return
    const words = reviewComment.trim()
    if (reviewing !== 'approve' && words === '') return
    setReviewBusy(true)
    setReviewFailed(false)
    try {
      if (reviewing === 'approve') {
        await reviewClient.approve(item.resourceId, item.anchorId)
      } else if (reviewing === 'request_changes') {
        await reviewClient.requestChanges(item.resourceId, item.anchorId, words)
      } else {
        await reviewClient.reject(item.resourceId, item.anchorId, words)
      }
      // Decided here; resolved everywhere by the server, which settles the
      // round for every reviewer and nudges this list to re-read it.
      setReviewDecided(true)
      setReviewing(null)
      setReviewComment('')
      setReviewChecked(false)
    } catch {
      setReviewFailed(true)
    } finally {
      setReviewBusy(false)
    }
  }

  return (
    /* The row owns its own <li>, so it is the element that animates — wrapping it
       from the list would nest <li> in <li>, and a `display: contents` wrapper has
       no box for a transform to act on. Exit + layout so archiving closes the gap
       rather than snapping it shut; `AnimatePresence` lives in InboxList. */
    <Item
      asChild
      className={cn(
        'relative items-start py-3.5',
        inert && 'bg-muted hover:bg-muted',
      )}
    >
      <motion.li
        ref={ref}
        layout
        exit={{ opacity: 0, x: 12 }}
        transition={motionQuick}
        data-testid="inbox-item"
        data-state={item.state}
        data-type={item.type}
      >
        {/* Type icon. A live request carries the "needs attention" tint; colour
            never travels alone here — the icon and the title text say the same. */}
        <ItemMedia
          aria-hidden
          className={cn(
            'mt-0.5 rounded-full border',
            needsAttention
              ? 'border-transparent bg-warning-subtle text-warning'
              : 'border-border bg-card text-muted-foreground',
            inert && 'opacity-60',
          )}
        >
          <Icon className="size-4" />
        </ItemMedia>

        <ItemContent className={cn(inert && 'opacity-70')}>
          <ItemTitle
            className={cn(
              // overflow-visible: `truncate` on ItemTitle would clip the
              // stretched-link overlay to the title box.
              'flex min-w-0 items-start gap-2 overflow-visible whitespace-normal',
              unread ? 'font-semibold' : 'font-normal',
            )}
          >
            {/* Unread marker — reserved always so marking read does not shove
                the title. Opacity only; the row is also heavier, so this is
                decoration. */}
            <span
              aria-hidden
              className={cn(
                'mt-[7px] size-1.5 shrink-0 rounded-full bg-foreground',
                'transition-opacity duration-snap ease-out motion-reduce:transition-none',
                unread ? 'opacity-100' : 'opacity-0',
              )}
            />
            {item.href && !inert ? (
              // Stretched link: the whole row is the target without nesting the
              // archive button inside the anchor (that button is lifted above the
              // overlay with `z-10`).
              <Link
                href={item.href}
                // Only a plain primary click counts as "opened". Cmd/ctrl/middle
                // click is the natural triage gesture — open three rows in
                // background tabs — and it used to spend the read state of all
                // three and, under the "needs me" filter, delete them from under
                // the cursor while the user was still clicking.
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                  if (event.button !== 0) return
                  onOpen?.(item)
                }}
                onAuxClick={(event) => event.stopPropagation()}
                className={cn(
                  'min-w-0 rounded-sm leading-snug outline-none',
                  'after:absolute after:inset-0 after:content-[""]',
                  'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
                  unread ? 'font-semibold text-foreground' : 'text-foreground',
                )}
              >
                {title}
              </Link>
            ) : (
              <span
                className={cn(
                  'min-w-0 leading-snug',
                  unread ? 'font-semibold text-foreground' : 'text-foreground',
                )}
              >
                {title}
              </span>
            )}
          </ItemTitle>

          {body && <ItemDescription className="mt-0.5">{body}</ItemDescription>}

          {item.excerpt && (
            <p className="mt-1.5 line-clamp-2 border-l border-border pl-2.5 text-sm leading-relaxed text-muted-foreground">
              {item.excerpt}
            </p>
          )}

          {/* The excerpt above is the order once the submit request carries
              one; the open link below is the file behind the decision. A real
              diff needs the previous version, which the payload does not name
              — so triage opens the file, it does not pretend to compare. */}
          {canDecideReview && (
            <div className="relative z-10 mt-2" data-testid="inbox-review-actions">
              {reviewDecided ? (
                <p
                  className="text-muted-foreground text-xs"
                  data-testid="inbox-review-decided"
                >
                  {t('inbox.review.decided')}
                </p>
              ) : reviewing === null ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={reviewBusy}
                    data-testid="inbox-review-approve"
                    onClick={() => {
                      setReviewFailed(false)
                      setReviewChecked(false)
                      setReviewing('approve')
                    }}
                  >
                    {t('inbox.review.approve')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={reviewBusy}
                    data-testid="inbox-review-request-changes"
                    onClick={() => {
                      setReviewFailed(false)
                      setReviewComment('')
                      setReviewing('request_changes')
                    }}
                  >
                    {t('inbox.review.requestChanges')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={reviewBusy}
                    data-testid="inbox-review-reject"
                    onClick={() => {
                      setReviewFailed(false)
                      setReviewComment('')
                      setReviewing('reject')
                    }}
                  >
                    {t('inbox.review.reject')}
                  </Button>
                  {item.href && (
                    <a
                      href={item.href}
                      className="text-primary text-xs font-medium hover:underline"
                      data-testid="inbox-review-open"
                    >
                      {t('inbox.review.open')}
                    </a>
                  )}
                </div>
              ) : reviewing === 'approve' ? (
                /* The same minimum ceremony as on the file: never one click,
                   and the signature names the same facts — which stand is
                   released and who acts when — resolved from what the row
                   already carries (subject + round opening), never fetched. */
                <div
                  className="space-y-2 rounded-lg border p-2"
                  data-testid="inbox-review-approve-confirm"
                >
                  <p className="text-xs font-medium" data-testid="inbox-review-approve-stand">
                    {t('inbox.review.approveStand', {
                      subject: item.subject ?? t('inbox.untitledConversation'),
                      date: formatAbsoluteTime(item.createdAt, locale),
                    })}
                  </p>
                  <p
                    className="text-muted-foreground text-xs"
                    data-testid="inbox-review-approve-acting"
                  >
                    {t('inbox.review.approveActing', {
                      date: formatAbsoluteTime(new Date().toISOString(), locale),
                    })}
                  </p>
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id={`inbox-review-approve-${item.id}`}
                      checked={reviewChecked}
                      onCheckedChange={(checked) => setReviewChecked(checked === true)}
                      data-testid="inbox-review-approve-checkbox"
                    />
                    <label
                      htmlFor={`inbox-review-approve-${item.id}`}
                      className="text-xs leading-snug"
                    >
                      {t('inbox.review.approveConfirm')}
                    </label>
                  </div>
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => {
                        setReviewing(null)
                        setReviewChecked(false)
                      }}
                    >
                      {t('inbox.review.cancel')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={!reviewChecked || reviewBusy}
                      data-testid="inbox-review-approve-send"
                      onClick={() => void sendReview()}
                    >
                      {t('inbox.review.approve')}
                    </Button>
                  </div>
                </div>
              ) : (
                /* A refusal without words is refused by the transition itself;
                   the button stays shut until something is typed. */
                <div className="space-y-2 rounded-lg border p-2" data-testid="inbox-review-comment">
                  <label
                    htmlFor={`inbox-review-comment-${item.id}`}
                    className="text-muted-foreground block text-xs"
                  >
                    {t(
                      reviewing === 'reject'
                        ? 'inbox.review.reasonLabel'
                        : 'inbox.review.changesLabel',
                    )}
                  </label>
                  <Textarea
                    id={`inbox-review-comment-${item.id}`}
                    value={reviewComment}
                    autoFocus
                    rows={2}
                    onChange={(event) => setReviewComment(event.target.value)}
                  />
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => {
                        setReviewing(null)
                        setReviewComment('')
                      }}
                    >
                      {t('inbox.review.cancel')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={reviewComment.trim() === '' || reviewBusy}
                      data-testid="inbox-review-comment-send"
                      onClick={() => void sendReview()}
                    >
                      {t('inbox.review.send')}
                    </Button>
                  </div>
                </div>
              )}
              {reviewFailed && (
                <p className="text-error mt-1.5 text-xs" data-testid="inbox-review-failed">
                  {t('inbox.review.failed')}
                </p>
              )}
            </div>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {/* `updatedAt`, which is what the list is ORDERED by. A grouped row
                that just absorbed a new message sorts to the top, and showing its
                `createdAt` put "5 days ago" at the head of the list. The title
                carries the absolute moment for both. */}
            <time
              className="text-xs text-muted-foreground"
              dateTime={item.updatedAt}
              title={formatAbsoluteTime(item.updatedAt, locale)}
            >
              {formatRelativeTime(item.updatedAt, locale)}
            </time>
            {resolved && item.actionable && (
              <Badge variant="success" className="gap-1">
                <CheckCircle2 aria-hidden />
                {t('inbox.resolved')}
              </Badge>
            )}
            {inert && (
              <>
                <Badge variant="secondary" className="gap-1">
                  <EyeOff aria-hidden />
                  {t('inbox.inert')}
                </Badge>
                <span className="text-xs text-muted-foreground">{t('inbox.inertHint')}</span>
              </>
            )}
            {/* z-10, like the archive control: the row's stretched link paints an
                overlay across the whole card, and anything meant to be clickable
                has to sit above it. Never on an inert row — its target is gone,
                which is the same reason the title is not a link there. */}
            {documentProjectId && !inert && (
              <DiscussDocumentButton
                projectId={documentProjectId}
                documentId={item.resourceId}
                variant="outline"
                withIcon
                className="relative z-10"
              />
            )}
          </div>
        </ItemContent>

        {onArchive && (
          <ItemActions>
            {/* z-10 keeps this above the stretched link's overlay so it stays
                clickable; it is a sibling of the anchor, never a child. */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="relative z-10 mt-0.5 text-muted-foreground"
              aria-label={t('inbox.archive')}
              onClick={() => onArchive(item.id)}
            >
              <Archive className="size-4" aria-hidden />
            </Button>
          </ItemActions>
        )}
      </motion.li>
    </Item>
  )
})
