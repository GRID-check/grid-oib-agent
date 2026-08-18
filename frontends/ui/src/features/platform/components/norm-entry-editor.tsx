'use client'

/**
 * Norm entry authoring — the guided flow behind the catalog's editing Sheet.
 *
 * Why this is a flow and not a form dump: an entry carries ~15 stored fields,
 * but which of them are meaningful (and which are legally required) is decided
 * entirely by ONE choice — the rank. A federal act is identified by a RIS
 * pointer the operator must never type by hand; an MA-37 leaflet has no RIS
 * presence at all and is identified by a plain link. Showing both sets at once
 * is what made the surface unfillable.
 *
 * So the flow asks, in order:
 *   1. What kind of source is this?      → rank, in plain language
 *   2. Find it                            → RIS search + pick (law ranks), or
 *                                           title + source link (non-RIS ranks)
 *   3. How should the agent use it?       → short, topics, relevance, binding_note
 *   Advanced                              → every remaining stored field
 *
 * Nothing is hidden for good: every field the backend persists stays editable
 * under "Advanced", so an entry always round-trips verbatim.
 *
 * @see src/lib/norms/schemas.ts — the field contract this mirrors
 * @see src/aiq_agent/common/norm_registry.py — how entries are consumed
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import {
  BadgeCheck,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useStore } from '@tanstack/react-form'
import { useAppForm } from '@/components/form'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { FieldError } from '@/components/ui/field'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { SectionLabel } from '@/components/ui/section-label'
import { SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { latinize } from '@/lib/text/latinize'
import { cn } from '@/lib/utils'
import type { Translator } from '@/i18n'
import {
  isLawRank,
  NORM_RANKS,
  type NormEntry,
  type NormRank,
  type VerifyCandidate,
  type VerifyNormResponse,
} from '@/lib/norms/schemas'

/* ---------------------------------------------------------------------------
 * Constants + small helpers
 * ------------------------------------------------------------------------- */

/** 12 months — the staleness horizon for a verification date. */
export const STALE_AFTER_MS = 365 * 24 * 60 * 60 * 1000

/** True when a verified_at date is missing or older than 12 months. */
export function isStale(verifiedAt: string): boolean {
  if (!verifiedAt.trim()) return true
  const time = Date.parse(verifiedAt)
  if (Number.isNaN(time)) return true
  return Date.now() - time > STALE_AFTER_MS
}

/**
 * The canonical Bundesland names the backend accepts — a mismatch makes it drop
 * the entry (`norm_registry._validated_entries`). Offered as a datalist rather
 * than a Select so a value we do not know about still round-trips verbatim.
 * Mirrors `BUNDESLAENDER` in src/aiq_agent/common/norm_registry.py.
 */
const BUNDESLAENDER = [
  'Wien',
  'Niederösterreich',
  'Oberösterreich',
  'Steiermark',
  'Kärnten',
  'Salzburg',
  'Tirol',
  'Vorarlberg',
  'Burgenland',
] as const

const BUNDESLAND_LIST_ID = 'norm-bundesland-options'

/**
 * The RIS consolidation application to search in. Only the two consolidated
 * corpora are ever right for a curated law pointer: federal law lives in
 * BrKons, state law in LrKons (see KNOWN_APPLICATIONS in norm_registry.py).
 * An ordinance can be either — the Bundesland decides.
 */
function defaultApplication(rank: NormRank | '', bundesland: string): string {
  if (rank === 'bundesgesetz') return 'BrKons'
  if (rank === 'landesgesetz') return 'LrKons'
  if (rank === 'verordnung') return bundesland.trim() ? 'LrKons' : 'BrKons'
  return ''
}

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const joinList = (value: string[] | undefined): string => (value ?? []).join(', ')

/**
 * Catalog IDs are slugs; deriving one from the short name spares the operator
 * a decision.
 *
 * `latinize` rather than the German table alone: this field is only a
 * suggestion the operator can overwrite, so folding the rest of the accents
 * costs nothing and stops `ÖNORM B 1600 Dvořák` proposing an id with holes in
 * it.
 */
