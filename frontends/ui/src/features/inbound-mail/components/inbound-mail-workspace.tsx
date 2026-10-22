'use client'

/**
 * Dateien › E-Mail-Eingang (ADR-0134, DECISION §9): the list of held mail read
 * against the open mail, a split with no overlay (the „second pane“ case of
 * the design language's overlay table).
 *
 * LAYOUT BY CONTAINER, NOT BY VIEWPORT. The list is 22rem and the detail the
 * rest while this component's own box is wider than 48rem (`@3xl`); below
 * that it is list → detail, the detail a page of its own with the way back at
 * its top. The URL carries the open mail (`/files/mail/<id>`, pushed, so Back
 * closes it) and the filter (`?status=handled&outcome=…`, replaced: a filter
 * is not a place).
 *
 * THE KEYBOARD (group `inboundMail` in `components/shell/shortcuts.ts`):
 * J/K walk the rows, Enter opens the row, X selects it, Space previews the
 * open mail's first attachment, E files the open mail as the bar shows it,
 * ⌫ dismisses (the selection, or else the open mail). Each key goes through
 * the same control a pointer would press, so busy and confirm states hold.
 * None of them fires while a field has the focus or a dialog is open.
 *
 * BULK. A selection files „wie vorgeschlagen“ only when every selected mail
 * is complete (`incompleteReason`); the selected mails are read to decide
 * that, at most twenty, the most one request may decide. The request carries
 * no acknowledgement (RT-S5), and its confirmation lists where everything goes.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, AtSign, FolderOpen, Lock, MailSearch, X } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ProjectSectionActions } from '@/components/shell/project-section-frame'
import { useTranslations } from '@/i18n'
import {
  INBOUND_MAIL_DECISION_MAX_MAILS,
  INBOUND_MAIL_LIST_LIMIT,
  type InboundMailListStatus,
  type InboundMailListView,
  type InboundMailOutcome,
  type InboundMailTextView,
  type InboundMailView,
} from '@/lib/inbound-mail/inbound-mail-wire'
import { cn } from '@/lib/utils'
import { inboundMailAddressClient, inboundMailClient, type InboundMailAddressClient, type InboundMailClient } from '../lib/client'
import { bulkPlan, incompleteReason, type BulkPlan, type IncompleteReason } from '../lib/completeness'
import { decisionOf, initialDraft, type DraftCopy, type FolderOption } from '../lib/draft'
import { listSections, visibleMails } from '../lib/list-sections'
import { inboundMailPaths, type InboundMailPaths } from '../lib/paths'
import { refusalOf } from '../lib/refusal'
import { primeInboundMailWaiting, refreshInboundMailWaiting, useInboundMailWaiting } from '../hooks/use-inbound-mail-waiting'
import { InboundMailAddressBlock, InboundMailAddressDialog } from './inbound-mail-address'
import { InboundMailDetail, type DetailActions } from './inbound-mail-detail'
import { InboundMailList, type ListState } from './inbound-mail-list'
import { SelectionBar, type BulkBlock } from './selection-bar'

export interface InboundMailWorkspaceProps {
  projectId: string
  projectName: string
  projectClosed: boolean
  folders: readonly FolderOption[]
  status: InboundMailListStatus
  outcome: InboundMailOutcome | null
  /** The first page as the server read it; null reads it here (or says it failed). */
  initialList: InboundMailListView | null
  /** The open mail, or null for the list alone. */
  mailId: string | null
  initialMail: InboundMailView | null
  initialText?: InboundMailTextView | null
  client?: InboundMailClient
  addressClient?: InboundMailAddressClient
  paths?: InboundMailPaths
  /** The list failed on the server: show its error instead of reading again. */
  initialListFailed?: boolean
  /** Previews pin these. */
  now?: number
  decidedByOther?: boolean
  /** Keep the list empty-and-loading (a preview of the skeleton). */
  listLoading?: boolean
  /** Mails checked on arrival (a preview of the selection). */
  initialChecked?: readonly string[]
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function InboundMailWorkspace({
  projectId,
  projectName,
  projectClosed,
  folders,
  status,
  outcome,
  initialList,
  mailId,
  initialMail,
  initialText,
  client = inboundMailClient,
  addressClient = inboundMailAddressClient,
  paths: pathsProp,
  initialListFailed = false,
  now,
  decidedByOther,
  listLoading = false,
  initialChecked,
}: InboundMailWorkspaceProps): JSX.Element {
  const t = useTranslations('inboundMail')
  const router = useRouter()
  const paths = useMemo(() => pathsProp ?? inboundMailPaths(projectId), [pathsProp, projectId])
  const filter = useMemo(() => ({ status, outcome }), [status, outcome])
  const [list, setList] = useState<ListState>(
    listLoading ? { kind: 'loading' } : initialList ? { kind: 'ready', ...initialList } : initialListFailed ? { kind: 'error' } : { kind: 'loading' }
  )
  const [loadingMore, setLoadingMore] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(() => new Set(initialChecked))
  const [focusedId, setFocusedId] = useState<string | null>(mailId)
  const [quietOpen, setQuietOpen] = useState(false)
  const [closedNoticeHidden, setClosedNoticeHidden] = useState(false)
  const [addressOpen, setAddressOpen] = useState(false)
  const [everReceived, setEverReceived] = useState<boolean | null>(null)
  const [address, setAddress] = useState<Awaited<ReturnType<InboundMailAddressClient['get']>> | null>(null)
  const detailActions = useRef<DetailActions | null>(null)
  const waiting = useInboundMailWaiting(projectId, true, client)

  const copy: DraftCopy = useMemo(
    () => ({ unnamedAttachment: (position) => t('attachments.unnamed', { position }), untitledThread: t('row.noSubject') }),
    [t]
  )

  // The page's first page of the waiting list is also the count every surface shows.
  useEffect(() => {
    if (initialList && status === 'waiting') {
      primeInboundMailWaiting(projectId, { count: initialList.items.filter((mail) => mail.status === 'waiting').length, more: initialList.nextCursor !== null })
    }
  }, [initialList, projectId, status])

  const reload = useCallback(async () => {
    try {
      const page = await client.list(projectId, { status, outcome: outcome ?? undefined, limit: INBOUND_MAIL_LIST_LIMIT })
      setList({ kind: 'ready', ...page })
    } catch {
      setList((current) => (current.kind === 'ready' ? current : { kind: 'error' }))
    }
  }, [client, projectId, status, outcome])

  // A filter change (or no first page from the server) reads the list here.
  const firstFilter = useRef(`${status}:${outcome ?? ''}`)
  useEffect(() => {
    if (listLoading) return
    const key = `${status}:${outcome ?? ''}`
    if (key === firstFilter.current && (initialList || initialListFailed)) return
    firstFilter.current = ''
    setList({ kind: 'loading' })
    void reload()
  }, [status, outcome, reload, initialList, initialListFailed, listLoading])

  const changed = useCallback(() => {
    void reload()
    void refreshInboundMailWaiting(projectId, client)
  }, [reload, projectId, client])

  const items = useMemo(() => (list.kind === 'ready' ? list.items : []), [list])
  const sections = useMemo(() => listSections(items, { grouped: status === 'waiting' }), [items, status])
  const rows = useMemo(() => visibleMails(sections, quietOpen), [sections, quietOpen])

  // An empty waiting list is „never used“ or „all done“: the address says which, and is shown in the first.
  const empty = list.kind === 'ready' && list.items.length === 0 && status === 'waiting'
  useEffect(() => {
    if (!empty || everReceived !== null) return
    addressClient
      .get(projectId)
      .then((view) => {
        setAddress(view)
        setEverReceived(view.lastReceivedAt !== null)
      })
      .catch(() => setEverReceived(true))
  }, [empty, everReceived, addressClient, projectId])

  // ------------------------------------------------------------ selection and bulk

  const selectedIds = useMemo(() => items.filter((mail) => checked.has(mail.id)).map((mail) => mail.id), [items, checked])
  const [views, setViews] = useState<Map<string, InboundMailView>>(new Map())
  const [checking, setChecking] = useState(false)
  const [bulkFiling, setBulkFiling] = useState<string | null>(null)
  const [bulkDismissing, setBulkDismissing] = useState(false)
  const [confirmFile, setConfirmFile] = useState<{ ids: string[]; plan: BulkPlan } | null>(null)
  const [confirmDismiss, setConfirmDismiss] = useState(false)

  /** Read the mails a bulk action needs (at most twenty), keeping what is already read and current. */
  const readViews = useCallback(
    async (ids: string[]): Promise<Map<string, InboundMailView>> => {
      const updatedAt = new Map(items.map((mail) => [mail.id, mail.updatedAt]))
      const stale = ids.filter((id) => views.get(id)?.updatedAt !== updatedAt.get(id))
      if (stale.length === 0) return views
      const read = await Promise.all(stale.map((id) => client.get(projectId, id).catch(() => null)))
      const next = new Map(views)
      for (const view of read) if (view) next.set(view.id, view)
      setViews(next)
      return next
    },
    [items, views, client, projectId]
  )

  useEffect(() => {
    if (selectedIds.length === 0 || selectedIds.length > INBOUND_MAIL_DECISION_MAX_MAILS) return
    let cancelled = false
    setChecking(true)
    void readViews(selectedIds).finally(() => !cancelled && setChecking(false))
    return () => {
      cancelled = true
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- read when the selection changes, not when the cache does
  }, [selectedIds.join(',')])

  const blockFor = useCallback(
    (ids: string[], read: Map<string, InboundMailView>): BulkBlock => {
      if (ids.length > INBOUND_MAIL_DECISION_MAX_MAILS) return { reason: 'too_many', count: ids.length }
      const reasons = new Map<IncompleteReason, number>()
      for (const id of ids) {
        const view = read.get(id)
        const reason = view ? incompleteReason(view, folders, copy) : 'not_waiting'
        if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
      }
      const first = [...reasons.entries()][0]
      return first ? { reason: first[0], count: first[1] } : null
    },
    [folders, copy]
  )

  const selectionBlock = checking ? null : blockFor(selectedIds, views)

  const askFile = async (ids: string[], groupId: string | null): Promise<void> => {
    if (groupId) setBulkFiling(groupId)
    const read = await readViews(ids)
    if (groupId) setBulkFiling(null)
    const block = blockFor(ids, read)
    if (block) {
      // A group that cannot go in one press is opened at its first mail.
      if (groupId) router.push(paths.mail(ids[0], filter))
      else toast.error(t(`bulk.blocked.${block.reason}`, { count: block.count, max: INBOUND_MAIL_DECISION_MAX_MAILS }))
      return
    }
    const entries = ids.map((id) => {
      const view = read.get(id) as InboundMailView
      return { view, draft: initialDraft(view, folders, copy) }
    })
    setConfirmFile({ ids, plan: bulkPlan(entries) })
  }

  const fileConfirmed = async (): Promise<void> => {
    if (!confirmFile) return
    setBulkFiling('selection')
    try {
      const mails = confirmFile.ids.map((id) => {
        const view = views.get(id) as InboundMailView
        return decisionOf(view, initialDraft(view, folders, copy), { bulk: true })
      })
      await client.file(projectId, { mails })
      toast.success(t('toast.bulkFiled', { count: mails.length }))
      setChecked(new Set())
      changed()
    } catch (error) {
      toast.error(t(`refusals.${refusalOf(error)}`))
      changed()
      throw error
    } finally {
      setBulkFiling(null)
    }
  }

  const dismissConfirmed = async (): Promise<void> => {
    setBulkDismissing(true)
    try {
      await client.dismiss(projectId, { mailIds: selectedIds })
      toast.success(t('toast.dismissedMany', { count: selectedIds.length }))
      setChecked(new Set())
      changed()
    } catch (error) {
      toast.error(t(`refusals.${refusalOf(error)}`))
      throw error
    } finally {
      setBulkDismissing(false)
    }
  }

  const toggle = (id: string, value: boolean): void =>
    setChecked((current) => {
      const next = new Set(current)
      if (value) next.add(id)
      else next.delete(id)
      return next
    })

  // ------------------------------------------------------------ keyboard

  const keyState = useRef({ rows, focusedId, mailId, selectedIds })
  keyState.current = { rows, focusedId, mailId, selectedIds }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      const { rows: visible, focusedId: focus, mailId: open, selectedIds: selected } = keyState.current
      const index = visible.findIndex((mail) => mail.id === (focus ?? open))
      const key = event.key
      if (key === 'j' || key === 'k') {
        event.preventDefault()
        if (visible.length === 0) return
        const next = index < 0 ? (key === 'j' ? 0 : visible.length - 1) : Math.min(visible.length - 1, Math.max(0, index + (key === 'j' ? 1 : -1)))
        setFocusedId(visible[next].id)
        document.querySelector(`[data-mail-id="${CSS.escape(visible[next].id)}"]`)?.scrollIntoView({ block: 'nearest' })
        return
      }
      if (key === 'Enter') {
        if (event.target instanceof HTMLElement && event.target.closest('button, a, [role="radio"], [role="checkbox"]')) return
        const target = index >= 0 ? visible[index] : null
        if (!target) return
        event.preventDefault()
        router.push(paths.mail(target.id, filter))
        return
      }
      if (key === 'x') {
        const target = index >= 0 ? visible[index] : null
        if (!target) return
        event.preventDefault()
        toggle(target.id, !checked.has(target.id))
        return
      }
      if (key === ' ' && open) {
        if (event.target instanceof HTMLElement && event.target.closest('button, a, [role="radio"], [role="checkbox"]')) return
        event.preventDefault()
        detailActions.current?.preview()
        return
      }
      if (key === 'e' && open) {
        event.preventDefault()
        detailActions.current?.file()
        return
      }
      if (key === 'Backspace' || key === 'Delete') {
        event.preventDefault()
        if (selected.length > 0) setConfirmDismiss(true)
        else if (open) detailActions.current?.dismiss()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [router, paths, filter, checked])

  // ------------------------------------------------------------ render

  const notice =
    projectClosed && !closedNoticeHidden ? (
      <Alert className="rounded-none border-x-0 border-t-0" data-testid="inbound-mail-closed">
        <Lock aria-hidden className="text-warning" />
        <AlertTitle className="line-clamp-none">{t('closed.title')}</AlertTitle>
        <AlertDescription className="flex items-center justify-between gap-2">
          <span>{t('closed.text')}</span>
          <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t('closed.dismiss')} onClick={() => setClosedNoticeHidden(true)}>
            <X className="size-4" aria-hidden />
          </Button>
        </AlertDescription>
      </Alert>
    ) : null

  const selectionBar =
    selectedIds.length > 0 ? (
      <SelectionBar
        count={selectedIds.length}
        checking={checking}
        block={selectedIds.length > INBOUND_MAIL_DECISION_MAX_MAILS ? { reason: 'too_many', count: selectedIds.length } : selectionBlock}
        max={INBOUND_MAIL_DECISION_MAX_MAILS}
        filing={bulkFiling === 'selection'}
        dismissing={bulkDismissing}
        onFile={() => void askFile(selectedIds, null)}
        onDismiss={() => setConfirmDismiss(true)}
        onClear={() => setChecked(new Set())}
      />
    ) : null

  const back = (
    <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit @3xl:hidden">
      <Link href={paths.list(filter)} data-testid="inbound-mail-back">
        <ArrowLeft className="size-4" aria-hidden />
        {t('title')}
      </Link>
    </Button>
  )

  return (
    <div className="@container flex h-full min-h-0 flex-col" data-testid="inbound-mail-workspace">
      <ProjectSectionActions>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={paths.files} data-testid="inbound-mail-files">
              <FolderOpen className="size-4" aria-hidden />
              {t('back')}
            </Link>
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setAddressOpen(true)} data-testid="inbound-mail-address-open">
            <AtSign className="size-4" aria-hidden />
            {t('addressButton')}
          </Button>
        </div>
      </ProjectSectionActions>
      <div className="flex min-h-0 flex-1 flex-col @3xl:grid @3xl:grid-cols-[22rem_minmax(0,1fr)]">
        <div className={cn('min-h-0 flex-1 flex-col @3xl:flex @3xl:border-r', mailId ? 'hidden' : 'flex')}>
          <div className="flex items-baseline justify-between gap-2 px-3 pt-3 sm:px-4">
            <h2 className="text-sm font-semibold">{t('title')}</h2>
          </div>
          <InboundMailList
            state={list}
            sections={sections}
            status={status}
            outcome={outcome}
            onFilterChange={(nextStatus, nextOutcome) => {
              setChecked(new Set())
              router.replace(paths.list({ status: nextStatus, outcome: nextOutcome }))
            }}
            waitingCount={waiting.count}
            openId={mailId}
            focusedId={focusedId}
            checked={checked}
            onCheckedChange={toggle}
            onFocusRow={setFocusedId}
            hrefFor={(id) => paths.mail(id, filter)}
            quietOpen={quietOpen}
            onQuietOpenChange={setQuietOpen}
            onFileGroup={(threadId, ids) => void askFile(ids, threadId)}
            fileGroupBusy={bulkFiling}
            onRetry={() => reload()}
            onLoadMore={async () => {
              if (list.kind !== 'ready' || !list.nextCursor) return
              setLoadingMore(true)
              try {
                const page = await client.list(projectId, { status, outcome: outcome ?? undefined, cursor: list.nextCursor })
                setList({ kind: 'ready', items: [...list.items, ...page.items], nextCursor: page.nextCursor })
              } catch {
                toast.error(t('loadError'))
              } finally {
                setLoadingMore(false)
              }
            }}
            loadingMore={loadingMore}
            everReceived={everReceived}
            addressBlock={address ? <InboundMailAddressBlock address={address} projectName={projectName} showRules={false} /> : null}
            selectionBar={selectionBar}
            notice={notice}
          />
        </div>
        <div className={cn('min-h-0 flex-1 @3xl:block', mailId ? 'block overflow-y-auto overscroll-contain' : 'hidden')} data-testid="inbound-mail-detail-pane">
          {mailId ? (
            <InboundMailDetail
              key={mailId}
              projectId={projectId}
              mailId={mailId}
              initial={initialMail}
              initialText={initialText}
              folders={folders}
              client={client}
              onChanged={changed}
              back={back}
              actionsRef={detailActions}
              now={now}
              decidedByOther={decidedByOther}
            />
          ) : (
            <div className="p-6">
              <EmptyState icon={MailSearch} title={t('noSelection')} />
            </div>
          )}
        </div>
      </div>

      <InboundMailAddressDialog projectId={projectId} projectName={projectName} open={addressOpen} onOpenChange={setAddressOpen} client={addressClient} />
      <ConfirmDialog
        open={confirmFile !== null}
        onOpenChange={(open) => !open && setConfirmFile(null)}
        title={confirmFile ? t('bulk.confirmTitle', { count: confirmFile.plan.mails }) : ''}
        description={
          confirmFile ? (
            <div className="flex flex-col gap-2">
              <p>{t('bulk.confirmSummary', { files: confirmFile.plan.files, texts: confirmFile.plan.texts })}</p>
              <ul className="flex flex-col gap-1" data-testid="bulk-destinations">
                {confirmFile.plan.destinations.map((destination) => (
                  <li key={`${destination.kind}:${destination.label}`} className="[overflow-wrap:anywhere]">
                    {destination.kind === 'folder' && destination.label === ''
                      ? t('bulk.destination.root', { count: destination.count })
                      : t(`bulk.destination.${destination.kind}`, { label: destination.label, count: destination.count })}
                  </li>
                ))}
              </ul>
            </div>
          ) : undefined
        }
        confirmLabel={t('bulk.confirm')}
        cancelLabel={t('bulk.cancel')}
        onConfirm={fileConfirmed}
        confirmTestId="bulk-file-confirm"
      />
      <ConfirmDialog
        open={confirmDismiss}
        onOpenChange={setConfirmDismiss}
        title={t('bulk.dismissTitle', { count: selectedIds.length })}
        description={t('bulk.dismissText')}
        confirmLabel={t('bulk.dismissConfirm')}
        cancelLabel={t('bulk.cancel')}
        tone="warning"
        onConfirm={dismissConfirmed}
        confirmTestId="bulk-dismiss-confirm"
      />
    </div>
  )
}
