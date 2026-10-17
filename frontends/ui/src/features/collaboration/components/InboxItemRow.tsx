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
 * The exceptions below are BEHAVIOUR, not looks. A version waiting for a
 * decision carries its three decisions inline, so triage happens here instead
 * of forcing a round-trip through Files. It keys on the actionable document
 * type alone, renders through the same atoms, and resolves server-side — the
 * decision settles the round for every reviewer (`resolveReviewInbox`) and the
 * list re-reads on the `inbox.changed` nudge. Nothing persists on a chat
 * message, so `useCardDecision` does not apply here. A row about a mark (its
 * presentation says `anchor: 'mark'`) opens at the mark, and a request on one
 * (assigned to the reader, or Piloti's question) is answered or resolved right
 * here, through the annotations' own client: the same writes the thread makes.
 *
 * The row answers **who / what / where / when without being opened** (IB-20):
 * the title carries the actor, the body the subject, the excerpt the actual
 * question, and the timestamp the when (relative, with the exact moment on hover).
 * A row a person caused wears their face, with the type's glyph in its corner;
 * Piloti's rows wear Piloti's.
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

import type { JSX } from 'react'
import { forwardRef, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Archive,
  ArchiveRestore,
  AtSign,
  CheckCircle2,
  Clock,
  EyeOff,
  HardDrive,
  Layers,
  Mail,
  MailOpen,
  Megaphone,
  MessageSquare,
  MoreHorizontal,
  ShieldAlert,
  UserPlus,
  type LucideIcon,
  AlertTriangle,
} from 'lucide-react'

import { useI18n, useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { inboxItemCopy } from '@/lib/inbox/item-copy'
import {
  INBOX_TYPE_PRESENTATION,
  isMarkAnchored,
  UNKNOWN_TYPE_PRESENTATION,
  type InboxItemView,
  type InboxTypePresentation,
} from '@/lib/inbox/types'
import { AnnotationRequestError, replyToAnnotation, updateAnnotation } from '@/lib/annotations/client'
import { ActionMenu, type ActionMenuEntry } from '@/components/ui/action-menu'
import { PersonAvatar } from '@/components/ui/avatar-stack'
import { PilotiGlyph } from '@/components/ui/piloti-glyph'
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
import {
  DocumentLifecycleError,
  documentLifecycleClient,
} from '@/lib/documents/lifecycle-client'
import type { DocumentVersionView } from '@/lib/documents/lifecycle-types'
import { DiscussDocumentButton } from '@/features/documents/components/discuss-document-button'
import { projectIdFromDocumentHref } from '@/features/documents/lib/document-question'
import { compareFassungHref } from '@/features/documents/lib/fassung-compare-link'

/**
 * The ONE place the registry's icon names become components. Keeping the map here
 * (rather than storing components in `lib/inbox/types.ts`) keeps the registry a
 * plain data module that the server half can import without pulling in React.
 * `piloti` is not a Lucide icon but Piloti's own glyph, drawn below.
 */
const ICONS: Record<Exclude<InboxTypePresentation['icon'], 'piloti'>, LucideIcon> =
  {
    'at-sign': AtSign,
    'message-square': MessageSquare,
    'user-plus': UserPlus,
    'check-circle': CheckCircle2,
    'hard-drive': HardDrive,
    'alert-triangle': AlertTriangle,
    clock: Clock,
    layers: Layers,
    megaphone: Megaphone,
    'shield-alert': ShieldAlert,
  }

/** The two writes a mark row makes, through the annotations' own client. Injected by the specs. */
export interface InboxMarkClient {
  reply: typeof replyToAnnotation
  update: typeof updateAnnotation
}

const MARK_CLIENT: InboxMarkClient = { reply: replyToAnnotation, update: updateAnnotation }

/** The types whose row answers a mark here: the reader is responsible for it, or Piloti asked them. */
const MARK_REQUEST_TYPES: ReadonlySet<string> = new Set(['annotation.assigned_to_you', 'piloti.asks_you'])

/** Only a plain primary click counts as "opened"; see the title link. */
function isPlainClick(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number }): boolean {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) && event.button === 0
}

