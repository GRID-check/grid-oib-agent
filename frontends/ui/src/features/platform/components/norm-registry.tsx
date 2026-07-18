'use client'

/**
 * Platform norm-registry manager (ADR-0016 companion) — the curated catalog of
 * Austrian building-law pointers the agent cites.
 *
 * Loads the whole registry into local state, edits happen in-memory (a single
 * Save PUTs the entire file under the held optimistic-concurrency version), and
 * a 409 offers a reload. Entries are grouped into legal lanes (Bundesrecht +
 * one lane per Bundesland); a "Offene Prüfungen" queue surfaces every entry
 * carrying an internal review note. The editor can verify a pointer against RIS
 * and fill the verified document number / URLs from a picked candidate.
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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import {
  NORM_RANKS,
  type NormEntry,
  type NormRank,
  type NormRegistryEnvelope,
  type VerifyCandidate,
  type VerifyNormResponse,
} from '@/lib/norms/schemas'

/* ---------------------------------------------------------------------------
 * Constants + helpers
 * ------------------------------------------------------------------------- */

const STALE_AFTER_MS = 365 * 24 * 60 * 60 * 1000

const RANK_LABELS: Record<NormRank, string> = {
  bundesgesetz: 'Bundesgesetz',
  landesgesetz: 'Landesgesetz',
  verordnung: 'Verordnung',
}

const RANK_OPTIONS = NORM_RANKS.map((value) => ({ value, label: RANK_LABELS[value] }))

const BUNDESRECHT_LANE = 'Bundesrecht'

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

