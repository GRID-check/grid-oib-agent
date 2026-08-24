'use client'

/**
 * Platform norm catalog (ADR-0016 companion) — the curated pointers to Austrian
 * building law the agent cites.
 *
 * Built on the shared admin primitives: SectionCard chrome, a DataToolbar
 * (search + rank / scope / open-review filters), a Table of entries, and a
 * Sheet holding the editor for the one entry in hand. The editor itself is a
 * guided flow and lives in `./norm-entry-editor`.
 *
 * Why this is not a per-row CRUD list: the backend persists the catalog as ONE
 * file guarded by an optimistic-concurrency version. So edits accumulate in
 * local state and a single Save PUTs the whole registry under the version we
 * loaded. A 409 means somebody else wrote in the meantime — we then stop
 * offering Save entirely until the user reloads, because re-sending our copy
 * would overwrite a registry they have never seen.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertCircle,
  BadgeCheck,
  BookMarked,
  CircleAlert,
  ClipboardList,
  Plus,
  RotateCcw,
  Save,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DataToolbar } from '@/components/ui/data-toolbar'
import { EmptyState } from '@/components/ui/empty-state'
import { Pagination } from '@/components/ui/pagination'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SectionCard } from '@/features/platform/components/section-card'
import { emptyEntry, isStale, NormEntryEditor } from '@/features/platform/components/norm-entry-editor'
import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n'
import {
  NORM_RANKS,
  type NormEntry,
  type NormRegistryEnvelope,
  type NormsFile,
} from '@/lib/norms/schemas'

/* ---------------------------------------------------------------------------
 * Constants + helpers
 * ------------------------------------------------------------------------- */

const PAGE_SIZE = 10

/** Sentinel filter values — '' is a real scope (federal law), so it cannot mean "all". */
const ALL = '__all__'
const FEDERAL = '__federal__'

/** Host of a plain source URL, e.g. 'www.wien.gv.at', or '' when unparseable. */
function sourceHost(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  try {
    return new URL(trimmed).host
  } catch {
    return trimmed
  }
}

const hasReview = (entry: NormEntry): boolean => (entry.review_note ?? '').trim().length > 0

/**
 * Legal lane of an entry, as a sort key. The old surface rendered one section
 * per lane; the table keeps that reading order (federal law, then the states
 * alphabetically, then authority information, then external norms) while the
 * rank and scope columns carry the label that the section heading used to.
 */
function laneOrder(entry: NormEntry): number {
  if (entry.rank === 'behoerdliche_info') return 2
  if (entry.rank === 'norm_extern') return 3
  return entry.bundesland.trim() ? 1 : 0
}

function compareEntries(a: NormEntry, b: NormEntry): number {
  const lane = laneOrder(a) - laneOrder(b)
  if (lane !== 0) return lane
  const land = a.bundesland.trim().localeCompare(b.bundesland.trim(), 'de')
  if (land !== 0) return land
  return a.short.localeCompare(b.short, 'de')
}