function slugify(value: string): string {
  return latinize(value.trim())
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/* ---------------------------------------------------------------------------
 * Form <-> entry mapping
 * ------------------------------------------------------------------------- */

export interface EntryFormValues {
  id: string
  title: string
  short: string
  /** '' only while a NEW entry still awaits step 1 — the schema rejects it. */
  rank: NormRank | ''
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

/**
 * Built per render so messages speak the reader's language. The per-rank rules
 * live in `superRefine` so they surface INLINE while the operator works, rather
 * than as a rejection at save time. They mirror what the backend enforces:
 * a law rank without application + document_number is dropped on load.
 */
function createEntryFormSchema(t: Translator) {
  const required = t('norms.errors.required')
  return z
    .object({
      id: z.string().min(1, required),
      title: z.string().min(1, required),
      short: z.string().min(1, required),
      rank: z.union([z.enum(NORM_RANKS), z.literal('')]),
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
    .superRefine((values, ctx) => {
      if (values.rank === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rank'], message: t('norms.kinds.required') })
        return
      }
      if (!isLawRank(values.rank)) return
      if (!values.application.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['application'],
          message: t('norms.errors.needApplication'),
        })
      }
      if (!values.document_number.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['document_number'],
          message: t('norms.errors.needDocumentNumber'),
        })
      }
      // A state act without a state cannot be placed in a lane, and the backend
      // drops it outright — so it is a hard requirement, not a nicety.
      if (values.rank === 'landesgesetz' && !values.bundesland.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bundesland'],
          message: t('norms.errors.needBundesland'),
        })
      }
    })
}

