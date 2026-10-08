'use client'

/**
 * Platform base-knowledge manager (ADR-0016, Phase C): the shared OIB corpus
 * every project grounds its answers on, for a non-technical owner.
 *
 * Reading order: four numbers that answer "is the corpus healthy?", then one
 * card holding the toolbar (search, filters, Upload, an overflow menu for the
 * corpus-wide actions) and the table. A row's edits live in a detail sheet,
 * and the same edits apply to a selection at once.
 *
 * The ingest contract: the backend ingests uploads in the background, so an
 * upload returns `pending`, and `useIngestWatch` polls the status until each
 * new file is done, timed out or missing.
 *
 * Two actions cost money (every page goes through OCR, VLM captioning and
 * embedding again): Sync and Re-index. Both ask first and say what they cover.
 * Read-only platform staff see the corpus and the detail of every document,
 * and none of the write controls (every write route requires
 * `platform:settings:manage`).
 */

import { SortableHead } from './sortable-head'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  BookOpenCheck,
  CheckCircle2,
  FileText,
  Layers,
  Lock,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
} from 'lucide-react'
import { ActionMenu, type ActionMenuEntry } from '@/components/ui/action-menu'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DataToolbar } from '@/components/ui/data-toolbar'
import { EmptyState } from '@/components/ui/empty-state'
import { Pagination } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { StatCard, StatCardSkeleton } from '@/components/ui/stat-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DocClassChip,
  KnowledgeStateBadge,
  useDocClassLabel,
} from '@/features/platform/components/knowledge-atoms'
import { KnowledgeDocumentSheet } from '@/features/platform/components/knowledge-document-sheet'
import { useIngestWatch } from '@/features/platform/components/knowledge-ingest-watch'
import { KnowledgeUploadPanel } from '@/features/platform/components/knowledge-upload-panel'
import { SectionCard } from '@/features/platform/components/section-card'
import { usePlatformCan } from '@/features/platform/platform-access'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'
import { useLocale, useTranslations } from '@/i18n'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import {
  DOC_CLASSES,
  isOibBinding,
  resolveDocClass,
  type DocClass,
} from '@/lib/knowledge/doc-class'
import type {
  KnowledgeBaseStatus,
  KnowledgeFile,
  KnowledgeFileState,
  KnowledgeUploadResult,
} from '@/lib/knowledge/service'

/** Sorting a status column alphabetically is useless; sort it by urgency. */
const STATE_ORDER: KnowledgeFileState[] = [
  'failed',
  'inconsistent',
  'stale',
  'pending',
  'ingested',
  'removed',
]

/** States that need the owner to act: re-index, or remove. */
const ATTENTION_STATES: ReadonlySet<KnowledgeFileState> = new Set([
  'failed',
  'inconsistent',
  'stale',
  'removed',
])
/** States a re-index can fix. A removed file has no source left to re-read. */
const REINGESTABLE_STATES: ReadonlySet<KnowledgeFileState> = new Set([
  'failed',
  'inconsistent',
  'stale',
])

/** How many names a confirm dialog lists before it says "and N more". */
const CONFIRM_LIST_MAX = 5

const PAGE_SIZE = 10
const ALL = 'all'

type SortKey = 'document' | 'class' | 'state' | 'chunks'
type SortDir = 'asc' | 'desc'
type TypeFilter = typeof ALL | 'binding' | 'other' | DocClass
type StateFilter = typeof ALL | 'issues' | 'pending'