function matchesQuery(entry: NormEntry, query: string): boolean {
  if (!query) return true
  const haystack = [
    entry.id,
    entry.short,
    entry.title,
    entry.document_number,
    entry.bundesland,
    entry.application,
    ...entry.topics,
    ...entry.aliases,
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(query)
}

/* ---------------------------------------------------------------------------
 * Main component
 * ------------------------------------------------------------------------- */

interface EditorTarget {
  entry: NormEntry
  originalId: string | null
}

export function NormRegistry(): JSX.Element {
  const t = useTranslations('platform')

  const [entries, setEntries] = useState<NormEntry[]>([])
  const [version, setVersion] = useState<number>(0)
  // Preserved verbatim across the PUT round-trip; not editable in the UI.
  const [corpusCollection, setCorpusCollection] = useState('oib_knowledge')
  // CountryProfile data overrides — no UI surface, but must not be dropped on
  // PUT (a country-#2 registry carries these; see country_profile.py).
  type ProfileOverrides = Pick<NormsFile, 'language' | 'states' | 'corpus_note' | 'doctrine' | 'parcel_tags'>
  const [overrides, setOverrides] = useState<ProfileOverrides>({
    language: '',
    states: {},
    corpus_note: '',
    doctrine: '',
    parcel_tags: [],
  })
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [rankFilter, setRankFilter] = useState<string>(ALL)
  const [scopeFilter, setScopeFilter] = useState<string>(ALL)
  const [onlyReviews, setOnlyReviews] = useState(false)
  const [offset, setOffset] = useState(0)

  const load = useCallback(() => {
    setIsLoading(true)
    setHasError(false)
    setConflict(false)
    return fetch('/api/platform/norms')
      .then((r) => {
        if (!r.ok) throw new Error(`Load failed (${r.status})`)
        return r.json() as Promise<NormRegistryEnvelope>
      })
      .then((data) => {
        setEntries(data.registry.entries)
        setCorpusCollection(data.registry.corpus_collection ?? 'oib_knowledge')
        setOverrides({
          language: data.registry.language ?? '',
          states: data.registry.states ?? {},
          corpus_note: data.registry.corpus_note ?? '',
          doctrine: data.registry.doctrine ?? '',
          parcel_tags: data.registry.parcel_tags ?? [],
        })
        setVersion(data.version)
        setDirty(false)
      })
      .catch(() => {
        setEntries([])
        setHasError(true)
      })
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const otherIds = useCallback(
    (originalId: string | null) => new Set(entries.filter((e) => e.id !== originalId).map((e) => e.id)),
    [entries],
  )

  const handleSaveEntry = useCallback((originalId: string | null, entry: NormEntry) => {
    setEntries((prev) => {
      if (originalId && prev.some((e) => e.id === originalId)) {
        return prev.map((e) => (e.id === originalId ? entry : e))
      }
      return [...prev, entry]
    })
    setDirty(true)
    setEditor(null)
  }, [])

  const handleDelete = useCallback((id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id))
    setDirty(true)
    setPendingDelete(null)
    setEditor(null)
  }, [])

  const handleSave = useCallback(() => {
    // A held version we know to be stale must never be written back.
    if (conflict) return
    setIsSaving(true)
    fetch('/api/platform/norms', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version,
        registry: { version: 1, corpus_collection: corpusCollection, ...overrides, entries },
      }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}))
        if (r.status === 409) {
          setConflict(true)
          toast.error(t('norms.conflict.toast'))
          return
        }
        if (r.status === 422 || r.status === 400) {
          toast.error(body?.error ?? t('norms.invalid'))
          return
        }
        if (!r.ok) throw new Error(`Save failed (${r.status})`)
        if (typeof body?.version === 'number') setVersion(body.version)
        setDirty(false)
        toast.success(t('norms.saved'))
      })
      .catch(() => toast.error(t('norms.saveError')))
      .finally(() => setIsSaving(false))
  }, [entries, version, corpusCollection, overrides, conflict, t])

  const openReviewCount = useMemo(() => entries.filter(hasReview).length, [entries])

  const scopes = useMemo(() => {
    const lands = new Set<string>()
    for (const entry of entries) {
      const land = entry.bundesland.trim()
      if (land) lands.add(land)
    }
    return [...lands].sort((a, b) => a.localeCompare(b, 'de'))
  }, [entries])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return [...entries]
      .filter((entry) => {
        if (rankFilter !== ALL && entry.rank !== rankFilter) return false
        if (scopeFilter === FEDERAL && entry.bundesland.trim() !== '') return false
        if (scopeFilter !== ALL && scopeFilter !== FEDERAL && entry.bundesland.trim() !== scopeFilter) {
          return false
        }
        if (onlyReviews && !hasReview(entry)) return false
        return matchesQuery(entry, needle)
      })
      .sort(compareEntries)
  }, [entries, query, rankFilter, scopeFilter, onlyReviews])

  // Deleting or filtering can strand the offset past the end of the list.
  const safeOffset = offset >= filtered.length ? 0 : offset
  const page = filtered.slice(safeOffset, safeOffset + PAGE_SIZE)

  const resetPaging = useCallback(() => setOffset(0), [])

  const registryEmpty = !isLoading && !hasError && entries.length === 0 && !conflict

  return (
    <>
      <SectionCard
        testId="norm-registry"
        title={t('norms.title')}
        description={`${t('norms.description')} ${
          entries.length === 1 ? t('norms.entryCountOne') : t('norms.entryCount', { count: entries.length })
        }`}
        loading={isLoading}
        error={!isLoading && hasError}
        errorMessage={t('norms.loadError')}
        onRetry={() => void load()}
        empty={registryEmpty}
        emptyIcon={BookMarked}
        emptyTitle={t('norms.empty.title')}
        emptyDescription={t('norms.empty.description')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {dirty && <Badge variant="warning">{t('norms.unsaved')}</Badge>}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditor({ entry: emptyEntry(), originalId: null })}
            >
              <Plus className="size-3.5" aria-hidden />
              {t('norms.add')}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!dirty || isSaving || conflict}>
              {isSaving ? <Spinner className="size-3.5" /> : <Save className="size-3.5" aria-hidden />}
              {t('norms.save')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          {conflict && (
            <Alert variant="destructive" data-testid="norm-registry-conflict">
              <AlertCircle className="size-4" aria-hidden />
              <AlertTitle>{t('norms.conflict.title')}</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                <span>{t('norms.conflict.description')}</span>
                <Button variant="outline" size="sm" className="w-fit" onClick={() => void load()}>
                  <RotateCcw className="size-3.5" aria-hidden />
                  {t('norms.conflict.reload')}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          <DataToolbar
            searchValue={query}
            onSearchChange={(value) => {
              setQuery(value)
              resetPaging()
            }}
            searchPlaceholder={t('norms.search.placeholder')}
            searchLabel={t('norms.search.label')}
            clearLabel={t('norms.search.clear')}
            filters={
              <>
                <Select
                  value={rankFilter}
                  onValueChange={(value) => {
                    setRankFilter(value)
                    resetPaging()
                  }}
                >
                  <SelectTrigger size="sm" className="w-44" aria-label={t('norms.filters.rank')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>{t('norms.filters.allRanks')}</SelectItem>
                    {NORM_RANKS.map((rank) => (
                      <SelectItem key={rank} value={rank}>
                        {t(`norms.rankShort.${rank}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={scopeFilter}
                  onValueChange={(value) => {
                    setScopeFilter(value)
                    resetPaging()
                  }}
                >
                  <SelectTrigger size="sm" className="w-40" aria-label={t('norms.filters.scope')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>{t('norms.filters.allScopes')}</SelectItem>
                    <SelectItem value={FEDERAL}>{t('norms.federal')}</SelectItem>
                    {scopes.map((land) => (
                      <SelectItem key={land} value={land}>
                        {land}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {openReviewCount > 0 && (
                  // The old surface kept a separate "open reviews" queue card.
                  // As a filter it stays one click away without duplicating the
                  // list — and the count is still visible without opening it.
                  <Button
                    variant={onlyReviews ? 'secondary' : 'outline'}
                    size="sm"
                    aria-pressed={onlyReviews}
                    onClick={() => {
                      setOnlyReviews((prev) => !prev)
                      resetPaging()
                    }}
                  >
                    <ClipboardList className="size-3.5" aria-hidden />
                    {t('norms.filters.reviews', { count: openReviewCount })}
                  </Button>
                )}
              </>
            }
          />

          {filtered.length === 0 ? (
            <EmptyState
              variant="bare"
              icon={BookMarked}
              title={t('norms.noMatches.title')}
              description={t('norms.noMatches.description')}
            />
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('norms.columns.norm')}</TableHead>
                    <TableHead>{t('norms.columns.rank')}</TableHead>
                    <TableHead>{t('norms.columns.scope')}</TableHead>
                    <TableHead>{t('norms.columns.document')}</TableHead>
                    <TableHead>{t('norms.columns.verified')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.map((entry) => (
                    <NormRow
                      key={entry.id}
                      entry={entry}
                      t={t}
                      onOpen={() => setEditor({ entry, originalId: entry.id })}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <Pagination
            offset={safeOffset}
            pageSize={PAGE_SIZE}
            total={filtered.length}
            onOffsetChange={setOffset}
            rangeLabel={(from, to, total) => t('norms.pagination.range', { from, to, total })}
            previousLabel={t('norms.pagination.previous')}
            nextLabel={t('norms.pagination.next')}
          />
        </div>
      </SectionCard>

      <Sheet open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
        <SheetContent className="sm:max-w-xl" closeLabel={t('norms.sheet.close')}>
          {editor && (
            <NormEntryEditor
              key={editor.originalId ?? '__new__'}
              entry={editor.entry}
              originalId={editor.originalId}
              existingIds={otherIds(editor.originalId)}
              onSave={handleSaveEntry}
              onCancel={() => setEditor(null)}
              onRequestDelete={() => editor.originalId && setPendingDelete(editor.originalId)}
              isNew={editor.originalId === null}
              t={t}
            />
          )}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t('norms.delete.title')}
        description={t('norms.delete.description')}
        confirmLabel={t('norms.delete.confirm')}
        cancelLabel={t('norms.delete.cancel')}
        confirmTestId="norm-delete-confirm"
        onConfirm={() => {
          if (pendingDelete) handleDelete(pendingDelete)
        }}
      />
    </>
  )
}

/* ---------------------------------------------------------------------------
 * Table row
 * ------------------------------------------------------------------------- */

function NormRow({
  entry,
  onOpen,
  t,
}: {
  entry: NormEntry
  onOpen: () => void
  t: Translator
}): JSX.Element {
  const stale = isStale(entry.verified_at)
  const review = (entry.review_note ?? '').trim()
  const document = entry.document_number
    ? [entry.application, entry.document_number].filter(Boolean).join(' · ')
    : sourceHost(entry.source_url) || t('norms.row.noFullText')

  return (
    <TableRow>
      <TableCell>
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('norms.row.open', { title: entry.title })}
          className="flex w-full flex-col items-start gap-0.5 text-left hover:underline focus-visible:ring-2 pointer-coarse:min-h-11 focus-visible:ring-ring/60 focus-visible:outline-none"
        >
          <span className="flex items-center gap-2">
            <Badge variant="secondary" className="shrink-0">
              {entry.short}
            </Badge>
            {review && (
              <span
                className="inline-block size-2 shrink-0 rounded-full bg-warning"
                aria-label={t('norms.row.review')}
                title={t('norms.row.review')}
              />
            )}
          </span>
          <span className="block max-w-[22rem] truncate text-sm font-medium">{entry.title}</span>
          {review && (
            <span className="block max-w-[22rem] truncate text-xs text-warning">{review}</span>
          )}
        </button>
      </TableCell>
      <TableCell>
        <Badge variant="outline">{t(`norms.rankShort.${entry.rank}`)}</Badge>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {entry.bundesland.trim() || t('norms.federal')}
      </TableCell>
      <TableCell className="max-w-[16rem] truncate font-mono text-xs text-muted-foreground">
        {document}
      </TableCell>
      <TableCell>
        <Badge
          variant={stale ? 'warning' : 'outline'}
          className="gap-1"
          title={stale ? t('norms.row.staleHint') : t('norms.row.verifiedHint')}
        >
          {stale ? <CircleAlert className="size-3" aria-hidden /> : <BadgeCheck className="size-3" aria-hidden />}
          {entry.verified_at.trim() || t('norms.row.unverified')}
        </Badge>
      </TableCell>
    </TableRow>
  )
}