export function entryToForm(entry: NormEntry, isNew = false): EntryFormValues {
  return {
    id: entry.id,
    title: entry.title,
    short: entry.short,
    // A new entry starts with NO kind so step 1 is a real decision.
    rank: isNew ? '' : entry.rank,
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

export function formToEntry(values: EntryFormValues): NormEntry {
  const titleQuery = values.verify_title_query.trim()
  const exclude = splitList(values.verify_exclude)
  const expect = values.verify_expect.trim()
  const gesetzesnummer = values.verify_gesetzesnummer.trim()
  // Any populated verification field is worth persisting on its own: the seed
  // schema defaults `title_query` to '', so keying the whole object off the
  // query would silently drop a curated expect/exclude/Gesetzesnummer on save.
  const verify =
    titleQuery || expect || gesetzesnummer || exclude.length > 0
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
    // Submit is blocked while the rank is unset; the fallback only satisfies the type.
    rank: (values.rank || 'bundesgesetz') as NormRank,
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

export function emptyEntry(): NormEntry {
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
 * Layout primitives
 * ------------------------------------------------------------------------- */

function Step({
  index,
  title,
  description,
  children,
  testId,
}: {
  index: number
  title: string
  description?: string
  children: React.ReactNode
  testId?: string
}): JSX.Element {
  return (
    <section className="flex flex-col gap-3" data-testid={testId}>
      <div className="flex items-baseline gap-2">
        <span
          aria-hidden
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground"
        >
          {index}
        </span>
        <div className="flex flex-col gap-0.5">
          <SectionLabel as="h3">{title}</SectionLabel>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
      </div>
      <div className="flex flex-col gap-4 sm:pl-7">{children}</div>
    </section>
  )
}

/** One confirmed fact taken from RIS — read, not maintained. */
function Fact({ label, value, href }: { label: string; value: string; href?: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 break-all font-mono text-xs text-info hover:underline"
        >
          {value}
          <ExternalLink className="size-3 shrink-0" aria-hidden />
        </a>
      ) : (
        <span className="break-all font-mono text-xs">{value || '—'}</span>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * The editor
 * ------------------------------------------------------------------------- */

interface DiffHint {
  field: string
  from: string
  to: string
}

export interface NormEntryEditorProps {
  entry: NormEntry
  originalId: string | null
  existingIds: Set<string>
  onSave: (originalId: string | null, entry: NormEntry) => void
  onCancel: () => void
  onRequestDelete: () => void
  isNew: boolean
  t: Translator
}

export function NormEntryEditor({
  entry,
  originalId,
  existingIds,
  onSave,
  onCancel,
  onRequestDelete,
  isNew,
  t,
}: NormEntryEditorProps): JSX.Element {
  const [candidates, setCandidates] = useState<VerifyCandidate[] | null>(null)
  const [isVerifying, setIsVerifying] = useState(false)
  const [diff, setDiff] = useState<DiffHint[]>([])
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null)
  // A pointer already taken over is shown as fact; searching is one click away.
  const [searching, setSearching] = useState(!entry.document_number.trim())
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const schema = useMemo(() => createEntryFormSchema(t), [t])

  const form = useAppForm({
    defaultValues: entryToForm(entry, isNew),
    validators: { onChange: schema },
    onSubmit: ({ value }) => {
      const next = formToEntry(value)
      // Last line of defence: IDs are the registry's primary key, and the guard
      // has to hold even if the inline hint was scrolled past.
      if (existingIds.has(next.id)) {
        setAdvancedOpen(true)
        toast.error(t('norms.errors.duplicateId', { id: next.id }))
        return
      }
      onSave(originalId, next)
    },
  })

  const rank = useStore(form.store, (state) => state.values.rank)
  const bundesland = useStore(form.store, (state) => state.values.bundesland)
  const shortName = useStore(form.store, (state) => state.values.short)
  const idValue = useStore(form.store, (state) => state.values.id)
  const documentNumber = useStore(form.store, (state) => state.values.document_number)
  const citationUrl = useStore(form.store, (state) => state.values.citation_url)
  const fullLawUrl = useStore(form.store, (state) => state.values.full_law_url)
  const verifiedAtValue = useStore(form.store, (state) => state.values.verified_at)

  const isLaw = rank !== '' && isLawRank(rank)
  const duplicateId = idValue.trim().length > 0 && existingIds.has(idValue.trim())

  /**
   * New entries derive their catalog ID from the short name. `autoIdRef` holds
   * the last value we wrote, so the moment the operator edits the ID by hand in
   * Advanced we stop touching it.
   */
  const autoIdRef = useRef('')
  useEffect(() => {
    if (!isNew) return
    const current = form.state.values.id
    if (current && current !== autoIdRef.current) return
    const next = slugify(shortName)
    autoIdRef.current = next
    if (current !== next) form.setFieldValue('id', next)
  }, [isNew, shortName, form])

  /**
   * The RIS application is derivable from the rank, so the operator never has
   * to know the jargon. Only ever filled when empty — a curated value (or one
   * we do not recognise) is never overwritten.
   */
  useEffect(() => {
    if (rank === '' || !isLawRank(rank)) return
    if (form.state.values.application.trim()) return
    const derived = defaultApplication(rank, form.state.values.bundesland)
    if (derived) form.setFieldValue('application', derived)
  }, [rank, bundesland, form])

  const chooseRank = useCallback(
    (next: NormRank) => {
      form.setFieldValue('rank', next)
      // Re-open the search whenever the kind changes to a RIS rank with no
      // pointer yet — otherwise step 2 would show an empty "confirmed" panel.
      if (isLawRank(next) && !form.state.values.document_number.trim()) setSearching(true)
    },
    [form],
  )

  const handleVerify = useCallback(() => {
    const values = form.state.values
    const titleQuery = values.verify_title_query.trim() || values.title.trim()
    const application = values.application.trim() || defaultApplication(values.rank, values.bundesland)
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
        // The query that produced the hit becomes the stored seed, so the next
        // re-verification a year from now starts from the same place.
        if (!values.verify_title_query.trim()) form.setFieldValue('verify_title_query', titleQuery)
        if (data.candidates.length === 0) toast.info(t('norms.verify.noHits'))
      })
      .catch(() => toast.error(t('norms.verify.failed')))
      .finally(() => setIsVerifying(false))
  }, [form, t])

  const applyCandidate = useCallback(
    (candidate: VerifyCandidate) => {
      const values = form.state.values
      const nextVerifiedAt = verifiedAt ?? values.verified_at
      // The title is only adopted when the entry has none yet: RIS titles carry
      // a "Fassung vom …" suffix, so overwriting a curated title would be a
      // downgrade. On the create flow it is exactly what the operator wants.
      const nextTitle = values.title.trim() ? values.title : candidate.title
      const nextDiff: DiffHint[] = [
        { field: 'title', from: values.title, to: nextTitle },
        { field: 'document_number', from: values.document_number, to: candidate.document_number },
        { field: 'citation_url', from: values.citation_url, to: candidate.citation_url },
        { field: 'full_law_url', from: values.full_law_url, to: candidate.full_law_url },
        { field: 'verified_at', from: values.verified_at, to: nextVerifiedAt },
      ].filter((d) => d.from !== d.to)
      form.setFieldValue('title', nextTitle)
      form.setFieldValue('document_number', candidate.document_number)
      form.setFieldValue('citation_url', candidate.citation_url)
      form.setFieldValue('full_law_url', candidate.full_law_url)
      form.setFieldValue('verified_at', nextVerifiedAt)
      setDiff(nextDiff)
      setCandidates(null)
      setSearching(false)
      toast.success(t('norms.verify.applied'))
    },
    [form, verifiedAt, t],
  )

  const applicationLabel = form.state.values.application.trim() || defaultApplication(rank, bundesland)

  /* ---------------------------------------------------------------- render */

  const bundeslandField = (
    <form.AppField name="bundesland">
      {(field) => (
        <field.TextField
          label={t('norms.fields.bundesland')}
          description={
            rank === 'landesgesetz' ? t('norms.fields.bundeslandRequired') : t('norms.fields.bundeslandHint')
          }
          placeholder={t('norms.fields.bundeslandPlaceholder')}
          required={rank === 'landesgesetz'}
          list={BUNDESLAND_LIST_ID}
        />
      )}
    </form.AppField>
  )

  const titleField = (
    <form.AppField name="title">
      {(field) => (
        <field.TextField
          label={t('norms.fields.title')}
          required
          description={isLaw ? t('norms.fields.titleRisHint') : t('norms.fields.titleHint')}
          placeholder={t('norms.fields.titlePlaceholder')}
        />
      )}
    </form.AppField>
  )

  return (
    <>
      <SheetHeader>
        <SheetTitle>{isNew ? t('norms.sheet.newTitle') : t('norms.sheet.editTitle')}</SheetTitle>
        <SheetDescription>{t('norms.sheet.description')}</SheetDescription>
      </SheetHeader>

      {/* Suggestions for the Bundesland input; free text still round-trips. */}
      <datalist id={BUNDESLAND_LIST_ID}>
        {BUNDESLAENDER.map((land) => (
          <option key={land} value={land} />
        ))}
      </datalist>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          event.stopPropagation()
          form.handleSubmit()
        }}
        className="flex flex-col gap-6"
      >
        {/* ---------------------------------------------- 1 — kind of source */}
        <Step index={1} title={t('norms.kinds.legend')} description={t('norms.kinds.hint')} testId="norm-editor-kind">
          <RadioGroup
            value={rank || undefined}
            onValueChange={(value) => chooseRank(value as NormRank)}
            aria-label={t('norms.kinds.legend')}
            className="flex flex-col gap-1.5"
          >
            {NORM_RANKS.map((value) => {
              const selected = rank === value
              const itemId = `norm-rank-${value}`
              return (
                <label
                  key={value}
                  htmlFor={itemId}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors duration-200 ease-out focus-within:ring-2 focus-within:ring-ring/60',
                    selected ? 'border-primary bg-accent/40' : 'hover:bg-accent/20',
                  )}
                >
                  <RadioGroupItem id={itemId} value={value} className="mt-0.5" />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{t(`norms.kinds.${value}.label`)}</span>
                    <span className="text-xs text-muted-foreground">{t(`norms.kinds.${value}.description`)}</span>
                  </span>
                </label>
              )
            })}
          </RadioGroup>
          {rank === '' && <FieldError>{t('norms.kinds.required')}</FieldError>}
        </Step>

        {rank !== '' && (
          <>
            {/* -------------------------------------------------- 2 — find it */}
            {isLaw ? (
              <Step
                index={2}
                title={t('norms.steps.find')}
                description={t('norms.steps.findHint')}
                testId="norm-editor-find"
              >
                {searching ? (
                  <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-3">
                    <form.AppField name="verify_title_query">
                      {(field) => (
                        <field.TextField
                          label={t('norms.verify.searchLabel')}
                          description={t('norms.verify.searchHint')}
                          placeholder={t('norms.verify.searchPlaceholder')}
                        />
                      )}
                    </form.AppField>

                    {rank !== 'bundesgesetz' && bundeslandField}

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        {t('norms.verify.scope', { application: applicationLabel })}
                      </span>
                      <Button type="button" variant="outline" size="sm" onClick={handleVerify} disabled={isVerifying}>
                        {isVerifying ? <Spinner className="size-3.5" /> : <Search className="size-3.5" aria-hidden />}
                        {t('norms.verify.action')}
                      </Button>
                    </div>

                    {candidates !== null && (
                      <div
                        className="divide-y divide-border overflow-hidden rounded-lg border bg-popover"
                        data-testid="norm-verify-candidates"
                      >
                        {candidates.length === 0 ? (
                          <p className="px-3 py-2 text-sm text-muted-foreground">{t('norms.verify.noCandidates')}</p>
                        ) : (
                          candidates.map((candidate) => (
                            <button
                              key={`${candidate.document_number}:${candidate.citation_url}`}
                              type="button"
                              onClick={() => applyCandidate(candidate)}
                              aria-label={t('norms.verify.candidate', { title: candidate.title })}
                              className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors duration-200 ease-out hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
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
                  </div>
                ) : (
                  <div
                    className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-3"
                    data-testid="norm-editor-confirmed"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium">
                        <BadgeCheck className="size-3.5 text-success" aria-hidden />
                        {t('norms.verify.confirmedTitle')}
                      </span>
                      <Button type="button" variant="outline" size="sm" onClick={() => setSearching(true)}>
                        <Search className="size-3.5" aria-hidden />
                        {t('norms.verify.again')}
                      </Button>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Fact label={t('norms.fields.documentNumber')} value={documentNumber} />
                      <Fact
                        label={t('norms.fields.verifiedAt')}
                        value={verifiedAtValue || t('norms.row.unverified')}
                      />
                      {citationUrl && (
                        <Fact label={t('norms.fields.citationUrl')} value={citationUrl} href={citationUrl} />
                      )}
                      {fullLawUrl && (
                        <Fact label={t('norms.fields.fullLawUrl')} value={fullLawUrl} href={fullLawUrl} />
                      )}
                    </div>
                    {isStale(verifiedAtValue) && (
                      <p className="inline-flex items-center gap-1.5 text-xs font-medium text-warning">
                        <CircleAlert className="size-3.5" aria-hidden />
                        {t('norms.verify.stale')}
                      </p>
                    )}
                  </div>
                )}

                {!documentNumber.trim() && (
                  <p role="alert" className="text-xs font-medium text-destructive" data-testid="norm-editor-ris-missing">
                    {t('norms.errors.lawNeedsRis')}
                  </p>
                )}

                {diff.length > 0 && (
                  // `border-info` / `bg-info-subtle` are static `@utility` blocks in
                  // globals.css with no `--modifier()`, so `border-info/40` and
                  // `bg-info-subtle/40` matched nothing: this "we changed these
                  // fields" panel rendered with no fill and the neutral border, so it
                  // did not read as a callout at all. `-subtle` IS the diluted info
                  // tint — the tokens as defined are the intent.
                  <div className="flex flex-col gap-1 rounded-lg border border-info bg-info-subtle p-2 text-xs">
                    <span className="font-medium text-info">{t('norms.verify.appliedTitle')}</span>
                    {diff.map((d) => (
                      <span key={d.field} className="font-mono break-all text-muted-foreground">
                        {d.field}: {d.from || '—'} → {d.to || '—'}
                      </span>
                    ))}
                  </div>
                )}

                {titleField}
              </Step>
            ) : (
              <Step
                index={2}
                title={t('norms.steps.source')}
                description={t('norms.steps.sourceHint')}
                testId="norm-editor-source"
              >
                <p className="text-xs text-muted-foreground">{t('norms.verify.notInRis')}</p>
                {titleField}
                <form.AppField name="source_url">
                  {(field) => (
                    <field.TextField
                      label={t('norms.fields.sourceUrl')}
                      description={t('norms.fields.sourceUrlHint')}
                      placeholder={t('norms.fields.sourceUrlPlaceholder')}
                    />
                  )}
                </form.AppField>
                {bundeslandField}
              </Step>
            )}

            {/* ------------------------------------------------- 3 — agent use */}
            <Step
              index={3}
              title={t('norms.steps.usage')}
              description={t('norms.steps.usageHint')}
              testId="norm-editor-usage"
            >
              <form.AppField name="short">
                {(field) => (
                  <field.TextField
                    label={t('norms.fields.short')}
                    required
                    description={t('norms.fields.shortHint')}
                    placeholder={t('norms.fields.shortPlaceholder')}
                  />
                )}
              </form.AppField>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <form.AppField name="topics">
                  {(field) => (
                    <field.TextField
                      label={t('norms.fields.topics')}
                      description={t('norms.fields.topicsHint')}
                      placeholder={t('norms.fields.topicsPlaceholder')}
                    />
                  )}
                </form.AppField>
                <form.AppField name="relevance">
                  {(field) => (
                    <field.TextField
                      label={t('norms.fields.relevance')}
                      description={t('norms.fields.relevanceHint')}
                      placeholder={t('norms.fields.relevancePlaceholder')}
                    />
                  )}
                </form.AppField>
              </div>

              {/* Same defect as the applied-diff panel above: `border-info/40` and
                  `bg-info-subtle/30` compiled to nothing, so this binding-note
                  panel had no tint to separate it from the surrounding form. Both
                  call sites picked a different arbitrary alpha (40 / 30) off the
                  same token, which is guesswork rather than a scale — the two now
                  agree on the `-subtle` token. */}
              <div className="flex flex-col gap-1.5 rounded-xl border border-info bg-info-subtle p-3">
                <span className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-info">
                  <Sparkles className="size-3.5" aria-hidden />
                  {t('norms.fields.bindingNoteBadge')}
                </span>
                <form.AppField name="binding_note">
                  {(field) => (
                    <field.TextAreaField
                      label={t('norms.fields.bindingNote')}
                      description={t('norms.fields.bindingNoteHint')}
                      placeholder={t('norms.fields.bindingNotePlaceholder')}
                      rows={3}
                    />
                  )}
                </form.AppField>
              </div>

              <p className="text-xs text-muted-foreground">
                {t('norms.fields.idDerived', { id: idValue || '—' })}
              </p>
              {duplicateId && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {t('norms.errors.duplicateId', { id: idValue.trim() })}
                </p>
              )}
            </Step>

            {/* ---------------------------------------------------- Advanced */}
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="w-fit px-2 text-muted-foreground">
                  <ChevronDown
                    className={cn(
                      'size-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none',
                      advancedOpen && 'rotate-180',
                    )}
                    aria-hidden
                  />
                  {t('norms.steps.advanced')}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col gap-4 pt-3" data-testid="norm-editor-advanced">
                <p className="text-xs text-muted-foreground">{t('norms.steps.advancedHint')}</p>

                <form.AppField name="id">
                  {(field) => (
                    <field.TextField
                      label={t('norms.fields.id')}
                      required
                      description={t('norms.fields.idHint')}
                      placeholder={t('norms.fields.idPlaceholder')}
                      disabled={!isNew}
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

                {/* bundesland lives in step 2 for every rank that can carry one;
                    a federal act still needs it reachable to clear a stale value. */}
                {rank === 'bundesgesetz' && bundeslandField}

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <form.AppField name="application">
                    {(field) => (
                      <field.TextField
                        label={t('norms.fields.application')}
                        description={t('norms.fields.applicationHint')}
                        placeholder={t('norms.fields.applicationPlaceholder')}
                      />
                    )}
                  </form.AppField>
                  <form.AppField name="document_number">
                    {(field) => (
                      <field.TextField
                        label={t('norms.fields.documentNumber')}
                        description={t('norms.fields.documentNumberHint')}
                        placeholder={t('norms.fields.documentNumberPlaceholder')}
                      />
                    )}
                  </form.AppField>
                </div>

                <form.AppField name="citation_url">
                  {(field) => (
                    <field.TextField
                      label={t('norms.fields.citationUrl')}
                      description={t('norms.fields.citationUrlHint')}
                      placeholder={t('norms.fields.citationUrlPlaceholder')}
                    />
                  )}
                </form.AppField>

                <form.AppField name="full_law_url">
                  {(field) => (
                    <field.TextField
                      label={t('norms.fields.fullLawUrl')}
                      description={t('norms.fields.fullLawUrlHint')}
                      placeholder={t('norms.fields.fullLawUrlPlaceholder')}
                    />
                  )}
                </form.AppField>

                {isLaw && (
                  <form.AppField name="source_url">
                    {(field) => (
                      <field.TextField
                        label={t('norms.fields.sourceUrl')}
                        description={t('norms.fields.sourceUrlHint')}
                        placeholder={t('norms.fields.sourceUrlPlaceholder')}
                      />
                    )}
                  </form.AppField>
                )}

                <form.AppField name="verified_at">
                  {(field) => (
                    <field.TextField
                      label={t('norms.fields.verifiedAt')}
                      description={t('norms.fields.verifiedAtHint')}
                      placeholder={t('norms.fields.verifiedAtPlaceholder')}
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

                <div className="flex flex-col gap-4 rounded-xl border bg-muted/20 p-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{t('norms.verify.seedTitle')}</span>
                    <span className="text-xs text-muted-foreground">{t('norms.verify.seedHint')}</span>
                  </div>
                  {!isLaw && (
                    <form.AppField name="verify_title_query">
                      {(field) => (
                        <field.TextField
                          label={t('norms.fields.titleQuery')}
                          description={t('norms.fields.titleQueryHint')}
                          placeholder={t('norms.fields.titleQueryPlaceholder')}
                        />
                      )}
                    </form.AppField>
                  )}
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <form.AppField name="verify_gesetzesnummer">
                      {(field) => (
                        <field.TextField
                          label={t('norms.fields.gesetzesnummer')}
                          description={t('norms.fields.gesetzesnummerHint')}
                          placeholder={t('norms.fields.gesetzesnummerPlaceholder')}
                        />
                      )}
                    </form.AppField>
                    <form.AppField name="verify_expect">
                      {(field) => (
                        <field.TextField
                          label={t('norms.fields.expect')}
                          description={t('norms.fields.expectHint')}
                          placeholder={t('norms.fields.optional')}
                        />
                      )}
                    </form.AppField>
                  </div>
                  <form.AppField name="verify_exclude">
                    {(field) => (
                      <field.TextField
                        label={t('norms.fields.exclude')}
                        description={t('norms.fields.excludeHint')}
                        placeholder={t('norms.fields.excludePlaceholder')}
                      />
                    )}
                  </form.AppField>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}

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
          <div className="flex items-center gap-2">
            {!isNew && (
              <Badge variant="outline" className="hidden sm:inline-flex">
                {t(`norms.rankShort.${entry.rank}`)}
              </Badge>
            )}
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