export interface InboxItemRowProps {
  item: InboxItemView
  /** Called when the row's link is followed, so the list can mark it read. */
  onOpen?: (item: InboxItemView) => void
  /** Called by the archive button and the menu entry. Omit to hide both. */
  onArchive?: (itemId: string) => void
  /** Takes an archived row back („Wiederherstellen“). Offered only on an archived row. */
  onUnarchive?: (itemId: string) => void
  /** „Als gelesen markieren“ in the row's menu, for an unread row. */
  onMarkRead?: (itemId: string) => void
  /** „Als ungelesen markieren“ in the row's menu, for a read row. */
  onMarkUnread?: (itemId: string) => void
  /** The row the list's keyboard is on (j/k): drawn with a ring, and the one Enter opens. */
  focused?: boolean
  /** Answering or resolving a mark from the row. Injected by the specs. */
  markClient?: InboxMarkClient
  /**
   * Runs an inline review decision. Injected by the specs; the browser gets
   * the real typed client. Narrowed to the three decisions a reviewer may
   * take — nothing else on this row writes lifecycle state — plus the version
   * read that names the STAND (Fassung number, date) and carries its
   * `contentHash` as the `ifMatch` the decisions send.
   */
  reviewClient?: Pick<DocumentLifecycleClient, 'approve' | 'requestChanges' | 'reject'> &
    Partial<Pick<DocumentLifecycleClient, 'getVersion'>>
}

