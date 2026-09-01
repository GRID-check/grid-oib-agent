'use client'

/**
 * Platform base-knowledge manager (ADR-0016, Phase C) — the base-corpus manager
 * for a NON-TECHNICAL owner, rebuilt on the shared admin primitives
 * (SectionCard + DataToolbar + Table + Sheet + Pagination).
 *
 * The previous shape put four controls — a 13.5rem Dokumentart dropdown, a
 * pencil, an eye and a trash icon — on every single row, and rendered every row
 * it had under an always-open dropzone. That is unreadable at a few hundred
 * documents and unusable at a thousand. So: the corpus is a table you can
 * search, filter, sort, select and page through; a row's four controls moved
 * into a detail Sheet; the same edits apply to a whole selection at once; and
 * upload is a primary action that reveals the dropzone rather than occupying
 * the top of the page permanently.
 *
 * What did NOT change is the ingest contract: the backend ingests uploads in
 * the background, so an upload returns promptly (`pending`); we then poll the
 * corpus status until the new file(s) reach a terminal lifecycle, so they
 * appear and progress from pending → indexed with no page reload.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { JSX } from 'react'
import { toast } from 'sonner'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  BookOpenCheck,
  ChevronsUpDown,
  Eye,
  FileText,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DataToolbar } from '@/components/ui/data-toolbar'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { StatCard } from '@/components/ui/stat-card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SectionCard } from '@/features/platform/components/section-card'
import { cn } from '@/lib/utils'
import { useLocale, useTranslations } from '@/i18n'
import type { KnowledgeBaseStatus, KnowledgeFile, KnowledgeFileState } from '@/lib/knowledge/service'
import type { KnowledgeUploadResult } from '@/lib/knowledge/service'
import {
  DOC_CLASSES,
  DOC_CLASS_LABELS,
  docClassAuthority,
  docClassSignal,
  isOibBinding,
  resolveDocClass,
  type DocClass,
} from '@/lib/knowledge/doc-class'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'
import { formatBytes } from '@/lib/format'

const STATE_VARIANT: Record<KnowledgeFileState, 'success' | 'info' | 'warning' | 'destructive' | 'secondary'> = {
  ingested: 'success',
  snapshot: 'success',
  pending: 'info',
  stale: 'warning',
  removed: 'secondary',
  inconsistent: 'destructive',
}

/** Sorting a status column alphabetically is useless; sort it by urgency. */
const STATE_ORDER: KnowledgeFileState[] = ['inconsistent', 'stale', 'pending', 'ingested', 'snapshot', 'removed']

// Poll cadence + ceiling while a freshly-uploaded document ingests in the
// background. 3.5s × 60 ≈ 3.5 minutes, then we stop and let the owner refresh.
const POLL_INTERVAL_MS = 3_500
const MAX_POLLS = 60

const PAGE_SIZE = 10

type SortKey = 'document' | 'class' | 'state' | 'chunks'
type SortDir = 'asc' | 'desc'
type Scope = 'all' | 'binding' | 'other'

const ALL = 'all'

/** A watched file is still working while it is missing or explicitly pending. */
function isWorking(status: KnowledgeBaseStatus | null, names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false
  const byName = new Map((status?.files ?? []).map((f) => [f.fileName, f]))
  for (const name of names) {
    const file = byName.get(name)
    if (!file || file.state === 'pending') return true
  }
  return false
}

