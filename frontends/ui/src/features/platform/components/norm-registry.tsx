'use client'

/**
 * Platform norm catalog (ADR-0016 companion) — the curated pointers to Austrian
 * building law the agent cites.
 *
 * Built on the shared admin primitives: SectionCard chrome, a DataToolbar
 * (search + rank / scope / open-review filters), a Table of entries, and a
 * Sheet holding the editor for the one entry in hand.
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
import { z } from 'zod'
import {
  AlertCircle,
  BadgeCheck,
  BookMarked,
  CircleAlert,
  ClipboardList,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
} from 'lucide-react'
import { useAppForm } from '@/components/form'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DataToolbar } from '@/components/ui/data-toolbar'
import { EmptyState } from '@/components/ui/empty-state'
import { Pagination } from '@/components/ui/pagination'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SectionCard } from '@/features/platform/components/section-card'
import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n'
import {
  isLawRank,
  NORM_RANKS,
  type NormEntry,
  type NormRank,
  type NormRegistryEnvelope,
  type NormsFile,
  type VerifyCandidate,
  type VerifyNormResponse,
} from '@/lib/norms/schemas'

/* ---------------------------------------------------------------------------
 * Constants + helpers
 * ------------------------------------------------------------------------- */

const STALE_AFTER_MS = 365 * 24 * 60 * 60 * 1000
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

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const joinList = (value: string[] | undefined): string => (value ?? []).join(', ')