export function BaseKnowledge(): JSX.Element {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const docClassLabel = useDocClassLabel()
  const canManage = usePlatformCan(PLATFORM_PERMISSIONS.settingsManage)

  const [status, setStatus] = useState<KnowledgeBaseStatus | null>(null)
  // Set only when there is nothing on screen to keep; a failed REFRESH keeps
  // the last good list and says so in a toast.
  const [hasError, setHasError] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>(ALL)
  const [stateFilter, setStateFilter] = useState<StateFilter>(ALL)
  const [sortKey, setSortKey] = useState<SortKey>('class')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<string[]>([])

  const [uploadOpen, setUploadOpen] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [lastUpload, setLastUpload] = useState<KnowledgeUploadResult | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncConfirmOpen, setSyncConfirmOpen] = useState(false)
  const [isReingesting, setIsReingesting] = useState(false)
  // The confirm dialogs hold a SNAPSHOT of their targets, taken when they
  // open. Deriving them from the live list emptied the delete dialog mid-
  // request (the rows are removed optimistically), so its title read
  // " entfernen?" and a bulk delete flipped to the single-file copy.
  const [pendingReingest, setPendingReingest] = useState<string[]>([])
  const [pendingDelete, setPendingDelete] = useState<KnowledgeFile[]>([])
  const [isDeleting, setIsDeleting] = useState(false)

  // Optimistic edits, applied over the fetched status until a refetch confirms them.
  const [docClassOverrides, setDocClassOverrides] = useState<Record<string, DocClass>>({})
  const [displayTitleOverrides, setDisplayTitleOverrides] = useState<Record<string, string>>({})

  // The NAME, not the row, so an edit or a poll shows in the open sheet.
  const [detailName, setDetailName] = useState<string | null>(null)
  const [viewerFile, setViewerFile] = useState<string | null>(null)

  const hasDataRef = useRef(false)
  const loadSeqRef = useRef(0)

  const fetchStatus = useCallback(async (): Promise<KnowledgeBaseStatus> => {
    const res = await fetch('/api/knowledge-base')
    if (!res.ok) throw new Error(`Failed to load knowledge base (${res.status})`)
    return (await res.json()) as KnowledgeBaseStatus
  }, [])

  const applyStatus = useCallback((next: KnowledgeBaseStatus) => {
    hasDataRef.current = true
    setStatus(next)
    setHasError(false)
    // Drop any optimistic override the backend now agrees with.
    setDocClassOverrides((prev) => {
      if (Object.keys(prev).length === 0) return prev
      const byName = new Map(next.files.map((f) => [f.fileName, f]))
      const remaining: Record<string, DocClass> = {}
      for (const [name, cls] of Object.entries(prev)) {
        if (byName.get(name)?.docClass !== cls) remaining[name] = cls
      }
      return remaining
    })
  }, [])

  const load = useCallback(async (): Promise<void> => {
    // Only the newest request may write: a slow answer to an earlier load must
    // not overwrite a later one.
    const seq = ++loadSeqRef.current
    setIsRefreshing(true)
    try {
      const next = await fetchStatus()
      if (seq === loadSeqRef.current) applyStatus(next)
    } catch {
      if (seq !== loadSeqRef.current) return
      if (hasDataRef.current) toast.error(t('knowledge.refreshFailed'))
      else setHasError(true)
    } finally {
      if (seq === loadSeqRef.current) setIsRefreshing(false)
    }
  }, [applyStatus, fetchStatus, t])

  useEffect(() => {
    void load()
  }, [load])

  // An answer arriving after unmount is dropped.
  useEffect(
    () => () => {
      loadSeqRef.current += 1
    },
    []
  )

  // Files with any optimistic doc_class / display-title edit applied.
  const files = useMemo<KnowledgeFile[]>(() => {
    const all = status?.files ?? []
    if (
      Object.keys(docClassOverrides).length === 0 &&
      Object.keys(displayTitleOverrides).length === 0
    ) {
      return all
    }
    return all.map((f) => {
      let next = f
      if (docClassOverrides[f.fileName]) next = { ...next, docClass: docClassOverrides[f.fileName] }
      // An empty override means "cleared": the reload brings the derived default.
      if (f.fileName in displayTitleOverrides) {
        next = { ...next, displayTitle: displayTitleOverrides[f.fileName] || null }
      }
      return next
    })
  }, [status, docClassOverrides, displayTitleOverrides])

  const ingest = useIngestWatch(fetchStatus, applyStatus, files)

  const handleUpload = useCallback(
    (file: File) => {
      setIsUploading(true)
      setLastUpload(null)
      const form = new FormData()
      form.append('file', file)
      fetch('/api/platform/knowledge/documents', { method: 'POST', body: form })
        .then(async (r) => {
          const body = (await r.json().catch(() => ({}))) as Partial<KnowledgeUploadResult> & {
            error?: string
          }
          if (!r.ok || (body.status !== 'pending' && body.status !== 'success')) {
            toast.error(body.error ?? t('knowledge.uploadFailed', { name: file.name }))
            return
          }
          setLastUpload(body as KnowledgeUploadResult)
          if (body.kind === 'zip') {
            toast.success(
              t('knowledge.zipQueued', {
                accepted: body.accepted ?? 0,
                rejected: body.rejected ?? 0,
              })
            )
          } else {
            toast.success(t('knowledge.uploadPending', { name: body.fileName ?? file.name }))
          }
          const names =
            body.kind === 'zip'
              ? (body.members ?? []).filter((m) => m.status === 'pending').map((m) => m.fileName)
              : body.fileName
                ? [body.fileName]
                : []
          await load()
          ingest.watch(names)
        })
        .catch(() => toast.error(t('knowledge.uploadFailed', { name: file.name })))
        .finally(() => setIsUploading(false))
    },
    [ingest, load, t]
  )

  const handleSync = useCallback(() => {
    // A full sync can take minutes, so the dialog closes and the toolbar
    // carries the running state instead of a locked modal.
    setSyncConfirmOpen(false)
    setIsSyncing(true)
    fetch('/api/platform/knowledge/sync', { method: 'POST' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Sync failed (${r.status})`)
        const body = (await r.json()) as { filesAdded?: number; filesTotal?: number }
        toast.success(
          t('knowledge.syncDone', { added: body.filesAdded ?? 0, total: body.filesTotal ?? 0 })
        )
      })
      .catch(() => toast.error(t('knowledge.syncFailed')))
      .finally(() => {
        setIsSyncing(false)
        void load()
      })
  }, [load, t])

  /**
   * Rebuild the chunks of the confirmed documents. Distinct from Sync, which
   * gates on each PDF's sha256 and does nothing for an unchanged file; this is
   * the remedy after a change to how chunks are BUILT. The backend queues and
   * returns; each document reads `pending` until its chunks exist again.
   */
  const handleReingest = useCallback(() => {
    const names = [...pendingReingest]
    setPendingReingest([])
    if (names.length === 0) return
    setIsReingesting(true)
    fetch('/api/platform/knowledge/reingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileNames: names }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Re-ingest failed (${r.status})`)
        const body = (await r.json()) as { queued?: unknown }
        const queued = Array.isArray(body.queued) ? body.queued.map(String) : []
        if (queued.length === 0) {
          // Nothing started: the selection stays, the admin may want to retry.
          toast.error(t('knowledgeAdmin.bulkReingestNothing'))
          return
        }
        toast.success(t('knowledgeAdmin.bulkReingestDone', { count: queued.length }))
        setSelected((prev) => prev.filter((name) => !names.includes(name)))
        ingest.watch(queued)
      })
      .catch(() => toast.error(t('knowledgeAdmin.bulkReingestFailed')))
      .finally(() => {
        setIsReingesting(false)
        void load()
      })
  }, [ingest, load, pendingReingest, t])

  /** PATCH one document's Dokumentart, optimistically, reverting on failure. */
  const patchDocClass = useCallback(
    async (fileName: string, nextClass: DocClass): Promise<boolean> => {
      setDocClassOverrides((prev) => ({ ...prev, [fileName]: nextClass }))
      try {
        const res = await fetch(
          `/api/platform/knowledge/documents/${encodeURIComponent(fileName)}/doc-class`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ doc_class: nextClass }),
          }
        )
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
    },
    []
  )

  const handleReclassify = useCallback(
    (file: KnowledgeFile, nextClass: DocClass) => {
      if (nextClass === resolveDocClass(file.docClass)) return
      void patchDocClass(file.fileName, nextClass).then(async (ok) => {
        if (!ok) {
          toast.error(t('knowledge.docClassUpdateFailed', { name: file.fileName }))
          return
        }
        toast.success(
          t('knowledge.docClassUpdated', { name: file.fileName, label: docClassLabel(nextClass) })
        )
        await load()
      })
    },
    [docClassLabel, patchDocClass, load, t]
  )

  const handleBulkReclassify = useCallback(
    (nextClass: DocClass) => {
      const names = [...selected]
      if (names.length === 0) return
      void Promise.all(names.map((name) => patchDocClass(name, nextClass))).then(
        async (results) => {
          const failed = results.filter((ok) => !ok).length
          const succeeded = results.length - failed
          if (succeeded > 0) {
            toast.success(
              t('knowledgeAdmin.bulkReclassifyDone', {
                count: succeeded,
                label: docClassLabel(nextClass),
              })
            )
          }
          if (failed > 0) toast.error(t('knowledgeAdmin.bulkReclassifyFailed', { count: failed }))
          setSelected([])
          await load()
        }
      )
    },
    [docClassLabel, selected, patchDocClass, load, t]
  )

  const handleRename = useCallback(
    (file: KnowledgeFile, draft: string) => {
      const nextTitle = draft.trim()
      if (nextTitle === (file.displayTitle ?? '').trim()) return
      const clear = () =>
        setDisplayTitleOverrides((prev) => {
          const next = { ...prev }
          delete next[file.fileName]
          return next
        })
      // Optimistic; an empty draft clears the override so the default returns.
      setDisplayTitleOverrides((prev) => ({ ...prev, [file.fileName]: nextTitle }))
      fetch(
        `/api/platform/knowledge/documents/${encodeURIComponent(file.fileName)}/display-title`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ display_title: nextTitle }),
        }
      )
        .then(async (r) => {
          if (!r.ok) throw new Error(`Rename failed (${r.status})`)
          toast.success(t('knowledge.displayTitleUpdated', { name: file.fileName }))
          await load()
          clear()
        })
        .catch(() => {
          clear()
          toast.error(t('knowledge.displayTitleUpdateFailed', { name: file.fileName }))
        })
    },
    [load, t]
  )

  const handleDelete = useCallback(() => {
    const names = pendingDelete.map((f) => f.fileName)
    if (names.length === 0) return
    setIsDeleting(true)
    // Optimistic: drop the rows now; the refetch reconciles and brings back
    // any that failed. The dialog reads its own snapshot, not these rows.
    setStatus((prev) =>
      prev ? { ...prev, files: prev.files.filter((f) => !names.includes(f.fileName)) } : prev
    )
    // `allSettled`: nine of ten deleting must not be reported as ten failures.
    Promise.allSettled(
      names.map((name) =>
        fetch(`/api/platform/knowledge/documents/${encodeURIComponent(name)}`, {
          method: 'DELETE',
        }).then((r) => {
          if (!r.ok) throw new Error(`Delete failed (${r.status})`)
          return name
        })
      )
    )
      .then((results) => {
        const failed = results.filter((r) => r.status === 'rejected').length
        const removed = results.length - failed
        if (names.length === 1) {
          if (failed > 0) toast.error(t('knowledge.deleteFailed', { name: names[0] }))
          else toast.success(t('knowledge.deleteSuccess', { name: names[0] }))
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
  }, [pendingDelete, load, t])

  const byName = useMemo(() => new Map(files.map((f) => [f.fileName, f])), [files])
  const detailFile = detailName ? (byName.get(detailName) ?? null) : null

  // The Dokumentart filter offers the classes actually present, with counts.
  const presentClasses = useMemo(() => {
    const counts = new Map<DocClass, number>()
    for (const f of files) {
      const cls = resolveDocClass(f.docClass)
      counts.set(cls, (counts.get(cls) ?? 0) + 1)
    }
    return DOC_CLASSES.filter((cls) => counts.has(cls)).map((cls) => ({
      cls,
      count: counts.get(cls) ?? 0,
    }))
  }, [files])

  const reingestable = useMemo(
    () => files.filter((f) => REINGESTABLE_STATES.has(f.state)).map((f) => f.fileName),
    [files]
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matched = files.filter((f) => {
      if (typeFilter === 'binding' && !isOibBinding(f.docClass)) return false
      if (typeFilter === 'other' && isOibBinding(f.docClass)) return false
      if (typeFilter !== ALL && typeFilter !== 'binding' && typeFilter !== 'other') {
        if (resolveDocClass(f.docClass) !== typeFilter) return false
      }
      if (stateFilter === 'issues' && !ATTENTION_STATES.has(f.state)) return false
      if (stateFilter === 'pending' && f.state !== 'pending') return false
      if (needle && !`${f.fileName} ${f.displayTitle ?? ''}`.toLowerCase().includes(needle))
        return false
      return true
    })

    const direction = sortDir === 'asc' ? 1 : -1
    const rank = (f: KnowledgeFile): number | string => {
      switch (sortKey) {
        case 'document':
          return (f.displayTitle ?? f.fileName).toLowerCase()
        // Canonical DOC_CLASSES order puts the binding OIB classes first.
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
  }, [files, query, typeFilter, stateFilter, sortKey, sortDir])

  // A filter change can strand the viewport past the end of the result set.
  const safeOffset = offset >= filtered.length ? 0 : offset
  const page = filtered.slice(safeOffset, safeOffset + PAGE_SIZE)
  const allOnPageSelected = page.length > 0 && page.every((f) => selected.includes(f.fileName))
  const someOnPageSelected = page.some((f) => selected.includes(f.fileName))

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
    [sortKey]
  )

  const clearFilters = () => {
    setQuery('')
    setTypeFilter(ALL)
    setStateFilter(ALL)
    setOffset(0)
  }

  const isBusy = isUploading || isSyncing
  const hasDocuments = files.length > 0
  // The empty state must not swallow the upload panel or in-flight progress,
  // or the first upload into an empty corpus has nowhere to happen.
  const showEmpty =
    !hasDocuments &&
    !uploadOpen &&
    ingest.items.length === 0 &&
    !ingest.timedOut &&
    ingest.missing.length === 0

  const sortableHead = (key: SortKey, label: string, className?: string) => (
    <SortableHead
      label={label}
      ariaLabel={t('knowledgeAdmin.sortBy', { column: label })}
      active={sortKey === key}
      direction={sortDir}
      onSort={() => toggleSort(key)}
      className={className}
    />
  )

  const overflowEntries: ActionMenuEntry[] = [
    {
      type: 'item',
      id: 'sync',
      label: t('knowledge.sync'),
      icon: RefreshCw,
      disabled: isBusy,
      onSelect: () => setSyncConfirmOpen(true),
      testId: 'knowledge-sync',
    },
    {
      type: 'item',
      id: 'reingest-issues',
      label: `${t('knowledgeAdmin.reingestIssues')} (${reingestable.length.toLocaleString(locale)})`,
      icon: RotateCcw,
      disabled: reingestable.length === 0 || isReingesting,
      onSelect: () => setPendingReingest(reingestable),
      testId: 'knowledge-reingest-issues',
    },
  ]

  const toolbarActions = canManage ? (
    <>
      {isSyncing || isReingesting ? (
        <span
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
          aria-live="polite"
        >
          <Spinner size="xs" aria-hidden />
          {isSyncing ? t('knowledge.syncing') : t('knowledgeAdmin.bulkReingestBusy')}
        </span>
      ) : null}
      <Button size="sm" onClick={() => setUploadOpen((open) => !open)} aria-expanded={uploadOpen}>
        <Upload className="size-3.5" aria-hidden />
        {uploadOpen ? t('knowledgeAdmin.hideUpload') : t('knowledgeAdmin.addDocuments')}
      </Button>
      <ActionMenu
        mode="dropdown"
        entries={overflowEntries}
        contentClassName="w-64"
        trigger={
          <Button
            variant="outline"
            size="sm"
            className="w-8 px-0"
            aria-label={t('knowledgeAdmin.moreActions')}
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </Button>
        }
      />
    </>
  ) : null

  return (
    <div className="flex flex-col gap-6">
      <KnowledgeSummary status={status} files={files} loading={!status && !hasError} />

      {canManage ? null : (
        <p
          className="text-muted-foreground flex items-center gap-1.5 text-sm"
          data-testid="knowledge-read-only"
        >
          <Lock className="size-3.5 shrink-0" aria-hidden />
          {t('knowledgeAdmin.readOnly')}
        </p>
      )}

      <SectionCard
        testId="platform-base-knowledge"
        loading={!status && !hasError}
        refreshing={isRefreshing && status !== null}
        skeletonRows={6}
        error={hasError}
        errorMessage={t('knowledge.loadError')}
        onRetry={() => {
          setHasError(false)
          void load()
        }}
        empty={showEmpty}
        emptyIcon={BookOpenCheck}
        emptyTitle={t('knowledgeAdmin.emptyTitle')}
        emptyDescription={t('knowledgeAdmin.emptyDescription')}
        emptyAction={
          canManage ? (
            <Button size="sm" onClick={() => setUploadOpen(true)}>
              <Upload className="size-3.5" aria-hidden />
              {t('knowledgeAdmin.addDocuments')}
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-4">
          {hasDocuments ? (
            <DataToolbar
              searchValue={query}
              onSearchChange={(value) => {
                setQuery(value)
                setOffset(0)
              }}
              searchPlaceholder={t('knowledge.search')}
              searchLabel={t('knowledgeAdmin.searchLabel')}
              clearLabel={t('knowledgeAdmin.searchClear')}
              selectedCount={canManage ? selected.length : 0}
              selectionLabel={(count) => t('knowledgeAdmin.selectedCount', { count })}
              onClearSelection={() => setSelected([])}
              clearSelectionLabel={t('knowledgeAdmin.clearSelection')}
              selectionActions={
                <>
                  <Select
                    value=""
                    onValueChange={(value) => handleBulkReclassify(value as DocClass)}
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-52"
                      aria-label={t('knowledgeAdmin.bulkReclassify')}
                    >
                      <SelectValue placeholder={t('knowledgeAdmin.bulkReclassify')} />
                    </SelectTrigger>
                    <SelectContent>
                      {DOC_CLASSES.map((option) => (
                        <SelectItem key={option} value={option}>
                          {docClassLabel(option)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPendingReingest([...selected])}
                    loading={isReingesting}
                  >
                    {isReingesting ? null : <RotateCcw className="size-3.5" aria-hidden />}
                    {isReingesting
                      ? t('knowledgeAdmin.bulkReingestBusy')
                      : t('knowledgeAdmin.bulkReingest')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() =>
                      setPendingDelete(files.filter((f) => selected.includes(f.fileName)))
                    }
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                    {t('knowledgeAdmin.bulkDelete')}
                  </Button>
                </>
              }
              filters={
                <>
                  <Select
                    value={typeFilter}
                    onValueChange={(value) => {
                      setTypeFilter(value as TypeFilter)
                      setOffset(0)
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="min-w-40 flex-1 sm:w-48 sm:flex-none"
                      aria-label={t('knowledgeAdmin.typeFilterLabel')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>{t('knowledge.docClassFilterAll')}</SelectItem>
                      {/* The binding-vs-other split, as two entries of the type filter. */}
                      <SelectItem value="binding">{t('knowledge.bindingTitle')}</SelectItem>
                      <SelectItem value="other">{t('knowledge.otherTitle')}</SelectItem>
                      <SelectSeparator />
                      {presentClasses.map(({ cls, count }) => (
                        <SelectItem key={cls} value={cls}>
                          {docClassLabel(cls)} ({count.toLocaleString(locale)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={stateFilter}
                    onValueChange={(value) => {
                      setStateFilter(value as StateFilter)
                      setOffset(0)
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="min-w-36 flex-1 sm:w-40 sm:flex-none"
                      aria-label={t('knowledgeAdmin.stateFilterLabel')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>{t('knowledgeAdmin.stateAll')}</SelectItem>
                      <SelectItem value="issues">{t('knowledgeAdmin.stateIssues')}</SelectItem>
                      <SelectItem value="pending">{t('knowledgeAdmin.statePending')}</SelectItem>
                    </SelectContent>
                  </Select>
                </>
              }
              actions={toolbarActions}
            />
          ) : null}

          {canManage ? (
            <KnowledgeUploadPanel
              open={uploadOpen}
              isUploading={isUploading}
              isBusy={isBusy}
              onFile={handleUpload}
              items={ingest.items}
              timedOut={ingest.timedOut}
              onRearm={() => {
                ingest.rearm()
                void load()
              }}
              missing={ingest.missing}
              onDismissMissing={ingest.dismissMissing}
              lastUpload={lastUpload}
            />
          ) : null}

          {!hasDocuments ? null : filtered.length === 0 ? (
            <EmptyState
              variant="bare"
              icon={FileText}
              title={t('knowledge.noMatch')}
              action={
                <Button variant="outline" size="sm" onClick={clearFilters}>
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
                      {canManage ? (
                        <TableHead className="w-10">
                          <Checkbox
                            // A partial page selection reads as indeterminate, not as nothing.
                            checked={
                              allOnPageSelected
                                ? true
                                : someOnPageSelected
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
                      ) : null}
                      {sortableHead('document', t('knowledgeAdmin.colDocument'))}
                      {sortableHead('class', t('knowledgeAdmin.colType'))}
                      {sortableHead('state', t('knowledgeAdmin.colState'))}
                      {sortableHead('chunks', t('knowledgeAdmin.colChunks'), 'text-right')}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {page.map((file) => {
                      const isSelected = selected.includes(file.fileName)
                      return (
                        <TableRow
                          key={file.fileName}
                          data-state={isSelected ? 'selected' : undefined}
                          className="cursor-pointer"
                          onClick={() => setDetailName(file.fileName)}
                        >
                          {canManage ? (
                            <TableCell onClick={(event) => event.stopPropagation()}>
                              <Checkbox
                                checked={isSelected}
                                aria-label={t('knowledgeAdmin.selectRow', { name: file.fileName })}
                                onCheckedChange={(checked) =>
                                  setSelected((prev) =>
                                    checked
                                      ? [...prev, file.fileName]
                                      : prev.filter((name) => name !== file.fileName)
                                  )
                                }
                              />
                            </TableCell>
                          ) : null}
                          <TableCell className="max-w-[22rem]">
                            <button
                              type="button"
                              className="pointer-coarse:min-h-11 focus-visible:ring-ring/60 block w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2"
                              aria-label={t('knowledgeAdmin.openDetail', { name: file.fileName })}
                              onClick={(event) => {
                                event.stopPropagation()
                                setDetailName(file.fileName)
                              }}
                            >
                              <span className="text-foreground block truncate text-sm font-medium">
                                {file.displayTitle ?? file.fileName}
                              </span>
                              {file.displayTitle && file.displayTitle !== file.fileName ? (
                                <span className="text-muted-foreground block truncate text-xs">
                                  {file.fileName}
                                </span>
                              ) : null}
                            </button>
                          </TableCell>
                          <TableCell>
                            <DocClassChip docClass={file.docClass} />
                          </TableCell>
                          <TableCell>
                            <KnowledgeStateBadge state={file.state} hint="tooltip" />
                          </TableCell>
                          <TableCell className="text-muted-foreground text-right text-sm tabular-nums">
                            {file.chunkCount > 0 ? file.chunkCount.toLocaleString(locale) : '–'}
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
                rangeLabel={(from, to, total) =>
                  t('knowledgeAdmin.range', {
                    from: from.toLocaleString(locale),
                    to: to.toLocaleString(locale),
                    total: total.toLocaleString(locale),
                  })
                }
                previousLabel={t('knowledgeAdmin.previous')}
                nextLabel={t('knowledgeAdmin.next')}
              />
            </>
          )}
        </div>
      </SectionCard>

      <KnowledgeDocumentSheet
        file={detailFile}
        onClose={() => setDetailName(null)}
        canManage={canManage}
        onRename={handleRename}
        onReclassify={handleReclassify}
        onView={(file) => {
          // Close the sheet first: stacking two modal focus traps strands keyboard users.
          setDetailName(null)
          setViewerFile(file.fileName)
        }}
        onDelete={(file) => {
          setDetailName(null)
          setPendingDelete([file])
        }}
      />

      {viewerFile ? (
        <PdfViewerDialog
          open
          onOpenChange={(open) => !open && setViewerFile(null)}
          fileName={viewerFile}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDelete.length > 0}
        onOpenChange={(open) => {
          if (!open) setPendingDelete([])
        }}
        title={
          pendingDelete.length > 1
            ? t('knowledgeAdmin.bulkDeleteTitle', { count: pendingDelete.length })
            : t('knowledge.deleteTitle', { name: pendingDelete[0]?.fileName ?? '' })
        }
        description={
          pendingDelete.length > 1
            ? t('knowledgeAdmin.bulkDeleteDescription')
            : t('knowledge.deleteDescription')
        }
        confirmLabel={
          pendingDelete.length > 1
            ? t('knowledgeAdmin.bulkDeleteConfirm', { count: pendingDelete.length })
            : t('knowledge.deleteConfirm')
        }
        cancelLabel={t('knowledge.deleteCancel')}
        tone="destructive"
        pending={isDeleting}
        onConfirm={handleDelete}
      >
        {pendingDelete.length > 1 ? (
          <NameList names={pendingDelete.map((f) => f.fileName)} />
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingReingest.length > 0}
        onOpenChange={(open) => {
          if (!open) setPendingReingest([])
        }}
        title={t('knowledgeAdmin.reingestConfirmTitle', { count: pendingReingest.length })}
        description={t('knowledgeAdmin.reingestConfirmDescription')}
        confirmLabel={t('knowledgeAdmin.reingestConfirmCta', { count: pendingReingest.length })}
        cancelLabel={t('knowledge.deleteCancel')}
        tone="warning"
        icon={RotateCcw}
        onConfirm={handleReingest}
        pending={false}
        confirmTestId="knowledge-reingest-confirm"
      >
        <div className="flex flex-col gap-3">
          <NameList names={pendingReingest} />
          <CostNote>{t('knowledgeAdmin.reingestConfirmCost')}</CostNote>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={syncConfirmOpen}
        onOpenChange={setSyncConfirmOpen}
        title={t('knowledgeAdmin.syncConfirmTitle')}
        description={t('knowledgeAdmin.syncConfirmDescription')}
        confirmLabel={t('knowledgeAdmin.syncConfirmCta')}
        cancelLabel={t('knowledge.deleteCancel')}
        tone="warning"
        icon={RefreshCw}
        onConfirm={handleSync}
        pending={false}
        confirmTestId="knowledge-sync-confirm"
      >
        <CostNote>{t('knowledgeAdmin.syncConfirmCost')}</CostNote>
      </ConfirmDialog>
    </div>
  )
}

/**
 * The four numbers that answer "is the base corpus healthy?". Skeletons of the
 * same box on the first load; nothing when the load failed (the card below
 * carries the error and the retry).
 */
function KnowledgeSummary({
  status,
  files,
  loading,
}: {
  status: KnowledgeBaseStatus | null
  files: readonly KnowledgeFile[]
  loading: boolean
}): JSX.Element | null {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden>
        {Array.from({ length: 4 }, (_, index) => (
          <StatCardSkeleton key={index} />
        ))}
      </div>
    )
  }
  if (!status) return null
  const { summary } = status
  const n = (value: number): string => value.toLocaleString(locale)
  const binding = files.filter((f) => isOibBinding(f.docClass)).length
  const issues = summary.failed + summary.inconsistent + summary.stale + summary.removed
  const pct = summary.totalFiles > 0 ? Math.round((summary.ingested / summary.totalFiles) * 100) : 0

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="knowledge-summary">
      <StatCard
        icon={<FileText aria-hidden />}
        label={t('knowledgeAdmin.summaryDocuments')}
        value={n(summary.totalFiles)}
        hint={t('knowledgeAdmin.summaryDocumentsHint', { count: n(binding) })}
      />
      <StatCard
        icon={<CheckCircle2 aria-hidden />}
        label={t('knowledgeAdmin.summaryIndexed')}
        value={n(summary.ingested)}
        hint={
          summary.pending > 0
            ? t('knowledgeAdmin.summaryIndexedPending', { count: n(summary.pending) })
            : t('knowledgeAdmin.summaryIndexedHint', { pct: n(pct) })
        }
      />
      <StatCard
        icon={<Layers aria-hidden />}
        label={t('knowledgeAdmin.summaryChunks')}
        value={n(summary.totalChunks)}
        hint={t('knowledgeAdmin.summaryChunksHint')}
      />
      <StatCard
        icon={<AlertTriangle aria-hidden />}
        label={t('knowledgeAdmin.summaryIssues')}
        value={n(issues)}
        hint={
          issues > 0 ? t('knowledgeAdmin.summaryIssuesHint') : t('knowledgeAdmin.summaryIssuesNone')
        }
        data-testid="knowledge-summary-issues"
      />
    </div>
  )
}

/** The targets of a bulk confirm, by name, capped with "and N more". */
function NameList({ names }: { names: readonly string[] }): JSX.Element {
  const t = useTranslations('platform')
  const shown = names.slice(0, CONFIRM_LIST_MAX)
  const rest = names.length - shown.length
  return (
    <ul className="flex flex-col gap-0.5" data-testid="confirm-name-list">
      {shown.map((name) => (
        <li key={name} className="text-foreground truncate font-mono text-xs">
          {name}
        </li>
      ))}
      {rest > 0 ? (
        <li className="text-xs">{t('knowledgeAdmin.reingestConfirmMore', { count: rest })}</li>
      ) : null}
    </ul>
  )
}

/** What a confirmed action costs, stated before the click. */
function CostNote({ children }: { children: string }): JSX.Element {
  return (
    <Alert variant="warning">
      <AlertTriangle aria-hidden />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}
