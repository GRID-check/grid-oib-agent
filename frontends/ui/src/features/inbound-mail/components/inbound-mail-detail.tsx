'use client'

/**
 * One held mail, decided part by part (`InboundMailDetail`, DECISION §9).
 *
 * Top to bottom, in the order a person reads before deciding: who it is from
 * and how far that is confirmed, what the content check found in the text and
 * what to do about it, the text itself (plain, inert), where the text goes
 * (its E-Mail-Verlauf), each attachment with its case and its target, and the
 * decision bar pinned to the bottom. After filing: what landed, what did not
 * and why, and the offer to follow the conversation.
 *
 * The draft starts as Piloti's suggestion and the server's candidates; the
 * press is the takeover. A decision is sent with the mail's `ifMatch`, so a
 * colleague who decided first wins: the mail is read again and says so.
 * Filing runs as the person in a job; the detail follows the parts until none
 * is being filed any more, then reports.
 */

import type { JSX, MutableRefObject, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { AlertTriangle, ArchiveRestore, Loader2, Lock, Users, X } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { ItemList } from '@/components/ui/item'
import { LoadError } from '@/components/ui/load-error'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { documentFilesHref } from '@/features/documents/lib/document-question'
import { useLocale, useTranslations } from '@/i18n'
import type { InboundMailTextView, InboundMailView } from '@/lib/inbound-mail/inbound-mail-wire'
import { formatCalendarDate } from '@/lib/format'
import { attachmentCase, notStagedSummary } from '../lib/attachment-case'
import type { InboundMailClient } from '../lib/client'
import {
  chooseFinding,
  decisionOf,
  draftSummary,
  initialDraft,
  updateAttachment,
  updateMessage,
  type DraftCopy,
  type FolderOption,
  type MailDraft,
} from '../lib/draft'
import { forwardedOrigin } from '../lib/forwarded'
import { refusalNeedsReload, refusalOf } from '../lib/refusal'
import { followOffered } from '../lib/sender'
import { missingSuggestionReason } from '../lib/suggestion'
import { AttachmentPreviewDialog } from './attachment-preview-dialog'
import { AttachmentRow } from './attachment-row'
import { ContentFindingChoice } from './content-finding-choice'
import { DecisionBar } from './decision-bar'
import { FollowOffer } from './follow-offer'
import { FactLine } from './inbound-mail-atoms'
import { MailHeader } from './mail-header'
import { MailText, type MailTextState } from './mail-text'
import { MessageRow } from './message-row'

/** What the keyboard can ask of the open detail. */
export interface DetailActions {
  /** „Wie gezeigt ablegen“ (E): the primary action, exactly as the bar shows it. */
  file: () => void
  /** „Verwerfen“ (⌫). */
  dismiss: () => void
  /** „Anhang ansehen“ (Space): the first attachment that can be drawn. */
  preview: () => void
}

type ViewState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; view: InboundMailView }

/**
 * What filing left, read off the mail itself so it is true after a reload too:
 * attachments that wait again with a failure, against those filed, and
 * whether the office's storage was the reason.
 */
export function filingOutcome(view: InboundMailView): { failed: number; total: number; quota: boolean } {
  const attachments = view.parts.filter((part) => part.kind === 'attachment')
  const failed = attachments.filter((part) => part.state === 'waiting' && part.lastFailure !== null)
  const filed = attachments.filter((part) => part.state === 'filed')
  return { failed: failed.length, total: failed.length + filed.length, quota: failed.some((part) => part.lastFailure === 'quota') }
}