/** True when a verified_at date is missing or older than 12 months. */
function isStale(verifiedAt: string): boolean {
  if (!verifiedAt.trim()) return true
  const time = Date.parse(verifiedAt)
  if (Number.isNaN(time)) return true
  return Date.now() - time > STALE_AFTER_MS
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
 * Editor form <-> entry mapping
 * ------------------------------------------------------------------------- */

interface EntryFormValues {
  id: string
  title: string
  short: string
  rank: NormRank
  bundesland: string
  topics: string
  relevance: string
  application: string
  document_number: string
  source_url: string
  citation_url: string
  full_law_url: string
  aliases: string
  binding_note: string
  review_note: string
  verify_title_query: string
  verify_expect: string
  verify_exclude: string
  verify_gesetzesnummer: string
  verified_at: string
}

/** Built per render so the "required" message speaks the reader's language. */
function createEntryFormSchema(t: Translator) {
  const required = t('norms.errors.required')
  return z.object({
    id: z.string().min(1, required),
    title: z.string().min(1, required),
    short: z.string().min(1, required),
    rank: z.enum(NORM_RANKS),
    bundesland: z.string(),
    topics: z.string(),
    relevance: z.string(),
    application: z.string(),
    document_number: z.string(),
    source_url: z.string(),
    citation_url: z.string(),
    full_law_url: z.string(),
    aliases: z.string(),
    binding_note: z.string(),
    review_note: z.string(),
    verify_title_query: z.string(),
    verify_expect: z.string(),
    verify_exclude: z.string(),
    verify_gesetzesnummer: z.string(),
    verified_at: z.string(),
  })
}

function entryToForm(entry: NormEntry): EntryFormValues {
  return {
    id: entry.id,
    title: entry.title,
    short: entry.short,
    rank: entry.rank,
    bundesland: entry.bundesland,
    topics: joinList(entry.topics),
    relevance: entry.relevance,
    application: entry.application,
    document_number: entry.document_number,
    source_url: entry.source_url,
    citation_url: entry.citation_url,
    full_law_url: entry.full_law_url,
    aliases: joinList(entry.aliases),
    binding_note: entry.binding_note ?? '',
    review_note: entry.review_note ?? '',
    verify_title_query: entry.verify?.title_query ?? '',
    verify_expect: entry.verify?.expect ?? '',
    verify_exclude: joinList(entry.verify?.exclude),
    verify_gesetzesnummer: entry.verify?.gesetzesnummer ?? '',
    verified_at: entry.verified_at,
  }
}

function formToEntry(values: EntryFormValues): NormEntry {
  const titleQuery = values.verify_title_query.trim()
  const exclude = splitList(values.verify_exclude)
  const expect = values.verify_expect.trim()
  const gesetzesnummer = values.verify_gesetzesnummer.trim()
  const verify = titleQuery
    ? {
        title_query: titleQuery,
        exclude,
        ...(expect ? { expect } : {}),
        ...(gesetzesnummer ? { gesetzesnummer } : {}),
      }
    : undefined
  const bindingNote = values.binding_note.trim()
  const reviewNote = values.review_note.trim()
  return {
    id: values.id.trim(),
    title: values.title.trim(),
    short: values.short.trim(),
    rank: values.rank,
    bundesland: values.bundesland.trim(),
    topics: splitList(values.topics),
    relevance: values.relevance.trim(),
    application: values.application.trim(),
    document_number: values.document_number.trim(),
    source_url: values.source_url.trim(),
    citation_url: values.citation_url.trim(),
    full_law_url: values.full_law_url.trim(),
    aliases: splitList(values.aliases),
    ...(bindingNote ? { binding_note: bindingNote } : {}),
    ...(reviewNote ? { review_note: reviewNote } : {}),
    ...(verify ? { verify } : {}),
    verified_at: values.verified_at.trim(),
  }
}

function emptyEntry(): NormEntry {
  return {
    id: '',
    title: '',
    short: '',
    rank: 'bundesgesetz',
    bundesland: '',
    topics: [],
    relevance: '',
    application: '',
    document_number: '',
    source_url: '',
    citation_url: '',
    full_law_url: '',
    aliases: [],
    verified_at: '',
  }
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
            <NormEditor
              key={editor.originalId ?? '__new__'}
              target={editor}
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
          className="flex w-full flex-col items-start gap-0.5 text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
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

/* ---------------------------------------------------------------------------
 * Sheet editor
 * ------------------------------------------------------------------------- */

interface DiffHint {
  field: string
  from: string
  to: string
}

function NormEditor({
  target,
  existingIds,
  onSave,
  onCancel,
  onRequestDelete,
  isNew,
  t,
}: {
  target: EditorTarget
  existingIds: Set<string>
  onSave: (originalId: string | null, entry: NormEntry) => void
  onCancel: () => void
  onRequestDelete: () => void
  isNew: boolean
  t: Translator
}): JSX.Element {
  const [candidates, setCandidates] = useState<VerifyCandidate[] | null>(null)
  const [isVerifying, setIsVerifying] = useState(false)
  const [diff, setDiff] = useState<DiffHint[]>([])
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null)

  const form = useAppForm({
    defaultValues: entryToForm(target.entry),
    validators: { onChange: createEntryFormSchema(t) },
    onSubmit: ({ value }) => {
      const entry = formToEntry(value)
      if (existingIds.has(entry.id)) {
        toast.error(t('norms.errors.duplicateId', { id: entry.id }))
        return
      }
      if (isLawRank(entry.rank) && (!entry.application || !entry.document_number)) {
        toast.error(t('norms.errors.lawNeedsRis'))
        return
      }
      onSave(target.originalId, entry)
    },
  })

  const handleVerify = useCallback(() => {
    const values = form.state.values
    const titleQuery = values.verify_title_query.trim() || values.title.trim()
    const application = values.application.trim()
    if (!titleQuery || !application) {
      toast.error(t('norms.verify.missingInput'))
      return
    }
    setIsVerifying(true)
    setCandidates(null)
    const exclude = splitList(values.verify_exclude)
    const gesetzesnummer = values.verify_gesetzesnummer.trim()
    const expect = values.verify_expect.trim()
    fetch('/api/platform/norms/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title_query: titleQuery,
        application,
        ...(values.bundesland.trim() ? { bundesland: values.bundesland.trim() } : {}),
        ...(expect ? { expect } : {}),
        ...(exclude.length ? { exclude } : {}),
        ...(gesetzesnummer ? { gesetzesnummer } : {}),
      }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Verification failed (${r.status})`)
        return r.json() as Promise<VerifyNormResponse>
      })
      .then((data) => {
        setCandidates(data.candidates)
        setVerifiedAt(data.verified_at)
        if (data.candidates.length === 0) toast.info(t('norms.verify.noHits'))
      })
      .catch(() => toast.error(t('norms.verify.failed')))
      .finally(() => setIsVerifying(false))
  }, [form, t])

  const applyCandidate = useCallback(
    (candidate: VerifyCandidate) => {
      const values = form.state.values
      const nextVerifiedAt = verifiedAt ?? values.verified_at
      const nextDiff: DiffHint[] = [
        { field: 'document_number', from: values.document_number, to: candidate.document_number },
        { field: 'citation_url', from: values.citation_url, to: candidate.citation_url },
        { field: 'full_law_url', from: values.full_law_url, to: candidate.full_law_url },
        { field: 'verified_at', from: values.verified_at, to: nextVerifiedAt },
      ].filter((d) => d.from !== d.to)
      form.setFieldValue('document_number', candidate.document_number)
      form.setFieldValue('citation_url', candidate.citation_url)
      form.setFieldValue('full_law_url', candidate.full_law_url)
      form.setFieldValue('verified_at', nextVerifiedAt)
      setDiff(nextDiff)
      setCandidates(null)
      toast.success(t('norms.verify.applied'))
    },
    [form, verifiedAt, t],
  )

  const rankOptions = NORM_RANKS.map((value) => ({ value, label: t(`norms.ranks.${value}`) }))

  return (
    <>
      <SheetHeader>
        <SheetTitle>{isNew ? t('norms.sheet.newTitle') : t('norms.sheet.editTitle')}</SheetTitle>
        <SheetDescription>{t('norms.sheet.description')}</SheetDescription>
      </SheetHeader>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          event.stopPropagation()
          form.handleSubmit()
        }}
        className="flex flex-col gap-4"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <form.AppField name="id">
            {(field) => (
              <field.TextField
                label={t('norms.fields.id')}
                required
                placeholder={t('norms.fields.idPlaceholder')}
                disabled={!isNew}
              />
            )}
          </form.AppField>
          <form.AppField name="short">
            {(field) => (
              <field.TextField
                label={t('norms.fields.short')}
                required
                placeholder={t('norms.fields.shortPlaceholder')}
              />
            )}
          </form.AppField>
        </div>

        <form.AppField name="title">
          {(field) => (
            <field.TextField
              label={t('norms.fields.title')}
              required
              placeholder={t('norms.fields.titlePlaceholder')}
            />
          )}
        </form.AppField>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <form.AppField name="rank">
            {(field) => <field.SelectField label={t('norms.fields.rank')} options={rankOptions} />}
          </form.AppField>
          <form.AppField name="bundesland">
            {(field) => (
              <field.TextField
                label={t('norms.fields.bundesland')}
                description={t('norms.fields.bundeslandHint')}
                placeholder={t('norms.fields.bundeslandPlaceholder')}
              />
            )}
          </form.AppField>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <form.AppField name="application">
            {(field) => (
              <field.TextField
                label={t('norms.fields.application')}
                placeholder={t('norms.fields.applicationPlaceholder')}
              />
            )}
          </form.AppField>
          <form.AppField name="relevance">
            {(field) => (
              <field.TextField
                label={t('norms.fields.relevance')}
                placeholder={t('norms.fields.relevancePlaceholder')}
              />
            )}
          </form.AppField>
        </div>

        <form.AppField name="topics">
          {(field) => (
            <field.TextField
              label={t('norms.fields.topics')}
              description={t('norms.fields.topicsHint')}
              placeholder={t('norms.fields.topicsPlaceholder')}
            />
          )}
        </form.AppField>

        <form.AppField name="aliases">
          {(field) => (
            <field.TextField
              label={t('norms.fields.aliases')}
              description={t('norms.fields.aliasesHint')}
              placeholder={t('norms.fields.aliasesPlaceholder')}
            />
          )}
        </form.AppField>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <form.AppField name="document_number">
            {(field) => (
              <field.TextField
                label={t('norms.fields.documentNumber')}
                placeholder={t('norms.fields.documentNumberPlaceholder')}
              />
            )}
          </form.AppField>
          <form.AppField name="verified_at">
            {(field) => (
              <field.TextField
                label={t('norms.fields.verifiedAt')}
                placeholder={t('norms.fields.verifiedAtPlaceholder')}
              />
            )}
          </form.AppField>
        </div>

        <form.AppField name="citation_url">
          {(field) => (
            <field.TextField
              label={t('norms.fields.citationUrl')}
              placeholder={t('norms.fields.urlPlaceholder')}
            />
          )}
        </form.AppField>

        <form.AppField name="full_law_url">
          {(field) => (
            <field.TextField
              label={t('norms.fields.fullLawUrl')}
              placeholder={t('norms.fields.urlPlaceholder')}
            />
          )}
        </form.AppField>

        <form.AppField name="source_url">
          {(field) => (
            <field.TextField
              label={t('norms.fields.sourceUrl')}
              description={t('norms.fields.sourceUrlHint')}
              placeholder={t('norms.fields.urlPlaceholder')}
            />
          )}
        </form.AppField>

        <form.AppField name="binding_note">
          {(field) => (
            <field.TextAreaField
              label={t('norms.fields.bindingNote')}
              description={t('norms.fields.bindingNoteHint')}
              rows={2}
            />
          )}
        </form.AppField>

        <form.AppField name="review_note">
          {(field) => (
            <field.TextAreaField
              label={t('norms.fields.reviewNote')}
              description={t('norms.fields.reviewNoteHint')}
              rows={2}
            />
          )}
        </form.AppField>

        {/* RIS verification — only the three RIS-backed law ranks have a pointer
            to verify; the other two are plain links. */}
        <form.Subscribe selector={(state) => state.values.rank}>
          {(rank) =>
            isLawRank(rank) ? (
              <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium">{t('norms.verify.title')}</span>
                    <span className="text-xs text-muted-foreground">{t('norms.verify.hint')}</span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleVerify}
                    disabled={isVerifying}
                  >
                    {isVerifying ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <Search className="size-3.5" aria-hidden />
                    )}
                    {t('norms.verify.action')}
                  </Button>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <form.AppField name="verify_title_query">
                    {(field) => (
                      <field.TextField
                        label={t('norms.fields.titleQuery')}
                        placeholder={t('norms.fields.titleQueryPlaceholder')}
                      />
                    )}
                  </form.AppField>
                  <form.AppField name="verify_gesetzesnummer">
                    {(field) => (
                      <field.TextField
                        label={t('norms.fields.gesetzesnummer')}
                        placeholder={t('norms.fields.optional')}
                      />
                    )}
                  </form.AppField>
                  <form.AppField name="verify_expect">
                    {(field) => (
                      <field.TextField
                        label={t('norms.fields.expect')}
                        placeholder={t('norms.fields.optional')}
                      />
                    )}
                  </form.AppField>
                  <form.AppField name="verify_exclude">
                    {(field) => (
                      <field.TextField
                        label={t('norms.fields.exclude')}
                        placeholder={t('norms.fields.excludePlaceholder')}
                      />
                    )}
                  </form.AppField>
                </div>

                {candidates !== null && (
                  <div
                    className="divide-y divide-border overflow-hidden rounded-lg border bg-popover"
                    data-testid="norm-verify-candidates"
                  >
                    {candidates.length === 0 ? (
                      <p className="px-3 py-2 text-sm text-muted-foreground">
                        {t('norms.verify.noCandidates')}
                      </p>
                    ) : (
                      candidates.map((candidate) => (
                        <button
                          key={`${candidate.document_number}:${candidate.citation_url}`}
                          type="button"
                          onClick={() => applyCandidate(candidate)}
                          aria-label={t('norms.verify.candidate', { title: candidate.title })}
                          className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
                        >
                          <span className="text-sm">{candidate.title}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {candidate.document_number}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                )}

                {diff.length > 0 && (
                  <div className="flex flex-col gap-1 rounded-lg border border-info/40 bg-info-subtle/40 p-2 text-xs">
                    <span className="font-medium text-info">{t('norms.verify.appliedTitle')}</span>
                    {diff.map((d) => (
                      <span key={d.field} className="font-mono text-muted-foreground">
                        {d.field}: {d.from || '—'} → {d.to || '—'}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t('norms.verify.notInRis')}</p>
            )
          }
        </form.Subscribe>

        <SheetFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          {!isNew ? (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={onRequestDelete}
            >
              <Trash2 className="size-3.5" aria-hidden />
              {t('norms.sheet.delete')}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              {t('norms.sheet.cancel')}
            </Button>
            <form.AppForm>
              <form.SubmitButton>{t('norms.sheet.apply')}</form.SubmitButton>
            </form.AppForm>
          </div>
        </SheetFooter>
      </form>
    </>
  )
}
