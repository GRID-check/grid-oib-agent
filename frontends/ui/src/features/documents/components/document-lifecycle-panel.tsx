'use client'

/**
 * Freigabe und Fassungen, in the document's own pane: the state, the controls
 * that state allows this reader, and the history under them.
 *
 * ## It owns the data, the controls do not
 *
 * Every request goes through the typed client (`lib/documents/lifecycle-client`,
 * ADR-0055) — there is no `fetch` in this feature. The panel holds the version
 * list, applies a gesture OPTIMISTICALLY, and puts the previous list back if the
 * server disagrees. Optimism is right here because the answer is nearly always
 * yes (the controls were filtered by the same transition table the route reads)
 * and because the alternative — a spinner over the pane between „Freigeben" and
 * the row moving — is half a second of the reader wondering whether the click
 * landed.
 *
 * ## The 409 is not an error message, it is a reload
 *
 * `compareAndSwapVersionState` answers 409 when the version left the state the
 * reader acted on: another reviewer got there first, or a second tab did. The
 * honest response is to say the stand has moved and show what it moved to, so
 * the panel re-reads the list rather than leaving a stale one on screen with a
 * red line under it.
 *
 * ## Shut by default, and it opens itself when it is your turn
 *
 * This section used to stand open at the top of the rail on every document:
 * a heading, a strip of review verbs, and the full version history, above the
 * summary and the facts. On the overwhelming majority of files that is noise —
 * a person's upload is born `published`, there is no decision left to take, and
 * the one control the strip could offer was the unexplained „Archivieren".
 *
 * So the panel is a disclosure, and at rest it says exactly two things: the
 * word for where the document stands, and the track that gives that word its
 * place ({@link DocumentLifecycleStand}). Versions, decisions and the archive
 * act are behind it.
 *
 * It opens ITSELF when {@link lifecycleNeedsReader} holds — something is
 * expected of this reader on this version — which is the only reading of "need
 * to know" that does not push the work of noticing onto the reader. Once they
 * close it, it stays closed: the effect fires on the ATTENTION edge, not on
 * every render, so the panel never fights the person using it.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  DocumentLifecycleError,
  documentLifecycleClient,
  type DocumentLifecycleClient,
} from '@/lib/documents/lifecycle-client'
import type {
  DocumentLifecycle,
  DocumentVersionListResponse,
  DocumentVersionView,
} from '@/lib/documents/lifecycle-types'
import type { DocumentAuthor } from '@/lib/db/schema'
import {
  canArchiveDocument,
  lifecycleNeedsReader,
  lifecycleRequestFor,
  type DocumentLifecycleAction,
  type DocumentLifecycleGesture,
  type DocumentLifecycleViewer,
} from '../lib/document-lifecycle'
import { DocumentArchiveAction } from './document-archive-action'
import { DocumentLifecycleStand } from './document-lifecycle-stand'
import { DocumentReviewControls, type ReviewerOption } from './document-review-controls'
import { DocumentVersionList } from './document-version-list'
import { DocumentVersionStateBadge } from './document-version-badge'

export interface DocumentLifecyclePanelProps {
  documentId: string
  /** The file's own name, so „archivieren?" can name what it is about. */
  filename?: string | null
  viewer: DocumentLifecycleViewer
  authoredBy?: DocumentAuthor | null
  /** Names the pane already knows (the document's assignees), by user id. */
  names?: Readonly<Record<string, string>>
  /** Injected by the dev preview and the specs; the browser gets the real one. */
  client?: DocumentLifecycleClient
  /**
   * Whether the history renders under the controls. On by default; off on the
   * report card, where the reader is looking AT the document and the useful
   * half is the decision, not the list of dates. The pane is where a version
   * list belongs.
   */
  showVersions?: boolean
  /**
   * The document's editorial state changed here — so the listing behind the
   * pane can update its badge without re-reading the whole corpus.
   */
  onChanged?: (summary: {
    documentId: string
    state: DocumentVersionView['state']
    versionCount: number
    lifecycle: DocumentLifecycle
  }) => void
  className?: string
}

/** The version the controls act on: the newest one. */
function newestVersion(versions: readonly DocumentVersionView[]): DocumentVersionView | null {
  return versions.reduce<DocumentVersionView | null>(
    (newest, version) =>
      newest === null || version.versionNumber > newest.versionNumber ? version : newest,
    null,
  )
}

/**
 * What a gesture does to the row while the request is in flight.
 *
 * The op's own transition row already says where it lands; this is that `to`
 * looked up by op, so the optimistic state cannot disagree with the state the
 * server will write. `archive` is item-level and moves no version.
 */
const OPTIMISTIC_STATE: Record<
  Exclude<DocumentLifecycleAction, 'archive'>,
  DocumentVersionView['state']
> = {
  submit: 'in_review',
  approve: 'approved',
  request_changes: 'changes_requested',
  reject: 'rejected',
  publish: 'published',
}