export interface InboundMailDetailProps {
  projectId: string
  mailId: string
  /** The mail as the page read it; null reads it here. */
  initial: InboundMailView | null
  /** The text, for a preview that pins it; omitted reads it here. */
  initialText?: InboundMailTextView | null
  folders: readonly FolderOption[]
  client: InboundMailClient
  /** Something of this mail changed (decided, restored): the list and the counts read again. */
  onChanged: () => void
  /** The way back to the list, where the detail is a page of its own (a phone). */
  back?: ReactNode
  actionsRef?: MutableRefObject<DetailActions | null>
  /** Now, for the suggestion's „Piloti liest noch …“; a preview pins it. */
  now?: number
  /** How long to wait between reads while parts are being filed (a spec shortens it). */
  pollMs?: number
  /** Start with „decided by someone else“ said (a preview of that state). */
  decidedByOther?: boolean
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function InboundMailDetail({
  projectId,
  mailId,
  initial,
  initialText,
  folders,
  client,
  onChanged,
  back,
  actionsRef,
  now,
  pollMs = 1500,
  decidedByOther: decidedByOtherInitially = false,
}: InboundMailDetailProps): JSX.Element {
  const t = useTranslations('inboundMail')
  const { locale } = useLocale()
  const router = useRouter()
  const [state, setState] = useState<ViewState>(initial ? { kind: 'ready', view: initial } : { kind: 'loading' })
  const [text, setText] = useState<MailTextState>(initialText ? { kind: 'ready', text: initialText } : { kind: 'loading' })
  const [draft, setDraft] = useState<MailDraft | null>(null)
  const [filing, setFiling] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [decidedByOther, setDecidedByOther] = useState(decidedByOtherInitially)
  const [threadNameStopped, setThreadNameStopped] = useState(false)
  const [closedNoticeHidden, setClosedNoticeHidden] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [followTarget, setFollowTarget] = useState<{ threadId: string; name: string; followed: boolean } | null>(null)
  const alive = useRef(true)
  useEffect(() => () => void (alive.current = false), [])

  const copy: DraftCopy = useMemo(
    () => ({ unnamedAttachment: (position) => t('attachments.unnamed', { position }), untitledThread: t('row.noSubject') }),
    [t]
  )

  const view = state.kind === 'ready' ? state.view : null

  const load = useCallback(async () => {
    try {
      const next = await client.get(projectId, mailId)
      if (alive.current) setState({ kind: 'ready', view: next })
      return next
    } catch {
      if (alive.current) setState((current) => (current.kind === 'ready' ? current : { kind: 'error' }))
      return null
    }
  }, [client, projectId, mailId])

  const loadText = useCallback(async () => {
    setText({ kind: 'loading' })
    try {
      const next = await client.text(projectId, mailId)
      if (alive.current) setText({ kind: 'ready', text: next })
    } catch {
      if (alive.current) setText({ kind: 'error' })
    }
  }, [client, projectId, mailId])

  // A new mail: read it (unless the page did) and its text.
  useEffect(() => {
    setDecidedByOther(decidedByOtherInitially)
    setThreadNameStopped(false)
    setFollowTarget(null)
    if (!initial || initial.id !== mailId) {
      setState({ kind: 'loading' })
      void load()
    } else {
      setState({ kind: 'ready', view: initial })
    }
    if (!initialText) void loadText()
    else setText({ kind: 'ready', text: initialText })
    // `initial` and `initialText` are the page's first answer for this mail; a re-render with a new object is not a new mail.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed on the mail, see above
  }, [mailId, load, loadText])

  // The draft follows the mail: a new mail, or the same mail changed (read again after a refusal).
  const ifMatch = view?.ifMatch
  useEffect(() => {
    if (view) setDraft(initialDraft(view, folders, copy))
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-drafted on a new ifMatch only, never on an edit
  }, [view?.id, ifMatch, folders, copy])

  // A filed text may be followed: find its thread once, to name it and to know whether it is followed already.
  const messagePart = view?.parts.find((part) => part.kind === 'message')
  const messageDocumentId = messagePart?.state === 'filed' ? messagePart.documentId : null
  const offerFollow = !!view && followOffered(view) && !view.followedBy
  useEffect(() => {
    if (!messageDocumentId || !offerFollow) return
    let cancelled = false
    client
      .threadOfDocument(projectId, messageDocumentId)
      .then((thread) => {
        if (!cancelled && thread) setFollowTarget({ threadId: thread.id, name: thread.name, followed: thread.followed })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [client, projectId, messageDocumentId, offerFollow])

  const summary = view && draft ? draftSummary(view, draft) : null

  /** Read the mail until no part is being filed, then report what landed. */
  const follow = async (sent: InboundMailView, filedIds: string[], textFiled: { name: string | null } | null): Promise<void> => {
    let current = sent
    let delay = pollMs
    for (let round = 0; round < 40 && current.parts.some((part) => part.state === 'filing'); round += 1) {
      await sleep(delay)
      delay = Math.min(delay * 1.5, 5000)
      const next = await client.get(projectId, mailId).catch(() => null)
      if (!alive.current) return
      if (next) {
        current = next
        setState({ kind: 'ready', view: next })
      }
    }
    const byId = new Map(current.parts.map((part) => [part.id, part]))
    const landed = filedIds.filter((id) => byId.get(id)?.state === 'filed')
    const firstDocument = landed.map((id) => byId.get(id)?.documentId).find((id): id is string => !!id)
    const viewAction = firstDocument
      ? { action: { label: t('toast.view'), onClick: () => router.push(documentFilesHref(projectId, firstDocument)) } }
      : {}
    if (landed.length > 0) toast.success(t('toast.filed', { count: landed.length }), viewAction)
    if (textFiled && byId.get(sent.parts.find((part) => part.kind === 'message')?.id ?? '')?.state === 'filed') {
      toast.success(textFiled.name ? t('toast.textFiled', { name: textFiled.name }) : t('toast.textFiledNew'))
    }
    onChanged()
  }

  const file = async (): Promise<void> => {
    if (!view || !draft || !summary || filing || dismissing) return
    if (summary.files === 0 && !summary.text) return dismiss()
    if (summary.blockers.length > 0) return
    setFiling(true)
    const decision = decisionOf(view, draft)
    try {
      const result = await client.file(projectId, { mails: [decision] })
      const sent = result.mails.find((mail) => mail.id === view.id)
      if (!sent || !alive.current) return
      setState({ kind: 'ready', view: sent })
      const appended = draft.message?.target.kind === 'append' ? view.threadCandidates.find((c) => c.threadId === (draft.message?.target as { threadId: string }).threadId) : null
      await follow(sent, decision.parts.map((part) => part.partId), decision.message ? { name: appended?.name ?? null } : null)
    } catch (error) {
      const code = refusalOf(error)
      if (code === 'name_stop' && decision.message?.thread.action === 'create') setThreadNameStopped(true)
      toast.error(t(`refusals.${code}`))
      if (refusalNeedsReload(code)) {
        const next = await load()
        if (next && !next.parts.some((part) => part.state === 'waiting')) {
          setDecidedByOther(true)
          onChanged()
        }
      }
    } finally {
      if (alive.current) setFiling(false)
    }
  }

  const restore = async (): Promise<void> => {
    setRestoring(true)
    try {
      const next = await client.restore(projectId, mailId)
      if (alive.current) setState({ kind: 'ready', view: next })
      toast.success(t('toast.restored'))
      onChanged()
    } catch (error) {
      toast.error(t(`refusals.${refusalOf(error)}`))
    } finally {
      if (alive.current) setRestoring(false)
    }
  }

  async function dismiss(): Promise<void> {
    if (!view || dismissing || filing) return
    setDismissing(true)
    try {
      const result = await client.dismiss(projectId, { mailIds: [view.id] })
      const next = result.mails.find((mail) => mail.id === view.id)
      if (next && alive.current) setState({ kind: 'ready', view: next })
      toast.success(t('toast.dismissed'), { action: { label: t('toast.undo'), onClick: () => void restore() } })
      onChanged()
    } catch (error) {
      const code = refusalOf(error)
      toast.error(t(`refusals.${code}`))
      if (refusalNeedsReload(code)) void load()
    } finally {
      if (alive.current) setDismissing(false)
    }
  }

  const attachments = useMemo(
    () => (view ? view.parts.filter((part) => part.kind === 'attachment').map((part) => attachmentCase(part, view)) : []),
    [view]
  )
  const previewable = attachments.find((entry) => entry.previewable && entry.part.state === 'waiting')

  if (actionsRef) {
    actionsRef.current = {
      file: () => void file(),
      dismiss: () => void dismiss(),
      preview: () => previewable && setPreview(previewable.part.id),
    }
  }

  if (state.kind === 'loading') return <DetailSkeleton back={back} />
  if (state.kind === 'error' || !view) {
    return (
      <div className="flex flex-col gap-4 p-4 sm:p-6">
        {back}
        <LoadError title={t('detailLoadError')} onRetry={() => load()} />
      </div>
    )
  }

  const missing = missingSuggestionReason(
    { automatic: view.automatic, senderTrust: view.sender?.trust ?? null, receivedAt: view.receivedAt },
    now
  )
  const notStaged = notStagedSummary(view.notStaged)
  const waitingParts = view.parts.filter((part) => part.state === 'waiting')
  const anyFiling = view.parts.some((part) => part.state === 'filing')
  const dismissedOrExpired = view.parts.filter((part) => part.state === 'dismissed' || part.state === 'expired')
  const restorableUntil = view.parts.map((part) => part.restorableUntil).find((until): until is string => !!until)
  const showBar = view.status === 'waiting' && waitingParts.length > 0 && !anyFiling && draft && summary
  const previewEntry = attachments.find((entry) => entry.part.id === preview)
  const outcome = filingOutcome(view)

  return (
    <article className="flex min-h-full flex-col" data-testid="inbound-mail-detail" data-mail-id={view.id}>
      <div className="flex flex-1 flex-col gap-6 p-4 sm:p-6">
        {back}
        {view.projectClosed && !closedNoticeHidden && (
          <Alert data-testid="detail-closed">
            <Lock aria-hidden className="text-warning" />
            <AlertTitle className="line-clamp-none">{t('closed.title')}</AlertTitle>
            <AlertDescription className="flex items-center justify-between gap-2">
              <span>{t('closed.text')}</span>
              <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t('closed.dismiss')} onClick={() => setClosedNoticeHidden(true)}>
                <X className="size-4" aria-hidden />
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {decidedByOther && (
          <Alert variant="info" data-testid="detail-decided-by-other">
            <Users aria-hidden />
            <AlertTitle className="line-clamp-none">{t('state.decidedByOther')}</AlertTitle>
          </Alert>
        )}
        {outcome.quota ? (
          <Alert variant="destructive" data-testid="detail-quota">
            <AlertTriangle aria-hidden />
            <AlertTitle className="line-clamp-none">{t('state.quotaFull')}</AlertTitle>
          </Alert>
        ) : (
          outcome.failed > 0 && (
            <Alert data-testid="detail-partial-failure">
              <AlertTriangle aria-hidden className="text-warning" />
              <AlertTitle className="line-clamp-none">{outcome.failed === outcome.total
                  ? t('state.partialFailureAll', { failed: outcome.failed })
                  : t('state.partialFailure', { failed: outcome.failed, total: outcome.total })}</AlertTitle>
              <AlertDescription>{t('state.partialFailureHint')}</AlertDescription>
            </Alert>
          )
        )}
        {anyFiling && (
          <FactLine icon={Loader2} tone="default" className="[&>svg]:motion-safe:animate-spin" testId="detail-filing">
            {t('state.filing')}
          </FactLine>
        )}
        {waitingParts.length === 0 && dismissedOrExpired.length > 0 && restorableUntil && (
          <div className="bg-muted/40 flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between" data-testid="detail-restorable">
            <p className="text-sm">
              {t(dismissedOrExpired.some((part) => part.state === 'expired') ? 'state.expired' : 'state.dismissed', {
                date: formatCalendarDate(restorableUntil, locale),
              })}
            </p>
            <BusyButton
              type="button"
              size="sm"
              variant="outline"
              busy={restoring}
              busyLabel={t('state.restoreBusy')}
              icon={<ArchiveRestore aria-hidden />}
              onClick={() => void restore()}
              data-testid="detail-restore"
            >
              {t('state.restore')}
            </BusyButton>
          </div>
        )}

        <MailHeader
          view={view}
          forwarded={forwardedOrigin(view.subject, text.kind === 'ready' ? text.text : null)}
          originalUrl={client.originalUrl(projectId, view.id)}
        />

        {messagePart?.state === 'waiting' && messagePart.contentFindings.length > 0 && draft?.message?.findingChoice && (
          <ContentFindingChoice
            findings={messagePart.contentFindings}
            value={draft.message.findingChoice}
            onChange={(choice) => setDraft((current) => (current ? chooseFinding(current, choice, view, folders, copy) : current))}
            disabled={filing}
          />
        )}

        <MailText state={text} onRetry={() => void loadText()} />

        {messagePart && draft?.message && (
          <section className="flex flex-col gap-2" aria-label={t('message.label')}>
            <ItemList className="bg-card">
              <MessageRow
                projectId={projectId}
                view={view}
                draft={draft.message}
                folders={folders}
                copy={copy}
                threadNameStopped={threadNameStopped}
                onChange={(change) => setDraft((current) => (current ? updateMessage(current, change) : current))}
              />
            </ItemList>
          </section>
        )}

        {(attachments.length > 0 || notStaged.listed.length > 0 || notStaged.layoutImages > 0) && draft && (
          <section className="flex flex-col gap-2" aria-label={t('attachments.label')}>
            <SectionLabel as="h3">{t('attachments.label')}</SectionLabel>
            {attachments.length > 0 && (
              <ItemList as="ul" className="bg-card">
                {attachments.map((entry) => {
                  const attachmentDraft = draft.attachments.find((candidate) => candidate.partId === entry.part.id)
                  if (!attachmentDraft) return null
                  return (
                    <AttachmentRow
                      key={entry.part.id}
                      projectId={projectId}
                      entry={entry}
                      draft={attachmentDraft}
                      folders={folders}
                      contentUrl={entry.previewable ? client.partContentUrl(projectId, view.id, entry.part.id) : null}
                      missingSuggestion={missing}
                      onChange={(change) => setDraft((current) => (current ? updateAttachment(current, entry.part.id, change) : current))}
                      onPreview={entry.previewable ? () => setPreview(entry.part.id) : undefined}
                    />
                  )
                })}
              </ItemList>
            )}
            {(notStaged.listed.length > 0 || notStaged.layoutImages > 0) && (
              <ul className="text-muted-foreground flex flex-col gap-1 px-1 text-xs" data-testid="not-staged">
                {notStaged.listed.map((entry, index) => (
                  <li key={`${entry.filename}-${index}`} className="[overflow-wrap:anywhere]">
                    {t(`attachments.notStaged.${entry.reason}`, { name: entry.filename })}
                  </li>
                ))}
                {notStaged.layoutImages > 0 && <li>{t('attachments.notStaged.layoutImages', { count: notStaged.layoutImages })}</li>}
              </ul>
            )}
          </section>
        )}

        {messagePart?.state === 'filed' && offerFollow && followTarget && (
          <FollowOffer
            key={followTarget.threadId}
            threadName={followTarget.name}
            following={followTarget.followed}
            onFollow={async () => {
              try {
                await client.follow(projectId, followTarget.threadId)
                toast.success(t('follow.following', { name: followTarget.name }), {
                  action: {
                    label: t('follow.undo'),
                    onClick: () => {
                      void client.unfollow(projectId, followTarget.threadId).then(() => setFollowTarget({ ...followTarget, followed: false }))
                    },
                  },
                })
              } catch (error) {
                toast.error(t('follow.failed'))
                throw error
              }
            }}
          />
        )}
      </div>

      {showBar && (
        <DecisionBar
          summary={summary}
          acknowledgeSender={draft.acknowledgeSender}
          onAcknowledgeSender={(value) => setDraft((current) => (current ? { ...current, acknowledgeSender: value } : current))}
          onFile={() => void file()}
          onDismiss={() => void dismiss()}
          filing={filing}
          dismissing={dismissing}
        />
      )}
      {previewEntry && (
        <AttachmentPreviewDialog
          open={preview !== null}
          onOpenChange={(open) => !open && setPreview(null)}
          name={previewEntry.part.filename ?? copy.unnamedAttachment(previewEntry.part.position)}
          contentType={previewEntry.part.contentType}
          url={previewEntry.previewable ? client.partContentUrl(projectId, view.id, previewEntry.part.id) : null}
        />
      )}
    </article>
  )
}

/** The detail's shape while it loads: the header, the text and three attachment rows. */
export function DetailSkeleton({ back }: { back?: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6" aria-busy="true" data-testid="inbound-mail-detail-loading">
      {back}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-3.5 w-1/3" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-9/12" />
      </div>
      <div className="flex flex-col divide-y rounded-lg border">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3 p-3">
            <Skeleton className="size-4" />
            <Skeleton className="size-10 rounded-md" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