const entryFormSchema = z.object({
  id: z.string().min(1, 'Pflichtfeld'),
  title: z.string().min(1, 'Pflichtfeld'),
  short: z.string().min(1, 'Pflichtfeld'),
  rank: z.enum(NORM_RANKS),
  bundesland: z.string(),
  topics: z.string(),
  relevance: z.string(),
  application: z.string(),
  document_number: z.string(),
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
  const [entries, setEntries] = useState<NormEntry[]>([])
  const [version, setVersion] = useState<number>(0)
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setHasError(false)
    setConflict(false)
    return fetch('/api/platform/norms')
      .then((r) => {
        if (!r.ok) throw new Error(`Fehler beim Laden (${r.status})`)
        return r.json() as Promise<NormRegistryEnvelope>
      })
      .then((data) => {
        setEntries(data.registry.entries)
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

  const otherIds = useMemo(
    () => (originalId: string | null) =>
      new Set(entries.filter((e) => e.id !== originalId).map((e) => e.id)),
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
    setIsSaving(true)
    setConflict(false)
    fetch('/api/platform/norms', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, registry: { version: 1, entries } }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}))
        if (r.status === 409) {
          setConflict(true)
          toast.error('Registry wurde parallel geändert — neu laden')
          return
        }
        if (r.status === 422 || r.status === 400) {
          toast.error(body?.error ?? 'Registry-Validierung fehlgeschlagen')
          return
        }
        if (!r.ok) throw new Error(`Speichern fehlgeschlagen (${r.status})`)
        if (typeof body?.version === 'number') setVersion(body.version)
        setDirty(false)
        toast.success('Registry gespeichert')
      })
      .catch(() => toast.error('Speichern fehlgeschlagen'))
      .finally(() => setIsSaving(false))
  }, [entries, version])

  const lanes = useMemo(() => groupIntoLanes(entries), [entries])
  const openReviews = useMemo(
    () => entries.filter((e) => (e.review_note ?? '').trim().length > 0),
    [entries],
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookMarked className="size-4 text-muted-foreground" aria-hidden />
          Normen-Register
        </CardTitle>
        <CardDescription>
          Kuratierter Katalog österreichischer Bau-Rechtsverweise, die der Agent zitiert.
          {' '}
          {entries.length} {entries.length === 1 ? 'Eintrag' : 'Einträge'}.
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditor({ entry: emptyEntry(), originalId: null })}
            disabled={isLoading || hasError}
          >
            <Plus className="size-3.5" aria-hidden />
            Neuer Eintrag
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!dirty || isSaving || isLoading}>
            {isSaving ? <Spinner className="size-3.5" /> : <Save className="size-3.5" aria-hidden />}
            Speichern
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {isLoading && <Skeleton className="h-48 w-full rounded-xl" data-testid="norm-registry-loading" />}

        {!isLoading && hasError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" aria-hidden />
            <AlertTitle>Register konnte nicht geladen werden</AlertTitle>
            <AlertDescription>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RotateCcw className="size-3.5" aria-hidden />
                Erneut versuchen
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {!isLoading && conflict && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" aria-hidden />
            <AlertTitle>Registry wurde parallel geändert</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              <span>Ihre lokalen Änderungen wurden nicht gespeichert. Bitte neu laden.</span>
              <Button variant="outline" size="sm" className="w-fit" onClick={() => void load()}>
                <RotateCcw className="size-3.5" aria-hidden />
                Neu laden
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {!isLoading && !hasError && (
          <>
            {openReviews.length > 0 && (
              <Card className="border-warning/40 bg-warning-subtle/40">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <ClipboardList className="size-4 text-warning" aria-hidden />
                    Offene Prüfungen ({openReviews.length})
                  </CardTitle>
                  <CardDescription>Interne Prüfaufgaben — nur hier sichtbar, nie im Prompt.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="divide-y divide-border overflow-hidden rounded-lg border bg-card">
                    {openReviews.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => setEditor({ entry, originalId: entry.id })}
                        className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
                      >
                        <Badge variant="warning" className="mt-0.5 shrink-0">
                          {entry.short}
                        </Badge>
                        <span className="min-w-0 text-sm text-muted-foreground">{entry.review_note}</span>
                      </button>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {entries.length === 0 ? (
              <EmptyState variant="bare" icon={BookMarked} title="Noch keine Einträge im Register" />
            ) : (
              lanes.map((lane) => (
                <section key={lane.name} className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                    {lane.name}
                  </h3>
                  <div className="divide-y divide-border overflow-hidden rounded-2xl border bg-card shadow-xs">
                    {lane.entries.map((entry) => (
                      <NormRow
                        key={entry.id}
                        entry={entry}
                        onOpen={() => setEditor({ entry, originalId: entry.id })}
                      />
                    ))}
                  </div>
                </section>
              ))
            )}
          </>
        )}
      </CardContent>

      {editor && (
        <NormEditorDialog
          key={editor.originalId ?? '__new__'}
          target={editor}
          existingIds={otherIds(editor.originalId)}
          onSave={handleSaveEntry}
          onCancel={() => setEditor(null)}
          onRequestDelete={() => editor.originalId && setPendingDelete(editor.originalId)}
          isNew={editor.originalId === null}
        />
      )}

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Eintrag löschen?</DialogTitle>
            <DialogDescription>
              Der Eintrag wird aus dem Register entfernt. Wirksam erst nach dem Speichern.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              onClick={() => pendingDelete && handleDelete(pendingDelete)}
            >
              <Trash2 className="size-3.5" aria-hidden />
              Löschen
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/* ---------------------------------------------------------------------------
 * Lane grouping + row
 * ------------------------------------------------------------------------- */

interface Lane {
  name: string
  entries: NormEntry[]
}

function groupIntoLanes(entries: NormEntry[]): Lane[] {
  const federal = entries.filter((e) => e.bundesland.trim() === '')
  const byLand = new Map<string, NormEntry[]>()
  for (const entry of entries) {
    const land = entry.bundesland.trim()
    if (!land) continue
    const bucket = byLand.get(land) ?? []
    bucket.push(entry)
    byLand.set(land, bucket)
  }
  const lanes: Lane[] = []
  if (federal.length > 0) lanes.push({ name: BUNDESRECHT_LANE, entries: federal })
  for (const land of [...byLand.keys()].sort((a, b) => a.localeCompare(b, 'de'))) {
    lanes.push({ name: land, entries: byLand.get(land) ?? [] })
  }
  return lanes
}

function NormRow({ entry, onOpen }: { entry: NormEntry; onOpen: () => void }): JSX.Element {
  const stale = isStale(entry.verified_at)
  const hasReview = (entry.review_note ?? '').trim().length > 0
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-2 px-4 py-3 text-left transition-colors hover:bg-accent/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Badge variant="secondary" className="mt-0.5 shrink-0">
          {entry.short}
        </Badge>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium">
            {entry.title}
            {hasReview && (
              <span
                className="inline-block size-2 shrink-0 rounded-full bg-warning"
                aria-label="Offene Prüfung"
                title="Offene Prüfung"
              />
            )}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {[entry.application, entry.document_number].filter(Boolean).join(' · ') || '—'}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:pt-0">
        <Badge
          variant={stale ? 'warning' : 'outline'}
          className="gap-1"
          title={stale ? 'Verifizierung älter als 12 Monate oder fehlend' : 'Zuletzt verifiziert'}
        >
          {stale ? <CircleAlert className="size-3" aria-hidden /> : <BadgeCheck className="size-3" aria-hidden />}
          {entry.verified_at.trim() || 'ungeprüft'}
        </Badge>
      </div>
    </button>
  )
}

/* ---------------------------------------------------------------------------
 * Editor dialog
 * ------------------------------------------------------------------------- */

interface DiffHint {
  field: string
  from: string
  to: string
}

function NormEditorDialog({
  target,
  existingIds,
  onSave,
  onCancel,
  onRequestDelete,
  isNew,
}: {
  target: EditorTarget
  existingIds: Set<string>
  onSave: (originalId: string | null, entry: NormEntry) => void
  onCancel: () => void
  onRequestDelete: () => void
  isNew: boolean
}): JSX.Element {
  const [candidates, setCandidates] = useState<VerifyCandidate[] | null>(null)
  const [isVerifying, setIsVerifying] = useState(false)
  const [diff, setDiff] = useState<DiffHint[]>([])
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null)

  const form = useAppForm({
    defaultValues: entryToForm(target.entry),
    validators: { onChange: entryFormSchema },
    onSubmit: ({ value }) => {
      const entry = formToEntry(value)
      if (existingIds.has(entry.id)) {
        toast.error(`ID „${entry.id}" ist bereits vergeben`)
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
      toast.error('Titel-Query und RIS-Application werden zum Verifizieren benötigt')
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
        if (!r.ok) throw new Error(`Verifizierung fehlgeschlagen (${r.status})`)
        return r.json() as Promise<VerifyNormResponse>
      })
      .then((data) => {
        setCandidates(data.candidates)
        setVerifiedAt(data.verified_at)
        if (data.candidates.length === 0) toast.info('Keine RIS-Treffer gefunden')
      })
      .catch(() => toast.error('RIS-Verifizierung fehlgeschlagen'))
      .finally(() => setIsVerifying(false))
  }, [form])

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
      toast.success('Kandidat übernommen')
    },
    [form, verifiedAt],
  )

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Neuer Eintrag' : 'Eintrag bearbeiten'}</DialogTitle>
          <DialogDescription>
            Alle Änderungen werden erst mit „Speichern" im Register übernommen.
          </DialogDescription>
        </DialogHeader>

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
                <field.TextField label="ID" required placeholder="z. B. oib-rl2-2023" disabled={!isNew} />
              )}
            </form.AppField>
            <form.AppField name="short">
              {(field) => <field.TextField label="Kürzel" required placeholder="z. B. OIB-RL 2" />}
            </form.AppField>
          </div>

          <form.AppField name="title">
            {(field) => (
              <field.TextField label="Titel" required placeholder="Voller Titel der Norm" />
            )}
          </form.AppField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <form.AppField name="rank">
              {(field) => <field.SelectField label="Rang" options={RANK_OPTIONS} />}
            </form.AppField>
            <form.AppField name="bundesland">
              {(field) => (
                <field.TextField
                  label="Bundesland"
                  description="Kanonischer Name (z. B. Wien) — leer lassen für Bundesrecht"
                  placeholder="Wien"
                />
              )}
            </form.AppField>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <form.AppField name="application">
              {(field) => (
                <field.TextField label="RIS-Application" placeholder="z. B. LrKons / BrKons" />
              )}
            </form.AppField>
            <form.AppField name="relevance">
              {(field) => <field.TextField label="Relevanz" placeholder="z. B. hoch" />}
            </form.AppField>
          </div>

          <form.AppField name="topics">
            {(field) => (
              <field.TextField
                label="Themen"
                description="Kommagetrennt (z. B. Brandschutz, Fluchtwege)"
                placeholder="Brandschutz, Fluchtwege"
              />
            )}
          </form.AppField>

          <form.AppField name="aliases">
            {(field) => (
              <field.TextField
                label="Aliase"
                description="Kommagetrennt — alternative Bezeichnungen"
                placeholder="OIB 2, Richtlinie 2"
              />
            )}
          </form.AppField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <form.AppField name="document_number">
              {(field) => <field.TextField label="Dokumentnummer" placeholder="NOR40251234" />}
            </form.AppField>
            <form.AppField name="verified_at">
              {(field) => <field.TextField label="Verifiziert am" placeholder="YYYY-MM-DD" />}
            </form.AppField>
          </div>

          <form.AppField name="citation_url">
            {(field) => <field.TextField label="Zitier-URL" placeholder="https://…" />}
          </form.AppField>

          <form.AppField name="full_law_url">
            {(field) => <field.TextField label="Volltext-URL" placeholder="https://…" />}
          </form.AppField>

          <form.AppField name="binding_note">
            {(field) => (
              <field.TextAreaField
                label="Rechtlicher Hinweis"
                description="Wird dem Agenten als rechtlicher Hinweis angezeigt"
                rows={2}
              />
            )}
          </form.AppField>

          <form.AppField name="review_note">
            {(field) => (
              <field.TextAreaField
                label="Prüfnotiz"
                description="Interne Prüfaufgabe — erscheint nie im Prompt"
                rows={2}
              />
            )}
          </form.AppField>

          {/* RIS verification */}
          <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Gegen RIS verifizieren</span>
                <span className="text-xs text-muted-foreground">
                  Nutzt Titel-Query (oder Titel) + RIS-Application des Eintrags.
                </span>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={handleVerify} disabled={isVerifying}>
                {isVerifying ? <Spinner className="size-3.5" /> : <Search className="size-3.5" aria-hidden />}
                Verifizieren
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <form.AppField name="verify_title_query">
                {(field) => <field.TextField label="Titel-Query" placeholder="RIS-Titelsuche" />}
              </form.AppField>
              <form.AppField name="verify_gesetzesnummer">
                {(field) => <field.TextField label="Gesetzesnummer" placeholder="optional" />}
              </form.AppField>
              <form.AppField name="verify_expect">
                {(field) => <field.TextField label="Erwartet (expect)" placeholder="optional" />}
              </form.AppField>
              <form.AppField name="verify_exclude">
                {(field) => (
                  <field.TextField label="Ausschluss (exclude)" placeholder="kommagetrennt" />
                )}
              </form.AppField>
            </div>

            {candidates !== null && (
              <div className="overflow-hidden rounded-lg border bg-popover">
                <Command shouldFilter={false}>
                  <CommandList>
                    <CommandEmpty>Keine Kandidaten</CommandEmpty>
                    {candidates.map((candidate) => (
                      <CommandItem
                        key={`${candidate.document_number}:${candidate.citation_url}`}
                        value={`${candidate.title} ${candidate.document_number}`}
                        onSelect={() => applyCandidate(candidate)}
                        className="flex flex-col items-start gap-0.5"
                      >
                        <span className="text-sm">{candidate.title}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {candidate.document_number}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandList>
                </Command>
              </div>
            )}

            {diff.length > 0 && (
              <div className="flex flex-col gap-1 rounded-lg border border-info/40 bg-info-subtle/40 p-2 text-xs">
                <span className="font-medium text-info">Übernommen:</span>
                {diff.map((d) => (
                  <span key={d.field} className="font-mono text-muted-foreground">
                    {d.field}: {d.from || '—'} → {d.to || '—'}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 pt-2">
            {!isNew ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={onRequestDelete}
              >
                <Trash2 className="size-3.5" aria-hidden />
                Löschen
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onCancel}>
                Abbrechen
              </Button>
              <form.AppForm>
                <form.SubmitButton>Übernehmen</form.SubmitButton>
              </form.AppForm>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
