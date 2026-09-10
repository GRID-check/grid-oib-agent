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
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
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
  type DocumentLifecycleAction,
  type DocumentLifecycleViewer,
} from '../lib/document-lifecycle'
import { DocumentReviewControls } from './document-review-controls'
import { DocumentVersionList } from './document-version-list'
import { DocumentVersionStateBadge } from './document-version-badge'

export interface DocumentLifecyclePanelProps {
  documentId: string
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
  const [pending, setPending] = useState<DocumentLifecycleAction | null>(null)

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
    async (action: DocumentLifecycleAction, comment?: string) => {
      if (!listing) return
      const version = newestVersion(listing.versions)
      if (!version) return
      const previous = listing

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
      setPending(action)

      try {
        if (action === 'archive') {
          await client.archive(documentId)
        } else {
          await runVersionOp(client, action, documentId, version.id, comment)
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

  const version = newestVersion(listing.versions)

  return (
    <section className={cn('space-y-3', className)} data-testid="document-lifecycle-panel">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <SectionLabel as="h3">{t('lifecycle.title')}</SectionLabel>
        {/* The badge, on the pane's own terms: here the state IS the subject, so
            it shows for every document — including the plain upload whose card
            deliberately carries none. */}
        <DocumentVersionStateBadge
          versionState={version?.state ?? null}
          versionCount={listing.versions.length}
          lifecycle={listing.lifecycle}
          authoredBy={authoredBy}
          always
          testId="document-lifecycle-state"
        />
      </div>

      <DocumentReviewControls
        version={version}
        lifecycle={listing.lifecycle}
        viewer={viewer}
        pending={pending}
        onAct={(action, comment) => void act(action, comment)}
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
    </section>
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
): Promise<void> {
  const calls: Record<typeof action, () => Promise<DocumentVersionView>> = {
    submit: () => client.submit(documentId, versionId),
    approve: () => client.approve(documentId, versionId, comment),
    request_changes: () => client.requestChanges(documentId, versionId, comment ?? ''),
    reject: () => client.reject(documentId, versionId, comment ?? ''),
    publish: () => client.publish(documentId, versionId),
  }
  await calls[action]()
}