export function DocumentLifecyclePanel({
  documentId,
  filename,
  viewer,
  authoredBy,
  names,
  client = documentLifecycleClient,
  showVersions = true,
  onChanged,
  className,
}: DocumentLifecyclePanelProps): JSX.Element | null {
  const t = useTranslations('files')
  const [listing, setListing] = useState<DocumentVersionListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState<DocumentLifecycleGesture | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await client.listVersions(documentId)
      setListing(next)
      setFailed(false)
    } catch {
      // A pane that cannot read the history still shows the document. One quiet
      // line, and the rest of the rail is unaffected.
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [client, documentId])

  useEffect(() => {
    void load()
  }, [load])

  // Who this version may be sent to. One request per document, and a failure is
  // silent on purpose: without the list the picker is simply absent and the
  // submission goes to every editor, which is what it would have done anyway.
  const [reviewers, setReviewers] = useState<readonly ReviewerOption[]>([])
  useEffect(() => {
    let live = true
    void fetch(`/api/documents/${encodeURIComponent(documentId)}/versions/reviewers`)
      .then((response) => (response.ok ? response.json() : { candidates: [] }))
      .then((body: { candidates?: ReviewerOption[] }) => {
        if (live) setReviewers(body.candidates ?? [])
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [documentId])

  const announce = useCallback(
    (next: DocumentVersionListResponse) => {
      const newest = newestVersion(next.versions)
      if (!newest) return
      onChanged?.({
        documentId,
        state: newest.state,
        versionCount: next.versions.length,
        lifecycle: next.lifecycle,
      })
    },
    [documentId, onChanged],
  )

  const act = useCallback(
    async (
      gesture: DocumentLifecycleGesture,
      options: {
        comment?: string
        reviewerUserIds?: readonly string[]
        orderMessage?: string
        dueAt?: string
      } = {},
    ) => {
      const { comment, reviewerUserIds, orderMessage, dueAt } = options
      if (!listing) return
      const version = newestVersion(listing.versions)
      if (!version) return
      const previous = listing
      // „Piloti überarbeiten lassen" is the `request_changes` row with one more
      // field on the request (ADR-0054), so everything below — the optimistic
      // state, the re-read, the 409 — is the same code path as the button
      // beside it.
      const { action, delegateRevision } = lifecycleRequestFor(gesture)

      // Optimistic: the row moves now, and goes back if the server refuses.
      setListing(
        action === 'archive'
          ? { ...listing, lifecycle: 'archived' }
          : {
              ...listing,
              versions: listing.versions.map((row) =>
                row.id === version.id ? { ...row, state: OPTIMISTIC_STATE[action] } : row,
              ),
            },
      )
      setPending(gesture)

      try {
        if (action === 'archive') {
          await client.archive(documentId)
        } else {
          await runVersionOp(
            client,
            action,
            documentId,
            version.id,
            comment,
            delegateRevision,
            reviewerUserIds,
            orderMessage,
            dueAt,
            version.contentHash ?? undefined,
          )
        }
        // Re-read rather than patch: publish supersedes another version and
        // moves the item's pointer, and a client that reconstructed that from
        // one response would be keeping a second copy of the promotion rule.
        const next = await client.listVersions(documentId)
        setListing(next)
        announce(next)
      } catch (error) {
        setListing(previous)
        if (error instanceof DocumentLifecycleError && error.status === 409) {
          toast.error(t('lifecycle.errors.conflict'))
          await load()
        } else {
          toast.error(t('lifecycle.errors.actionFailed'))
        }
      } finally {
        setPending(null)
      }
    },
    [announce, client, documentId, listing, load, t],
  )

  // What the section says at rest, and whether it says more without being asked.
  const newest = listing ? newestVersion(listing.versions) : null
  const attention = listing ? lifecycleNeedsReader(newest, listing.lifecycle, viewer) : false

  const [open, setOpen] = useState(false)
  // Opens on the attention EDGE, once. Re-asserting `open` on every render
  // would make the disclosure un-closable while a decision is outstanding, and
  // a reader who has read the round and wants the rail back is entitled to it.
  const openedForAttention = useRef(false)
  useEffect(() => {
    if (!attention || openedForAttention.current) return
    openedForAttention.current = true
    setOpen(true)
  }, [attention])

  /**
   * A user id as a word: „Sie" for the reader, a resolved name where the pane
   * knows one (the document's assignees), „Jemand" otherwise — never the raw
   * id, which is an identifier leaking into copy.
   */
  const nameOf = useCallback(
    (userId: string | null): string => {
      if (!userId) return t('lifecycle.versions.someone')
      if (userId === viewer.userId) return t('lifecycle.versions.you')
      return names?.[userId] ?? t('lifecycle.versions.someone')
    },
    [names, t, viewer.userId],
  )

  if (loading && !listing) {
    return <Skeleton className={cn('h-16 w-full rounded-lg', className)} />
  }
  if (failed || !listing) {
    return (
      <p className={cn('text-muted-foreground text-xs', className)} data-testid="document-lifecycle-failed">
        {t('lifecycle.errors.loadFailed')}
      </p>
    )
  }

  const version = newest

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn('space-y-2', className)}
      data-testid="document-lifecycle-panel"
      data-attention={attention || undefined}
      asChild
    >
      <section>
        {/* The heading IS the trigger: a disclosure whose label is not the thing
            you press has a second target for the same job. The `h3` keeps the
            section addressable; the button inside it is what takes the click. */}
        <SectionLabel as="h3">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="touch-target duration-snap hover:text-foreground focus-visible:ring-ring flex w-full items-center gap-2 text-left transition-colors ease-out outline-none focus-visible:ring-2 focus-visible:ring-offset-1 motion-reduce:transition-none"
              data-testid="document-lifecycle-toggle"
            >
              <span className="min-w-0 truncate">{t('lifecycle.title')}</span>
              <span className="flex-1" />
              {/* The badge, on the pane's own terms: here the state IS the
                  subject, so it shows for every document — including the plain
                  upload whose card deliberately carries none. It stays on the
                  CLOSED row, because it is half of what the section says at
                  rest. */}
              <DocumentVersionStateBadge
                versionState={version?.state ?? null}
                versionCount={listing.versions.length}
                lifecycle={listing.lifecycle}
                authoredBy={authoredBy}
                always
                testId="document-lifecycle-state"
              />
              <ChevronDown
                aria-hidden
                className={cn(
                  'duration-quick size-3.5 shrink-0 transition-transform ease-out motion-reduce:transition-none',
                  open && 'rotate-180',
                )}
              />
            </button>
          </CollapsibleTrigger>
        </SectionLabel>

        {/* Outside the content, on purpose: the stand is what the section says
            when it is shut, and it is the reason somebody opens it. */}
        <DocumentLifecycleStand
          version={version}
          lifecycle={listing.lifecycle}
          nameOf={nameOf}
        />

        <CollapsibleContent className="space-y-3 pt-1">
          <DocumentReviewControls
            version={version}
            lifecycle={listing.lifecycle}
            viewer={viewer}
            pending={pending}
            onAct={(gesture, options) => void act(gesture, options)}
            reviewers={reviewers}
            // The signature line of the approve confirm: the viewer's own name
            // where the surface already knows one (its assignees), else the
            // control states the moment alone rather than a raw user id.
            actingName={viewer.userId ? (names?.[viewer.userId] ?? null) : null}
          />

          {showVersions && (
            <DocumentVersionList
              documentId={documentId}
              versions={listing.versions}
              publishedVersionId={listing.publishedVersionId}
              viewerUserId={viewer.userId}
              names={names}
              onCompare={(from, to) => client.diff(documentId, from, to)}
            />
          )}

          {/* Last, and set apart: the item-level one-way door. Never a sibling
              of the review verbs, and never fired without saying what it does. */}
          {canArchiveDocument(listing.lifecycle, viewer) && (
            <DocumentArchiveAction
              filename={filename}
              pending={pending === 'archive'}
              onArchive={() => void act('archive')}
            />
          )}
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

/**
 * One op, one client call.
 *
 * A `Record` over the op union rather than a `switch`, so an op added to the
 * review set has to be given a call here before this compiles — the same
 * discipline the effects registry uses one tier down.
 */
async function runVersionOp(
  client: DocumentLifecycleClient,
  action: Exclude<DocumentLifecycleAction, 'archive'>,
  documentId: string,
  versionId: string,
  comment?: string,
  delegateRevision = false,
  reviewerUserIds?: readonly string[],
  orderMessage?: string,
  dueAt?: string,
  // The bytes this pane was showing when the reviewer decided. A decision on a
  // version somebody has since replaced 409s instead of landing on the new one.
  ifMatch?: string,
): Promise<void> {
  const calls: Record<typeof action, () => Promise<DocumentVersionView>> = {
    // `undefined` when nobody was singled out, which is the picker's default:
    // the fallback chain (`lib/documents/reviewers.ts`) asks whoever is on the
    // hook and then every editor in the project. The order and Frist ride the
    // same call into the round's inbox payload.
    submit: () => client.submit(documentId, versionId, reviewerUserIds, { orderMessage, dueAt }),
    approve: () => client.approve(documentId, versionId, comment, ifMatch),
    // The flag is PASSED only when it is true, the same decision the client
    // makes one tier down about the wire: „Änderungen anfordern" is the call it
    // always was, and the third control is the only caller that adds anything.
    request_changes: () =>
      delegateRevision
        ? client.requestChanges(documentId, versionId, comment ?? '', true, ifMatch)
        : client.requestChanges(documentId, versionId, comment ?? '', undefined, ifMatch),
    reject: () => client.reject(documentId, versionId, comment ?? '', ifMatch),
    publish: () => client.publish(documentId, versionId),
  }
  await calls[action]()
}