export const InboxItemRow = forwardRef<HTMLLIElement, InboxItemRowProps>(function InboxItemRow(
  {
    item,
    onOpen,
    onArchive,
    onUnarchive,
    onMarkRead,
    onMarkUnread,
    focused = false,
    reviewClient = documentLifecycleClient,
    markClient = MARK_CLIENT,
  },
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
  const Icon = presentation.icon === 'piloti' ? null : ICONS[presentation.icon]

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

  /*
    „Fassungen vergleichen", the next move on a new Fassung filed under another
    name: BEHAVIOUR keyed on the type, like the review triage below. The row
    then names two documents — the newer is the resource, the older the anchor
    — and the link opens the newer one's preview with the comparison against
    the older already open. A same-name version anchors on the version and
    has nothing to lay side by side here; its row opens the document, whose
    Fassungen section compares the text.
  */
  const compareHref =
    item.type === 'document.new_fassung' &&
    item.state !== 'inert' &&
    item.resourceType === 'document' &&
    item.related !== null &&
    item.anchorId !== null &&
    item.anchorId !== item.resourceId
      ? compareFassungHref(item.href, item.anchorId)
      : null

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

  // A REDACTED row carries no href and no payload (IB-13); `inboxItemCopy` words it.
  const redacted = !item.href

  const { title, body } = inboxItemCopy(item, t, dictionary)
  // The server's own fact: an archived row whose target went away reads
  // `state: 'inert'`, and must still be restored rather than archived again.
  const archived = item.archived

  /*
    A row about a mark (`anchor: 'mark'`): its next move is the mark itself,
    not a chat about the whole document, so „Zur Anmerkung“ leads and „Mit
    Piloti besprechen“ is not offered. The row's resource is the document and
    its anchor the mark, which is all the annotations' client needs.
  */
  const markRow =
    isMarkAnchored(item.type) && !inert && !redacted && item.resourceType === 'document' && item.anchorId !== null
  const markOpen = markRow && MARK_REQUEST_TYPES.has(item.type) && item.actionable && !resolved && !archived
  const canResolveMark = markOpen && item.type === 'annotation.assigned_to_you'
  const [replying, setReplying] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [markBusy, setMarkBusy] = useState(false)
  const [markOutcome, setMarkOutcome] = useState<'sent' | 'resolved' | 'conflict' | 'failed' | null>(null)

  const sendReply = async (): Promise<void> => {
    const words = replyText.trim()
    if (!markOpen || !item.anchorId || words === '' || markBusy) return
    setMarkBusy(true)
    setMarkOutcome(null)
    try {
      await markClient.reply(item.resourceId, item.anchorId, { body: words })
      setReplying(false)
      setReplyText('')
      setMarkOutcome('sent')
      // Answered from here is read here: the thread has the reply.
      onOpen?.(item)
    } catch {
      setMarkOutcome('failed')
    } finally {
      setMarkBusy(false)
    }
  }

  const resolveMark = async (): Promise<void> => {
    if (!canResolveMark || !item.anchorId || markBusy) return
    setMarkBusy(true)
    setMarkOutcome(null)
    try {
      // `expectedStatus`: a mark somebody reopened or dismissed meanwhile is a
      // 409, never overwritten from a copy of it.
      await markClient.update(item.resourceId, item.anchorId, { status: 'resolved', expectedStatus: 'open' })
      setMarkOutcome('resolved')
    } catch (error) {
      setMarkOutcome(error instanceof AnnotationRequestError && error.status === 409 ? 'conflict' : 'failed')
    } finally {
      setMarkBusy(false)
    }
  }

  // The row's own menu: read state, archive (the only archive control on a
  // phone, where an icon column cost the text its width) and restore.
  const menuEntries: ActionMenuEntry[] = [
    ...(item.state === 'unread' && onMarkRead
      ? [{ type: 'item' as const, id: 'read', label: t('inbox.markRead'), icon: MailOpen, onSelect: () => onMarkRead(item.id), testId: 'inbox-mark-read' }]
      : []),
    ...(item.state === 'read' && onMarkUnread
      ? [{ type: 'item' as const, id: 'unread', label: t('inbox.markUnread'), icon: Mail, onSelect: () => onMarkUnread(item.id), testId: 'inbox-mark-unread' }]
      : []),
    ...(archived && onUnarchive
      ? [{ type: 'item' as const, id: 'unarchive', label: t('inbox.unarchive'), icon: ArchiveRestore, onSelect: () => onUnarchive(item.id), testId: 'inbox-unarchive' }]
      : []),
    ...(!archived && onArchive
      ? [{ type: 'item' as const, id: 'archive', label: t('inbox.archive'), icon: Archive, onSelect: () => onArchive(item.id), testId: 'inbox-archive-menu' }]
      : []),
  ]

  // Who caused it, when a person did: their face, with the type's glyph in the
  // corner. Piloti's rows keep Piloti's face; a system row keeps its glyph.
  const actorFace =
    presentation.icon !== 'piloti' && item.actorUserId && item.actorName
      ? { userId: item.actorUserId, name: item.actorName }
      : null

  /*
    Inline triage for a version waiting for a decision (ADR-0054): the three
    decisions on the row, so the reviewer answers here instead of navigating
    to Files first. Offered only while the round is still open for this
    reader — actionable, unresolved, reachable, naming its version AND its
    Fassung (the subject is required: without it the confirm could not name
    which document the signature releases). The server enforces who may decide
    (project:edit, never the submitter); a refusal there surfaces as an error
    line, never as a silent nothing.
  */
  const canDecideReview =
    item.type === 'document.review_requested' &&
    item.actionable &&
    !resolved &&
    !inert &&
    item.resourceType === 'document' &&
    item.anchorId !== null &&
    item.subject !== null
  const [reviewing, setReviewing] = useState<'approve' | 'request_changes' | 'reject' | null>(null)
  const [reviewComment, setReviewComment] = useState('')
  const [reviewChecked, setReviewChecked] = useState(false)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewFailed, setReviewFailed] = useState(false)
  const [reviewStale, setReviewStale] = useState(false)
  const [reviewDecided, setReviewDecided] = useState(false)
  const [reviewVersion, setReviewVersion] = useState<DocumentVersionView | null>(null)
  const [reviewVersionError, setReviewVersionError] = useState(false)

  // The STAND the decisions act on: version number for the signature (Fassung
  // required — nothing is released without naming it) and `contentHash` as the
  // `ifMatch` the calls below send, so a stale row 409s instead of deciding on
  // bytes the reviewer never saw. Read with the row, not when a decision
  // opens: the signature must already name the Fassung when it appears, and a
  // refusal must already carry the expected bytes when it is sent — waiting
  // for the read inside the confirm would race the send. One attempt per
  // version anchor; a failed read falls back to deciding on state alone,
  // exactly as before, rather than stranding the row.
  //
  // Deliberately NO loading flag: setting one before the `await` would re-run
  // this effect (it is in the deps) and its cleanup would flip `live` to false
  // while the read is still in flight — the resolve below would then be
  // discarded and the STAND would never arrive. The pending state is visible
  // anyway: the stand renders '…' and the approve send stays shut until the
  // Fassung number is known.
  useEffect(() => {
    if (!canDecideReview || !item.anchorId) return
    if (reviewVersion !== null || reviewVersionError) return
    if (typeof reviewClient.getVersion !== 'function') return
    let live = true
    void reviewClient
      .getVersion(item.resourceId, item.anchorId)
      .then((version) => {
        if (live) {
          setReviewVersion(version)
        }
      })
      .catch(() => {
        if (live) {
          setReviewVersionError(true)
        }
      })
    return () => {
      live = false
    }
  }, [
    canDecideReview,
    item.anchorId,
    item.resourceId,
    reviewClient,
    reviewVersion,
    reviewVersionError,
  ])

  const sendReview = async () => {
    if (!canDecideReview || !reviewing || !item.anchorId || reviewBusy) return
    // Approval is signed, refusals are worded — the transition table's own
    // requirements, read at the same point the file pane reads them. Approval
    // additionally requires the Fassung number: the stand is not released
    // without naming which version it releases.
    if (reviewing === 'approve' && !reviewChecked) return
    if (reviewing === 'approve' && typeof reviewClient.getVersion === 'function') {
      if (reviewVersion?.versionNumber == null) return
    }
    const words = reviewComment.trim()
    if (reviewing !== 'approve' && words === '') return
    setReviewBusy(true)
    setReviewFailed(false)
    setReviewStale(false)
    // The expected bytes, when the STAND above could be read. Absent when the
    // read never ran (old callers, a version without a digest): the server
    // then decides on state alone, exactly as before, and a provided-but-stale
    // digest 409s with the current STAND.
    const ifMatch = reviewVersion?.contentHash ?? undefined
    try {
      if (reviewing === 'approve') {
        await reviewClient.approve(item.resourceId, item.anchorId, undefined, ifMatch)
      } else if (reviewing === 'request_changes') {
        await reviewClient.requestChanges(item.resourceId, item.anchorId, words, undefined, ifMatch)
      } else {
        await reviewClient.reject(item.resourceId, item.anchorId, words, ifMatch)
      }
      // Decided here; resolved everywhere by the server, which settles the
      // round for every reviewer and nudges this list to re-read it.
      setReviewDecided(true)
      setReviewing(null)
      setReviewComment('')
      setReviewChecked(false)
    } catch (error) {
      // A 409 is not a failed decision, it is a moved STAND: somebody decided
      // first, or the bytes changed under the row. Surfaced distinctly, with
      // the file as the way back to the current Fassung — never as a silent
      // nothing, and never as the generic red line.
      if (error instanceof DocumentLifecycleError && error.status === 409) {
        setReviewStale(true)
      } else {
        setReviewFailed(true)
      }
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
        'relative items-start py-3',
        // The unread accent: a 3px bar down the row's edge, which survives glare
        // and a thumb over the title where a 6px dot did not. The list clips
        // (`overflow-hidden`), so it takes the card's corner.
        unread &&
          'before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-foreground before:content-[""]',
        inert && 'bg-muted hover:bg-muted',
        // The keyboard's row (j/k): a ring inside the card and the hover tint,
        // so it reads in both themes without a colour of its own.
        focused && 'bg-accent/40 ring-2 ring-inset ring-ring',
      )}
    >
      <motion.li
        ref={ref}
        layout
        exit={{ opacity: 0, x: 12 }}
        transition={motionQuick}
        data-testid="inbox-item"
        data-item-id={item.id}
        data-state={item.state}
        data-type={item.type}
        data-focused={focused || undefined}
        tabIndex={-1}
      >
        {/* Type icon. A live request carries the "needs attention" tint; colour
            never travels alone here — the icon and the title text say the same. */}
        {actorFace ? (
          <ItemMedia aria-hidden className={cn('relative mt-0.5', inert && 'opacity-90')}>
            <PersonAvatar person={actorFace} size="md" />
            {Icon && (
              <span
                data-testid="inbox-item-type-badge"
                className={cn(
                  'absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full border',
                  needsAttention
                    ? 'border-transparent bg-warning-subtle text-warning'
                    : 'border-border bg-card text-muted-foreground',
                )}
              >
                <Icon className="size-2.5" />
              </span>
            )}
          </ItemMedia>
        ) : Icon ? (
          <ItemMedia
            aria-hidden
            className={cn(
              'mt-0.5 rounded-full border',
              needsAttention
                ? 'border-transparent bg-warning-subtle text-warning'
                : 'border-border bg-card text-muted-foreground',
              inert && 'opacity-90',
            )}
          >
            <Icon className="size-4" />
          </ItemMedia>
        ) : (
          // Piloti's rows wear its face, drawn as a line like every other row's
          // glyph; a live request keeps the tint, and the title still says what
          // is asked: colour never travels alone.
          <ItemMedia aria-hidden className={cn('mt-0.5', inert && 'opacity-90')}>
            <PilotiGlyph
              size="lg"
              tone="outline"
              className={cn(needsAttention && 'border-transparent bg-warning-subtle text-warning')}
            />
          </ItemMedia>
        )}

        <ItemContent className={cn(inert && 'opacity-90')}>
          <ItemTitle
            className={cn(
              // overflow-visible: `truncate` on ItemTitle would clip the
              // stretched-link overlay to the title box.
              'flex min-w-0 items-start gap-2 overflow-visible whitespace-normal',
              unread ? 'font-semibold' : 'font-normal',
            )}
          >
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
                  if (isPlainClick(event)) onOpen?.(item)
                }}
                onAuxClick={(event) => event.stopPropagation()}
                data-testid="inbox-item-link"
                className={cn(
                  'min-w-0 rounded-sm leading-snug outline-none',
                  'after:absolute after:inset-0 after:content-[""]',
                  'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
                  // A read row steps back in dark mode, where weight alone did
                  // not tell the two apart.
                  unread ? 'font-semibold text-foreground' : 'text-foreground dark:text-muted-foreground',
                )}
              >
                {title}
              </Link>
            ) : (
              <span
                className={cn(
                  'min-w-0 leading-snug',
                  unread ? 'font-semibold text-foreground' : 'text-foreground dark:text-muted-foreground',
                )}
              >
                {title}
              </span>
            )}
          </ItemTitle>

          {/* Two lines, not one: the body is where a row says what to do, and one
              truncated line cut that sentence off in its middle. */}
          {body && <ItemDescription className="mt-0.5 line-clamp-2 whitespace-normal">{body}</ItemDescription>}

          {/* Three lines when it is the only body: then it is the news, and
              on a phone two lines cut a change off mid-sentence. */}
          {item.excerpt && (
            <p
              className={cn(
                'mt-1 border-l border-border pl-2.5 text-sm leading-relaxed text-muted-foreground',
                // Dense on a phone: three rows to a screen is a list nobody can
                // triage. A row that asks something of the reader keeps its
                // words; an FYI gets one line, and the item has the rest.
                // As the ONLY body it is the news and keeps three lines.
                body ? (item.actionable && !resolved && !inert ? 'line-clamp-2' : 'line-clamp-1') : 'line-clamp-3',
              )}
              data-testid="inbox-item-excerpt"
            >
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
                      setReviewStale(false)
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
                      setReviewStale(false)
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
                      setReviewStale(false)
                      setReviewComment('')
                      setReviewing('reject')
                    }}
                  >
                    {t('inbox.review.reject')}
                  </Button>
                  {item.href && (
                    <Link
                      href={item.href}
                      className="text-primary text-xs font-medium hover:underline"
                      data-testid="inbox-review-open"
                      onClick={(event) => {
                        if (isPlainClick(event)) onOpen?.(item)
                      }}
                    >
                      {t('inbox.review.open')}
                    </Link>
                  )}
                </div>
              ) : reviewing === 'approve' ? (
                /* The same minimum ceremony as on the file: never one click,
                   and the signature names the same facts — which Fassung is
                   released (subject + number + round opening) and who acts
                   when. The number is required: without the STAND read above
                   nothing is released. Who asked is already in the title, so
                   the acting line stays date-only like the file pane's own
                   fallback when no viewer name is known. */
                <div
                  className="space-y-2 rounded-lg border p-2"
                  data-testid="inbox-review-approve-confirm"
                >
                  <p className="text-xs font-medium" data-testid="inbox-review-approve-stand">
                    {t('inbox.review.approveStand', {
                      subject: item.subject ?? t('inbox.untitledConversation'),
                      number: reviewVersion?.versionNumber ?? '…',
                      date: formatAbsoluteTime(
                        reviewVersion?.updatedAt ?? item.createdAt,
                        locale,
                      ),
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
                  {/* The STAND read failed: say so and offer the retry, because
                      approval stays blocked without the Fassung number. A silent
                      '…' would read as a bug rather than as a blocked signature. */}
                  {reviewVersionError && (
                    <p className="text-error text-xs" data-testid="inbox-review-stand-failed">
                      {t('inbox.review.standFailed')}{' '}
                      <button
                        type="button"
                        className="text-primary font-medium hover:underline"
                        data-testid="inbox-review-stand-retry"
                        onClick={() => setReviewVersionError(false)}
                      >
                        {t('inbox.review.retry')}
                      </button>
                    </p>
                  )}
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
                      disabled={
                        !reviewChecked ||
                        reviewBusy ||
                        (typeof reviewClient.getVersion === 'function' &&
                          reviewVersion?.versionNumber == null)
                      }
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
              {reviewStale && (
                <p className="mt-1.5 text-xs" data-testid="inbox-review-stale">
                  <span className="text-error">{t('inbox.review.stale')}</span>{' '}
                  {item.href && (
                    <Link
                      href={item.href}
                      className="text-primary font-medium hover:underline"
                      data-testid="inbox-review-reload"
                      onClick={(event) => {
                        if (isPlainClick(event)) onOpen?.(item)
                      }}
                    >
                      {t('inbox.review.reload')}
                    </Link>
                  )}
                </p>
              )}
              {reviewFailed && (
                <p className="text-error mt-1.5 text-xs" data-testid="inbox-review-failed">
                  {t('inbox.review.failed')}
                </p>
              )}
            </div>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-2">
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
            {/* The badge is the one place a redacted row says so; the body
                already says it in a sentence. */}
            {inert && (
              <Badge variant="secondary" className="gap-1">
                <EyeOff aria-hidden />
                {t('inbox.inert')}
              </Badge>
            )}
            {/* z-10, like the archive control: the row's stretched link paints an
                overlay across the whole card, and anything meant to be clickable
                has to sit above it. Never on an inert row — its target is gone,
                which is the same reason the title is not a link there. */}
            {compareHref && (
              <Button asChild size="sm" className="relative z-10">
                <Link
                  href={compareHref}
                  aria-label={t('inbox.compareFassungenLabel', { subject: item.subject ?? t(redacted ? 'inbox.inert' : 'inbox.untitledConversation') })}
                  onClick={(event) => {
                    if (isPlainClick(event)) onOpen?.(item)
                  }}
                  data-testid="inbox-compare-fassungen"
                >
                  <Layers aria-hidden />
                  {t('inbox.compareFassungen')}
                </Link>
              </Button>
            )}
            {markRow && item.href && (
              <Button asChild size="sm" variant={markOpen ? 'default' : 'outline'} className="relative z-10 h-8">
                <Link
                  href={item.href}
                  onClick={(event) => {
                    if (isPlainClick(event)) onOpen?.(item)
                  }}
                  data-testid="inbox-open-mark"
                >
                  {t('inbox.mark.open')}
                </Link>
              </Button>
            )}
            {markOpen && !replying && markOutcome !== 'resolved' && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="relative z-10 h-8"
                disabled={markBusy}
                data-testid="inbox-mark-reply"
                onClick={() => {
                  setMarkOutcome(null)
                  setReplying(true)
                }}
              >
                {t('inbox.mark.reply')}
              </Button>
            )}
            {canResolveMark && !replying && markOutcome !== 'resolved' && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="relative z-10 h-8"
                disabled={markBusy}
                data-testid="inbox-mark-resolve"
                onClick={() => void resolveMark()}
              >
                {t('inbox.mark.resolve')}
              </Button>
            )}
            {documentProjectId && !inert && !markRow && (
              <DiscussDocumentButton
                projectId={documentProjectId}
                documentId={item.resourceId}
                variant="outline"
                iconOnlyOnPhone
                onNavigate={() => onOpen?.(item)}
                className="relative z-10"
              />
            )}
          </div>

          {markOpen && replying && (
            <div className="relative z-10 mt-2 space-y-2 rounded-lg border p-2" data-testid="inbox-mark-reply-form">
              <label htmlFor={`inbox-mark-reply-${item.id}`} className="text-muted-foreground block text-xs">
                {item.related ? t('inbox.mark.replyLabel', { related: item.related }) : t('inbox.mark.replyLabelNoNumber')}
              </label>
              <Textarea
                id={`inbox-mark-reply-${item.id}`}
                value={replyText}
                autoFocus
                rows={2}
                onChange={(event) => setReplyText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    void sendReply()
                  }
                }}
              />
              <div className="flex items-center justify-end gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => {
                    setReplying(false)
                    setReplyText('')
                  }}
                >
                  {t('inbox.mark.cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={replyText.trim() === '' || markBusy}
                  data-testid="inbox-mark-reply-send"
                  onClick={() => void sendReply()}
                >
                  {t('inbox.mark.send')}
                </Button>
              </div>
            </div>
          )}
          {markOutcome && (
            <p
              role={markOutcome === 'failed' || markOutcome === 'conflict' ? 'alert' : 'status'}
              className={cn(
                'mt-1.5 text-xs',
                markOutcome === 'failed' || markOutcome === 'conflict' ? 'text-error' : 'text-muted-foreground',
              )}
              data-testid="inbox-mark-outcome"
            >
              {t(`inbox.mark.${markOutcome}`)}
            </p>
          )}
        </ItemContent>

        {(menuEntries.length > 0 || (onArchive && !archived)) && (
          <ItemActions className="gap-0.5">
            {/* z-10 keeps these above the stretched link's overlay so they stay
                clickable; they are siblings of the anchor, never children. The
                archive icon is a desktop affordance: on a phone its column cost
                the title its width, and the menu carries archiving there. */}
            {onArchive && !archived && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="relative z-10 mt-0.5 text-muted-foreground max-sm:hidden"
                aria-label={t('inbox.archive')}
                onClick={() => onArchive(item.id)}
              >
                <Archive className="size-4" aria-hidden />
              </Button>
            )}
            <ActionMenu
              mode="dropdown"
              entries={menuEntries}
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="relative z-10 mt-0.5 text-muted-foreground"
                  aria-label={t('inbox.moreActions')}
                  data-testid="inbox-item-menu"
                >
                  <MoreHorizontal className="size-4" aria-hidden />
                </Button>
              }
            />
          </ItemActions>
        )}
      </motion.li>
    </Item>
  )
})