export function BaseKnowledge() {
  const t = useTranslations('platform')
  const tk = useTranslations('knowledge')
  const { locale } = useLocale()

  const [status, setStatus] = useState<KnowledgeBaseStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)

  const [query, setQuery] = useState('')
  const [classFilter, setClassFilter] = useState<DocClass | typeof ALL>(ALL)
  const [scope, setScope] = useState<Scope>(ALL)
  const [sortKey, setSortKey] = useState<SortKey>('class')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [isReingesting, setIsReingesting] = useState(false)

  // The dropzone is opt-in now: an always-open 8-row target is the loudest
  // thing on a page whose actual job is reviewing what is already in the corpus.
  const [uploadOpen, setUploadOpen] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  // Names of the just-uploaded document(s) we are tracking to terminal state.
  // Reactive (unlike watchRef) so the progress bar + per-file list re-render as
  // each one finishes indexing.
  const [watched, setWatched] = useState<string[]>([])
  // Set when polling hits its ceiling with documents still indexing, so the
  // progress affordance is replaced by a persistent, actionable notice rather
  // than vanishing silently.
  const [pollTimedOut, setPollTimedOut] = useState(false)
  const [lastUpload, setLastUpload] = useState<KnowledgeUploadResult | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isDragActive, setIsDragActive] = useState(false)

  // Optimistic doc_class edits, applied over the fetched status until a refetch
  // confirms them (keyed by filename).
  const [docClassOverrides, setDocClassOverrides] = useState<Record<string, DocClass>>({})
  // Optimistic display-title (rename) edits.
  const [displayTitleOverrides, setDisplayTitleOverrides] = useState<Record<string, string>>({})

  // Detail sheet: we hold the NAME, not the row, so an optimistic edit or a
  // refetch is reflected in the open sheet instead of freezing a stale copy.
  const [detailName, setDetailName] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')

  const [pendingDelete, setPendingDelete] = useState<string[]>([])
  const [isDeleting, setIsDeleting] = useState(false)
  const [viewerFile, setViewerFile] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const watchRef = useRef<Set<string>>(new Set())

  const fetchStatus = useCallback(async (): Promise<KnowledgeBaseStatus> => {
    const res = await fetch('/api/knowledge-base')
    if (!res.ok) throw new Error(`Failed to load knowledge base (${res.status})`)
    return (await res.json()) as KnowledgeBaseStatus
  }, [])

  const load = useCallback(() => {
    setIsLoading(true)
    setHasError(false)
    return fetchStatus()
      .then((next) => {
        setStatus(next)
        // Drop any optimistic override the backend now agrees with.
        setDocClassOverrides((prev) => {
          if (Object.keys(prev).length === 0) return prev
          const remaining: Record<string, DocClass> = {}
          const byName = new Map(next.files.map((f) => [f.fileName, f]))
          for (const [name, cls] of Object.entries(prev)) {
            if (byName.get(name)?.docClass !== cls) remaining[name] = cls
          }
          return remaining
        })
      })
      .catch(() => {
        setStatus(null)
        setHasError(true)
      })
      .finally(() => setIsLoading(false))
  }, [fetchStatus])

  useEffect(() => {
    void load()
  }, [load])

  // Tear down any in-flight poll timer on unmount.
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    }
  }, [])

  // Poll the corpus status until the watched uploads reach a terminal state.
  const startPolling = useCallback(
    (names: string[]) => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
      watchRef.current = new Set(names)
      setWatched(names)
      setPollTimedOut(false)
      if (watchRef.current.size === 0) return

      let polls = 0
      const tick = async () => {
        polls += 1
        let next: KnowledgeBaseStatus | null = null
        try {
          next = await fetchStatus()
          setStatus(next)
        } catch {
          // Transient fetch failure — keep trying until the poll ceiling.
        }
        const stillWorking = isWorking(next, watchRef.current)
        if (!stillWorking || polls >= MAX_POLLS) {
          watchRef.current = new Set()
          pollTimerRef.current = null
          if (stillWorking) {
            // Hit the ceiling while documents are still indexing. Keep the
            // watched set so the progress affordance is swapped for a persistent
            // notice (below) instead of silently disappearing.
            setPollTimedOut(true)
          } else {
            setWatched([])
          }
          return
        }
        pollTimerRef.current = setTimeout(() => void tick(), POLL_INTERVAL_MS)
      }
      pollTimerRef.current = setTimeout(() => void tick(), POLL_INTERVAL_MS)
    },
    [fetchStatus],
  )

  // Live per-file progress for the documents currently being indexed, derived
  // from the polled status. A watched file counts as done once it appears with
  // any non-pending state; missing/pending files are still working.
  const uploadProgress = useMemo(() => {
    if (watched.length === 0) return null
    const byName = new Map((status?.files ?? []).map((f) => [f.fileName, f]))
    let done = 0
    const items = watched.map((name) => {
      const file = byName.get(name)
      const finished = !!file && file.state !== 'pending'
      if (finished) done += 1
      return { name, finished }
    })
    return { done, total: watched.length, items, pct: Math.round((done / watched.length) * 100) }
  }, [watched, status])

  const handleUpload = useCallback(
    (file: File) => {
      setIsUploading(true)
      setLastUpload(null)
      const form = new FormData()
      form.append('file', file)
      fetch('/api/platform/knowledge/documents', { method: 'POST', body: form })
        .then(async (r) => {
          const body = (await r.json().catch(() => ({}))) as Partial<KnowledgeUploadResult> & { error?: string }
          if (!r.ok || (body.status !== 'pending' && body.status !== 'success')) {
            toast.error(body.error ?? t('knowledge.uploadFailed', { name: file.name }))
            return
          }
          setLastUpload(body as KnowledgeUploadResult)
          if (body.kind === 'zip') {
            toast.success(
              t('knowledge.zipQueued', { accepted: body.accepted ?? 0, rejected: body.rejected ?? 0 }),
            )
          } else {
            toast.success(t('knowledge.uploadPending', { name: body.fileName ?? file.name }))
          }
          // Watch the accepted member(s) and poll until they finish indexing.
          const names =
            body.kind === 'zip'
              ? (body.members ?? []).filter((m) => m.status === 'pending').map((m) => m.fileName)
              : body.fileName
                ? [body.fileName]
                : []
          await load()
          startPolling(names)
        })
        .catch(() => toast.error(t('knowledge.uploadFailed', { name: file.name })))
        .finally(() => setIsUploading(false))
    },
    [load, startPolling, t],
  )

  const handleSync = useCallback(() => {
    setIsSyncing(true)
    fetch('/api/platform/knowledge/sync', { method: 'POST' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Sync failed (${r.status})`)
        const body = await r.json()
        toast.success(t('knowledge.syncDone', { added: body.filesAdded ?? 0, total: body.filesTotal ?? 0 }))
      })
      .catch(() => toast.error(t('knowledge.syncFailed')))
      .finally(() => {
        setIsSyncing(false)
        void load()
      })
  }, [load, t])

  /**
   * Rebuild the chunks of the selected documents.
   *
   * Distinct from Sync, which is incremental and gates on each PDF's sha256 — it does
   * nothing for a document whose file has not changed. This forces the rebuild, which is
   * what is needed after a change to how chunks are BUILT rather than to what they are
   * built from: a chunking change, a new embedding model, a half-failed ingest.
   *
   * The backend queues and returns immediately; each document then reads `pending` until
   * its chunks exist again, which is exactly what `startPolling` already watches for.
   */
  const handleReingest = useCallback(() => {
    const names = [...selected]
    if (names.length === 0) return
    setIsReingesting(true)
    fetch('/api/platform/knowledge/reingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileNames: names }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Re-ingest failed (${r.status})`)
        const body = await r.json()
        const queued: string[] = Array.isArray(body.queued) ? body.queued : []
        if (queued.length === 0) {
          toast.error(t('knowledgeAdmin.bulkReingestNothing'))
          return
        }
        toast.success(t('knowledgeAdmin.bulkReingestDone', { count: queued.length }))
        setSelected([])
        startPolling(queued)
      })
      .catch(() => toast.error(t('knowledgeAdmin.bulkReingestFailed')))
      .finally(() => {
        setIsReingesting(false)
        void load()
      })
  }, [load, selected, startPolling, t])

  /**
   * PATCH one document's Dokumentart, optimistically. Shared by the detail
   * sheet and the bulk action so both get identical revert-on-failure
   * behaviour; the caller decides what to toast.
   */
  const patchDocClass = useCallback(async (fileName: string, nextClass: DocClass): Promise<boolean> => {
    setDocClassOverrides((prev) => ({ ...prev, [fileName]: nextClass }))
    try {
      const res = await fetch(`/api/platform/knowledge/documents/${encodeURIComponent(fileName)}/doc-class`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_class: nextClass }),
      })
      if (!res.ok) throw new Error(`Reclassify failed (${res.status})`)
      return true
    } catch {
      setDocClassOverrides((prev) => {
        const next = { ...prev }
        delete next[fileName]
        return next
      })
      return false
    }
  }, [])

  const handleReclassify = useCallback(
    (file: KnowledgeFile, nextClass: DocClass) => {
      if (nextClass === resolveDocClass(file.docClass)) return
      void patchDocClass(file.fileName, nextClass).then(async (ok) => {
        if (!ok) {
          toast.error(t('knowledge.docClassUpdateFailed', { name: file.fileName }))
          return
        }
        toast.success(
          t('knowledge.docClassUpdated', { name: file.fileName, label: DOC_CLASS_LABELS[nextClass] }),
        )
        await load()
      })
    },
    [patchDocClass, load, t],
  )

  const handleBulkReclassify = useCallback(
    (nextClass: DocClass) => {
      const names = [...selected]
      if (names.length === 0) return
      void Promise.all(names.map((name) => patchDocClass(name, nextClass))).then(async (results) => {
        const failed = results.filter((ok) => !ok).length
        const succeeded = results.length - failed
        if (succeeded > 0) {
          toast.success(
            t('knowledgeAdmin.bulkReclassifyDone', {
              count: succeeded,
              label: DOC_CLASS_LABELS[nextClass],
            }),
          )
        }
        if (failed > 0) toast.error(t('knowledgeAdmin.bulkReclassifyFailed', { count: failed }))
        setSelected([])
        await load()
      })
    },
    [selected, patchDocClass, load, t],
  )

  const handleRename = useCallback(
    (file: KnowledgeFile) => {
      const nextTitle = titleDraft.trim()
      const current = (file.displayTitle ?? '').trim()
      if (nextTitle === current) return
      // Optimistic: show the new name immediately; revert on failure. An empty
      // draft clears the override, so the derived default takes over again.
      setDisplayTitleOverrides((prev) => ({ ...prev, [file.fileName]: nextTitle }))
      fetch(`/api/platform/knowledge/documents/${encodeURIComponent(file.fileName)}/display-title`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_title: nextTitle }),
      })
        .then(async (r) => {
          if (!r.ok) throw new Error(`Rename failed (${r.status})`)
          toast.success(t('knowledge.displayTitleUpdated', { name: file.fileName }))
          await load()
          setDisplayTitleOverrides((prev) => {
            const next = { ...prev }
            delete next[file.fileName]
            return next
          })
        })
        .catch(() => {
          setDisplayTitleOverrides((prev) => {
            const next = { ...prev }
            delete next[file.fileName]
            return next
          })
          toast.error(t('knowledge.displayTitleUpdateFailed', { name: file.fileName }))
        })
    },
    [titleDraft, load, t],
  )

  // Files with any optimistic doc_class / display-title edit applied.
  const files = useMemo<KnowledgeFile[]>(() => {
    const all = status?.files ?? []
    if (Object.keys(docClassOverrides).length === 0 && Object.keys(displayTitleOverrides).length === 0) {
      return all
    }
    return all.map((f) => {
      let next = f
      if (docClassOverrides[f.fileName]) next = { ...next, docClass: docClassOverrides[f.fileName] }
      if (f.fileName in displayTitleOverrides) {
        // An empty override means "cleared" → fall back to the filename here; the
        // reload will replace it with the backend's derived default.
        next = { ...next, displayTitle: displayTitleOverrides[f.fileName] || null }
      }
      return next
    })
  }, [status, docClassOverrides, displayTitleOverrides])

  const byName = useMemo(() => new Map(files.map((f) => [f.fileName, f])), [files])
  const detailFile = detailName ? (byName.get(detailName) ?? null) : null
  const deleteTargets = useMemo(
    () => pendingDelete.map((name) => byName.get(name)).filter((f): f is KnowledgeFile => !!f),
    [pendingDelete, byName],
  )

  const handleDelete = useCallback(() => {
    const names = [...pendingDelete]
    if (names.length === 0) return
    const targets = names.map((name) => byName.get(name))
    setIsDeleting(true)
    // Optimistic: drop the rows immediately; the refetch in finally() reconciles
    // (and brings them back if a request failed).
    setStatus((prev) => (prev ? { ...prev, files: prev.files.filter((f) => !names.includes(f.fileName)) } : prev))
    // `allSettled`, not `all`: `all` rejects on the first failure, so nine of ten
    // documents deleting successfully would still be reported as ten failures.
    // This mirrors the per-item accounting in `handleBulkReclassify`, so both
    // bulk paths report the same way.
    Promise.allSettled(
      names.map((name) =>
        fetch(`/api/platform/knowledge/documents/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) => {
          if (!r.ok) throw new Error(`Delete failed (${r.status})`)
          return name
        }),
      ),
    )
      .then((results) => {
        const failed = results.filter((r) => r.status === 'rejected').length
        const removed = results.length - failed
        if (names.length === 1) {
          if (failed > 0) {
            toast.error(t('knowledge.deleteFailed', { name: names[0] }))
          } else {
            const isUploaded = targets[0]?.origin === 'uploaded'
            toast.success(
              t(isUploaded ? 'knowledge.deleteSuccess' : 'knowledge.corpusDeleteSuccess', { name: names[0] }),
            )
          }
          return
        }
        if (removed > 0) toast.success(t('knowledgeAdmin.bulkDeleteDone', { count: removed }))
        if (failed > 0) toast.error(t('knowledgeAdmin.bulkDeleteFailed', { count: failed }))
      })
      .finally(() => {
        setIsDeleting(false)
        setPendingDelete([])
        setSelected((prev) => prev.filter((name) => !names.includes(name)))
        void load()
      })
  }, [pendingDelete, byName, load, t])

  // Dokumentart filter options — the classes actually present, in canonical
  // order (OIB foundations first), each with a live count. Nothing invented.
  const presentClasses = useMemo(() => {
    const counts = new Map<DocClass, number>()
    for (const f of files) {
      const cls = resolveDocClass(f.docClass)
      counts.set(cls, (counts.get(cls) ?? 0) + 1)
    }
    return DOC_CLASSES.filter((cls) => counts.has(cls)).map((cls) => ({ cls, count: counts.get(cls)! }))
  }, [files])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matched = files.filter((f) => {
      if (classFilter !== ALL && resolveDocClass(f.docClass) !== classFilter) return false
      if (scope !== ALL && isOibBinding(f.docClass) !== (scope === 'binding')) return false
      if (needle) {
        const haystack = `${f.fileName} ${f.displayTitle ?? ''}`.toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    })

    const direction = sortDir === 'asc' ? 1 : -1
    const rank = (f: KnowledgeFile): number | string => {
      switch (sortKey) {
        case 'document':
          return (f.displayTitle ?? f.fileName).toLowerCase()
        // Canonical DOC_CLASSES order already puts the binding OIB classes
        // first, so the default sort reproduces the old "binding, then the
        // rest" grouping without hard-splitting the list into two tables.
        case 'class':
          return DOC_CLASSES.indexOf(resolveDocClass(f.docClass))
        case 'state':
          return STATE_ORDER.indexOf(f.state)
        case 'chunks':
          return f.chunkCount
      }
    }
    return [...matched].sort((a, b) => {
      const left = rank(a)
      const right = rank(b)
      if (left < right) return -1 * direction
      if (left > right) return 1 * direction
      return a.fileName.localeCompare(b.fileName)
    })
  }, [files, query, classFilter, scope, sortKey, sortDir])

  // A filter change can strand the viewport past the end of the new result set.
  const safeOffset = offset >= filtered.length ? 0 : offset
  const page = filtered.slice(safeOffset, safeOffset + PAGE_SIZE)
  const allOnPageSelected = page.length > 0 && page.every((f) => selected.includes(f.fileName))

  const resetPaging = useCallback(() => setOffset(0), [])

  const toggleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortKey(key)
        setSortDir('asc')
      }
      setOffset(0)
    },
    [sortKey],
  )

  const openDetail = useCallback((file: KnowledgeFile) => {
    setDetailName(file.fileName)
    setTitleDraft(file.displayTitle ?? '')
  }, [])

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragActive(false)
    if (isUploading || isSyncing) return
    const file = event.dataTransfer.files?.[0]
    if (file) handleUpload(file)
  }

  const hasDocuments = files.length > 0
  // The empty state must not swallow the upload panel or in-flight progress —
  // otherwise the first upload into an empty corpus has nowhere to happen.
  const showEmpty = !hasDocuments && !uploadOpen && !uploadProgress && !pollTimedOut

  const sortIcon = (key: SortKey) =>
    sortKey !== key ? ChevronsUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown

  const sortableHead = (key: SortKey, label: string, className?: string) => {
    const Icon = sortIcon(key)
    return (
      <TableHead
        className={className}
        aria-sort={sortKey !== key ? 'none' : sortDir === 'asc' ? 'ascending' : 'descending'}
      >
        <button
          type="button"
          onClick={() => toggleSort(key)}
          aria-label={t('knowledgeAdmin.sortBy', { column: label })}
          // A column header is text-height by design; `touch-target` makes it
          // tappable without turning the header row into a row of buttons.
          className="inline-flex items-center gap-1 rounded-sm uppercase tracking-wide transition-colors duration-quick ease-out hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 touch-target"
        >
          {label}
          <Icon className="size-3" aria-hidden />
        </button>
      </TableHead>
    )
  }

  return (
    <>
      <SectionCard
        title={t('knowledge.title')}
        description={t('knowledge.explainer')}
        testId="platform-base-knowledge"
        loading={isLoading && !status}
        error={hasError}
        errorMessage={t('knowledge.loadError')}
        onRetry={() => void load()}
        empty={showEmpty}
        emptyIcon={BookOpenCheck}
        emptyTitle={t('knowledgeAdmin.emptyTitle')}
        emptyDescription={t('knowledgeAdmin.emptyDescription')}
        action={
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" onClick={() => setUploadOpen((open) => !open)} aria-expanded={uploadOpen}>
              <Upload className="size-3.5" aria-hidden />
              {uploadOpen ? t('knowledgeAdmin.hideUpload') : t('knowledgeAdmin.addDocuments')}
            </Button>
            <Button variant="outline" size="sm" onClick={handleSync} disabled={isSyncing || isUploading}>
              {isSyncing ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" aria-hidden />}
              {isSyncing ? t('knowledge.syncing') : t('knowledge.sync')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {/* Corpus summary — the four numbers that answer "is the base corpus
              healthy?", which the old surface never showed at all. */}
          {status && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="knowledge-summary">
              <StatCard className="min-h-24" label={t('knowledgeAdmin.summaryDocuments')} value={status.summary.totalFiles} />
              <StatCard className="min-h-24" label={t('knowledgeAdmin.summaryIndexed')} value={status.summary.ingested} />
              <StatCard className="min-h-24" label={t('knowledgeAdmin.summaryPending')} value={status.summary.pending} />
              <StatCard className="min-h-24" label={t('knowledgeAdmin.summaryChunks')} value={status.summary.totalChunks} />
            </div>
          )}

          {/* Drag-and-drop / click upload (PDF + ZIP), revealed on demand. */}
          {uploadOpen && (
            <div
              role="button"
              tabIndex={0}
              aria-label={t('knowledge.dropTitle')}
              aria-disabled={isUploading || isSyncing}
              onClick={() => !isUploading && !isSyncing && fileInputRef.current?.click()}
              onKeyDown={(event) => {
                if ((event.key === 'Enter' || event.key === ' ') && !isUploading && !isSyncing) {
                  event.preventDefault()
                  fileInputRef.current?.click()
                }
              }}
              onDragOver={(event) => {
                event.preventDefault()
                if (!isUploading && !isSyncing) setIsDragActive(true)
              }}
              onDragLeave={() => setIsDragActive(false)}
              onDrop={onDrop}
              className={cn(
                'flex min-h-[7.5rem] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors duration-quick ease-out motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                'animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none',
                isDragActive ? 'border-primary bg-accent' : 'border-border hover:border-primary/60 hover:bg-accent/40',
                (isUploading || isSyncing) && 'pointer-events-none opacity-60',
              )}
              data-testid="knowledge-dropzone"
            >
              {isUploading ? (
                <Spinner className="size-5 text-muted-foreground" />
              ) : (
                <Upload className="size-5 text-muted-foreground" aria-hidden />
              )}
              <p className="text-sm font-medium text-foreground">
                {isUploading
                  ? t('knowledge.uploading')
                  : isDragActive
                    ? t('knowledge.dropActive')
                    : t('knowledge.dropTitle')}
              </p>
              <p className="text-xs text-muted-foreground">{t('knowledge.dropHint')}</p>
            </div>
          )}
          {/* Outside the dropzone: the panel collapses, and a file input that
              unmounts mid-upload would cancel the change event. */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.zip,application/zip,application/pdf"
            className="hidden"
            data-testid="knowledge-upload-input"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) handleUpload(file)
            }}
          />

          {/* Live indexing progress — an aggregate 'N of M' bar plus, for a bulk
              ZIP, a per-file list that flips pending → indexed as each finishes. */}
          {uploadProgress && !pollTimedOut && (
            <div
              className="flex flex-col gap-2.5 rounded-lg border border-border bg-card/50 p-3"
              data-testid="knowledge-upload-progress"
            >
              <div className="flex items-center gap-2">
                <Spinner size="sm" className="shrink-0 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">
                  {t('knowledge.indexingProgress', { done: uploadProgress.done, total: uploadProgress.total })}
                </p>
              </div>
              <Progress value={uploadProgress.pct} aria-label={t('knowledge.processing')} />
              <p className="text-xs text-muted-foreground">{t('knowledge.processingHint')}</p>
              {uploadProgress.total > 1 && (
                <ScrollArea className="mt-0.5 max-h-40 pr-1">
                  <ul className="flex flex-col gap-1">
                    {uploadProgress.items.map((item) => (
                      <li key={item.name} className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate text-foreground">{item.name}</span>
                        {item.finished ? (
                          <Badge variant="success">{t('knowledge.indexingDone')}</Badge>
                        ) : (
                          <Badge variant="info" className="gap-1">
                            <Spinner size="xs" />
                            {t('knowledge.indexingPending')}
                          </Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              )}
            </div>
          )}

          {/* Polling ceiling reached while still indexing — a persistent, actionable
              notice so the progress affordance never just vanishes. */}
          {pollTimedOut && (
            <Alert variant="info" data-testid="knowledge-poll-timeout">
              <AlertCircle className="size-4" aria-hidden />
              <AlertTitle>{t('knowledge.pollTimeoutTitle')}</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-2">
                <span>{t('knowledge.pollTimeoutDescription')}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    // Re-arm polling for the still-working documents and refresh now.
                    startPolling(watched)
                    void load()
                  }}
                >
                  <RefreshCw className="size-3.5" aria-hidden />
                  {t('knowledge.pollTimeoutRefresh')}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {/* ZIP member summary (accepted / rejected). */}
          {lastUpload?.kind === 'zip' && (lastUpload.rejected ?? 0) > 0 && lastUpload.members && (
            <Alert variant="warning">
              <AlertCircle className="size-4" aria-hidden />
              <AlertTitle>{t('knowledge.zipRejectedTitle')}</AlertTitle>
              <AlertDescription>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {lastUpload.members
                    .filter((m) => m.status === 'rejected')
                    .map((m) => (
                      <li key={m.fileName}>
                        <span className="font-medium">{m.fileName}</span>
                        {m.reason ? ` — ${m.reason}` : ''}
                      </li>
                    ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {hasDocuments && (
            <>
              <DataToolbar
                searchValue={query}
                onSearchChange={(value) => {
                  setQuery(value)
                  resetPaging()
                }}
                searchPlaceholder={t('knowledge.search')}
                searchLabel={t('knowledgeAdmin.searchLabel')}
                clearLabel={t('knowledgeAdmin.searchClear')}
                selectedCount={selected.length}
                selectionLabel={(count) => t('knowledgeAdmin.selectedCount', { count })}
                onClearSelection={() => setSelected([])}
                clearSelectionLabel={t('knowledgeAdmin.clearSelection')}
                selectionActions={
                  <>
                    <Select value="" onValueChange={(value) => handleBulkReclassify(value as DocClass)}>
                      <SelectTrigger size="sm" className="w-56" aria-label={t('knowledgeAdmin.bulkReclassify')}>
                        <SelectValue placeholder={t('knowledgeAdmin.bulkReclassify')} />
                      </SelectTrigger>
                      <SelectContent>
                        {DOC_CLASSES.map((option) => (
                          <SelectItem key={option} value={option}>
                            {DOC_CLASS_LABELS[option]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button variant="outline" size="sm" onClick={handleReingest} disabled={isReingesting}>
                      <RefreshCw className={`size-3.5 ${isReingesting ? 'animate-spin' : ''}`} aria-hidden />
                      {isReingesting ? t('knowledgeAdmin.bulkReingestBusy') : t('knowledgeAdmin.bulkReingest')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive"
                      onClick={() => setPendingDelete([...selected])}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                      {t('knowledgeAdmin.bulkDelete')}
                    </Button>
                  </>
                }
                filters={
                  <>
                    <Select
                      value={scope}
                      onValueChange={(value) => {
                        setScope(value as Scope)
                        resetPaging()
                      }}
                    >
                      <SelectTrigger size="sm" className="w-52" aria-label={t('knowledgeAdmin.scopeLabel')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL}>{t('knowledgeAdmin.scopeAll')}</SelectItem>
                        {/* The binding-vs-other split survives as a filter (and as
                            the default sort) instead of two hard-coded tables. */}
                        <SelectItem value="binding">{t('knowledge.bindingTitle')}</SelectItem>
                        <SelectItem value="other">{t('knowledge.otherTitle')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select
                      value={classFilter}
                      onValueChange={(value) => {
                        setClassFilter(value as DocClass | typeof ALL)
                        resetPaging()
                      }}
                    >
                      <SelectTrigger size="sm" className="w-56" aria-label={t('knowledge.docClassLabel')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL}>{t('knowledge.docClassFilterAll')}</SelectItem>
                        {presentClasses.map(({ cls, count }) => (
                          <SelectItem key={cls} value={cls}>
                            {DOC_CLASS_LABELS[cls]} ({count})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                }
              />

              {filtered.length === 0 ? (
                <EmptyState
                  variant="bare"
                  icon={FileText}
                  title={t('knowledge.noMatch')}
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setQuery('')
                        setClassFilter(ALL)
                        setScope(ALL)
                        resetPaging()
                      }}
                    >
                      {t('knowledge.clearFilters')}
                    </Button>
                  }
                />
              ) : (
                <>
                  <div className="rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>
                            <Checkbox
                              // A partial page selection would otherwise read as
                              // "nothing selected", leaving the toolbar count as
                              // the only signal.
                              checked={
                                allOnPageSelected
                                  ? true
                                  : page.some((f) => selected.includes(f.fileName))
                                    ? 'indeterminate'
                                    : false
                              }
                              aria-label={t('knowledgeAdmin.selectAll')}
                              onCheckedChange={(checked) =>
                                setSelected((prev) => {
                                  const names = page.map((f) => f.fileName)
                                  return checked
                                    ? [...new Set([...prev, ...names])]
                                    : prev.filter((name) => !names.includes(name))
                                })
                              }
                            />
                          </TableHead>
                          {sortableHead('document', t('knowledgeAdmin.colDocument'))}
                          {sortableHead('class', t('knowledgeAdmin.colType'))}
                          {sortableHead('state', t('knowledgeAdmin.colState'))}
                          {sortableHead('chunks', t('knowledgeAdmin.colChunks'), 'text-right')}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {page.map((file) => {
                          const cls = resolveDocClass(file.docClass)
                          const authority = docClassAuthority(cls)
                          const isSelected = selected.includes(file.fileName)
                          return (
                            <TableRow
                              key={file.fileName}
                              data-state={isSelected ? 'selected' : undefined}
                              className="cursor-pointer"
                              onClick={() => openDetail(file)}
                            >
                              <TableCell onClick={(event) => event.stopPropagation()}>
                                <Checkbox
                                  checked={isSelected}
                                  aria-label={t('knowledgeAdmin.selectRow', { name: file.fileName })}
                                  onCheckedChange={(checked) =>
                                    setSelected((prev) =>
                                      checked
                                        ? [...prev, file.fileName]
                                        : prev.filter((name) => name !== file.fileName),
                                    )
                                  }
                                />
                              </TableCell>
                              <TableCell className="max-w-[22rem]">
                                <button
                                  type="button"
                                  className="block w-full text-left pointer-coarse:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                                  aria-label={t('knowledgeAdmin.openDetail', { name: file.fileName })}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    openDetail(file)
                                  }}
                                >
                                  <span className="block truncate text-sm font-medium text-foreground">
                                    {file.displayTitle ?? file.fileName}
                                  </span>
                                  {file.displayTitle && file.displayTitle !== file.fileName && (
                                    <span className="block truncate text-xs text-muted-foreground">
                                      {file.fileName}
                                    </span>
                                  )}
                                </button>
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <SourceSignalChip
                                    signal={docClassSignal(cls)}
                                    title={authority ? `${DOC_CLASS_LABELS[cls]} · ${authority}` : DOC_CLASS_LABELS[cls]}
                                  >
                                    {DOC_CLASS_LABELS[cls]}
                                    {authority ? ` · ${authority}` : ''}
                                  </SourceSignalChip>
                                  {isOibBinding(cls) && (
                                    <Badge variant="outline">{t('knowledgeAdmin.binding')}</Badge>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <Badge variant={STATE_VARIANT[file.state]} title={tk(`stateHints.${file.state}`)}>
                                    {tk(`states.${file.state}`)}
                                  </Badge>
                                  {file.origin === 'uploaded' && (
                                    <Badge variant="outline">{tk('origin.uploaded')}</Badge>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                                {file.chunkCount > 0 ? file.chunkCount : '—'}
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>

                  <Pagination
                    offset={safeOffset}
                    pageSize={PAGE_SIZE}
                    total={filtered.length}
                    onOffsetChange={setOffset}
                    rangeLabel={(from, to, total) => t('knowledgeAdmin.range', { from, to, total })}
                    previousLabel={t('knowledgeAdmin.previous')}
                    nextLabel={t('knowledgeAdmin.next')}
                  />
                </>
              )}
            </>
          )}
        </div>
      </SectionCard>

      {/* Row detail: rename, reclassify, open the PDF, remove — the four
          controls that used to be crammed into every row of the list. */}
      <Sheet open={detailFile !== null} onOpenChange={(open) => !open && setDetailName(null)}>
        <SheetContent closeLabel={t('knowledgeAdmin.detailClose')} data-testid="knowledge-detail">
          {detailFile && (
            <>
              <SheetHeader>
                <SheetTitle>{detailFile.displayTitle ?? detailFile.fileName}</SheetTitle>
                <SheetDescription>{detailFile.fileName}</SheetDescription>
              </SheetHeader>

              <div className="flex flex-wrap items-center gap-1.5">
                <SourceSignalChip signal={docClassSignal(detailFile.docClass)}>
                  {DOC_CLASS_LABELS[resolveDocClass(detailFile.docClass)]}
                </SourceSignalChip>
                {isOibBinding(detailFile.docClass) && (
                  <Badge variant="outline">{t('knowledgeAdmin.binding')}</Badge>
                )}
                <Badge variant={STATE_VARIANT[detailFile.state]} title={tk(`stateHints.${detailFile.state}`)}>
                  {tk(`states.${detailFile.state}`)}
                </Badge>
              </div>

              {/* Rename */}
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-xs font-medium text-muted-foreground"
                  htmlFor="knowledge-display-title"
                >
                  {t('knowledge.displayTitleEdit', { name: detailFile.fileName })}
                </label>
                <div className="flex items-center gap-1.5">
                  <Input
                    id="knowledge-display-title"
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') handleRename(detailFile)
                    }}
                    className="h-8 text-sm"
                    aria-label={t('knowledge.displayTitleFor', { name: detailFile.fileName })}
                    placeholder={t('knowledge.displayTitlePlaceholder')}
                  />
                  <Button size="sm" variant="outline" onClick={() => handleRename(detailFile)}>
                    {t('knowledge.displayTitleSave')}
                  </Button>
                </div>
              </div>

              {/* Reclassify */}
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('knowledge.docClassLabel')}</span>
                <Select
                  value={resolveDocClass(detailFile.docClass)}
                  onValueChange={(value) => handleReclassify(detailFile, value as DocClass)}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full"
                    aria-label={t('knowledge.docClassFor', { name: detailFile.fileName })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DOC_CLASSES.map((option) => (
                      <SelectItem key={option} value={option}>
                        {DOC_CLASS_LABELS[option]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <dl className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
                <DetailRow label={t('knowledgeAdmin.detailOrigin')} value={t(`knowledgeAdmin.origin.${detailFile.origin}`)} />
                <DetailRow
                  label={t('knowledgeAdmin.detailChunks')}
                  value={detailFile.chunkCount > 0 ? tk('corpus.chunkCount', { count: detailFile.chunkCount }) : '—'}
                />
                <DetailRow
                  label={t('knowledgeAdmin.detailSize')}
                  value={detailFile.sizeBytes !== null ? formatBytes(detailFile.sizeBytes, locale) : '—'}
                />
                {detailFile.ingestedAt && (
                  <DetailRow
                    label={t('knowledgeAdmin.detailIngestedAt')}
                    value={new Date(detailFile.ingestedAt).toLocaleDateString(locale)}
                  />
                )}
              </dl>

              {detailFile.summary && (
                <p className="text-sm text-muted-foreground">{detailFile.summary}</p>
              )}

              <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
                {detailFile.origin !== 'index_only' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      // Close the sheet first: the viewer is a modal dialog, and
                      // stacking two focus traps is how keyboard users get stuck.
                      setDetailName(null)
                      setViewerFile(detailFile.fileName)
                    }}
                  >
                    <Eye className="size-3.5" aria-hidden />
                    {t('knowledge.viewPdf')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive"
                  onClick={() => {
                    setDetailName(null)
                    setPendingDelete([detailFile.fileName])
                  }}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  {detailFile.origin === 'uploaded' ? t('knowledge.delete') : t('knowledge.corpusDelete')}
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {viewerFile && (
        <PdfViewerDialog open onOpenChange={(open) => !open && setViewerFile(null)} fileName={viewerFile} />
      )}

      <ConfirmDialog
        open={pendingDelete.length > 0}
        onOpenChange={(open) => {
          if (!open) setPendingDelete([])
        }}
        title={
          deleteTargets.length > 1
            ? t('knowledgeAdmin.bulkDeleteTitle', { count: deleteTargets.length })
            : deleteTargets[0]?.origin === 'uploaded'
              ? t('knowledge.deleteTitle', { name: deleteTargets[0]?.fileName ?? '' })
              : t('knowledge.corpusDeleteTitle', { name: deleteTargets[0]?.fileName ?? '' })
        }
        description={
          deleteTargets.length > 1
            ? t('knowledgeAdmin.bulkDeleteDescription')
            : deleteTargets[0]?.origin === 'uploaded'
              ? t('knowledge.deleteDescription')
              : t('knowledge.corpusDeleteDescription')
        }
        confirmLabel={
          deleteTargets.length > 1
            ? t('knowledgeAdmin.bulkDeleteConfirm', { count: deleteTargets.length })
            : deleteTargets[0]?.origin === 'uploaded'
              ? t('knowledge.deleteConfirm')
              : t('knowledge.corpusDeleteConfirm')
        }
        cancelLabel={t('knowledge.deleteCancel')}
        tone="destructive"
        pending={isDeleting}
        onConfirm={handleDelete}
      />
    </>
  )
}

/** One label/value pair in the detail sheet's metadata block. */
function DetailRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm text-foreground">{value}</dd>
    </div>
  )
}
