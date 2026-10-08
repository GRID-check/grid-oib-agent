'use client'

/**
 * The closing debrief (docs/roadmap/office-experience.md, step 3): what a
 * project leaves the office when it closes, shown in the close dialog before
 * the project locks. Closing makes project memory read-only (ADR-0089), so this
 * is the last moment to keep what the project learned.
 *
 * Three parts, each composing what already exists rather than a second editor:
 *
 *   - the fingerprint the reference ranking reads (`lib/cross-project/fingerprint.ts`),
 *     each fact, „offen", or „trifft nicht zu" where the intake does not ask it
 *     of this project, with one link to the intake wizard, the profile's one
 *     editor, when a fact it writes is open; and the Steckbrief's period. A fact
 *     the closing extraction suggested (`docs/design/closed-project-experience.md`)
 *     shows its evidence and „Übernehmen", which writes it through the ordinary
 *     profile patch; the OIB edition is shown beside the facts when it is known;
 *   - the decisions and constraints the project memory recorded. Confirming one
 *     (`PATCH …/memory/{id}`, verification `user_confirmed`) makes other
 *     projects cite it as „von einer Person bestätigt"; dismissing a decision the
 *     extraction drafted removes it (`status: dismissed`); a lesson in the
 *     closer's words is added as a decision (`POST …/memory`);
 *   - „Aus den Unterlagen erschließen", which has the backend read the project's
 *     own documents once and writes what they say as the suggestions above.
 *
 * Nothing here blocks closing: an incomplete fingerprint is said, not enforced.
 */

import { useCallback, useEffect, useState, type JSX } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemList } from '@/components/ui/item'
import { SectionLabel } from '@/components/ui/section-label'
import { Textarea } from '@/components/ui/textarea'
import { useLocale, useTranslations } from '@/i18n'
import { factLabel, fingerprintOf, type FingerprintKey } from '@/lib/cross-project/fingerprint'
import type { ProjectMemoryItem } from '@/lib/db/schema'
import type { ProjectExperienceError, ProjectExperienceResult } from '@/lib/project-experience/types'
import type { ProjectAssumption, ProjectFact, ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'
import { monthToDate, type Month } from '@/lib/projects/month'

export interface ClosingDebriefProps {
  projectId: string
  profile: ProjectProfile | null
  /** The Steckbrief's Beginn; the Abschluss is set by closing when it is unset. */
  startedOn: Month | null
  /** Whether the reader may confirm decisions and record a lesson (project memory write). */
  canWriteMemory: boolean
}

/** A memory item as the list route sends it. */
type DebriefItem = Pick<
  ProjectMemoryItem,
  'id' | 'kind' | 'content' | 'status' | 'verification' | 'pinned' | 'provenanceType' | 'evidence'
>

/** The memory kinds that are experience for other projects: what the lookups search. */
const KEPT_KINDS = new Set(['decision', 'constraint'])

/** The fact beside the fingerprint that the extraction may also suggest. */
const OIB_KEY = 'oib_ausgabe'

/** The sentence for each reason the extraction answered without a result; `null` is a failed request. */
const EXTRACTION_ERROR_KEY = {
  backend_unavailable: 'backendUnavailable',
  no_documents: 'noDocuments',
  no_model: 'failed',
  extraction_failed: 'failed',
} as const satisfies Record<ProjectExperienceError, string>

/** How the last „Aus den Unterlagen erschließen" went; null before the first one. */
type Extraction =
  | { status: 'done'; suggested: number; drafted: number; documents: number }
  | { status: 'failed'; error: ProjectExperienceError | null }

export function isConfirmed(item: Pick<DebriefItem, 'verification' | 'pinned' | 'provenanceType'>): boolean {
  return item.pinned || item.verification === 'user_confirmed' || item.provenanceType === 'user'
}

/** Drafted by the closing extraction and not yet a person's: it waits for a confirm or a dismiss. */
function isSourceGrounded(item: Pick<DebriefItem, 'verification' | 'pinned' | 'provenanceType'>): boolean {
  return item.verification === 'source_grounded' && !isConfirmed(item)
}

/** A confirmed fact of this key, flat or per building: the same reading the experience route makes. */
function hasConfirmedFact(profile: ProjectProfile | null, key: string): boolean {
  return Object.entries(profile?.facts ?? {}).some(([name, fact]) => name.split('@')[0] === key && fact.value !== null)
}

/** The agent's suggestion for a key nobody has answered yet, or null. */
function suggestionFor(profile: ProjectProfile | null, key: string): ProjectAssumption | null {
  if (hasConfirmedFact(profile, key)) return null
  const assumption = profile?.assumptions[key]
  return assumption?.source === 'agent_suggested' && assumption.value !== null ? assumption : null
}

async function send<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  if (!res.ok) throw new Error(String(res.status))
  return (await res.json()) as T
}

export function ClosingDebrief({ projectId, profile, startedOn, canWriteMemory }: ClosingDebriefProps): JSX.Element {
  const t = useTranslations('projects')
  const { locale } = useLocale()
  const router = useRouter()
  const [items, setItems] = useState<DebriefItem[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [extraction, setExtraction] = useState<Extraction | null>(null)
  const [lesson, setLesson] = useState('')
  const memoryUrl = `/api/projects/${projectId}/memory`

  const loadMemory = useCallback(async () => {
    const { items: loaded } = await send<{ items: DebriefItem[] }>(memoryUrl)
    setItems(loaded.filter((item) => KEPT_KINDS.has(item.kind) && item.status === 'active'))
  }, [memoryUrl])

  useEffect(() => {
    void loadMemory().catch(() => setFailed(true))
  }, [loadMemory])

  const extract = useCallback(async () => {
    setExtracting(true)
    setExtraction(null)
    try {
      const result = await send<ProjectExperienceResult>(`/api/projects/${projectId}/experience`, { method: 'POST' })
      if (result.error) {
        setExtraction({ status: 'failed', error: result.error })
        return
      }
      setExtraction({
        status: 'done',
        suggested: result.suggested,
        drafted: result.drafted,
        documents: result.documentsRead.length,
      })
      // The fingerprint is the server's prop, so a refresh re-reads it; the memory is local.
      router.refresh()
      await loadMemory().catch(() => setFailed(true))
    } catch {
      setExtraction({ status: 'failed', error: null })
    } finally {
      setExtracting(false)
    }
  }, [loadMemory, projectId, router])

  const confirm = useCallback(
    async (item: DebriefItem) => {
      setBusy(item.id)
      try {
        const { item: saved } = await send<{ item: DebriefItem }>(`${memoryUrl}/${item.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ verification: 'user_confirmed' }),
        })
        setItems((current) => current?.map((entry) => (entry.id === saved.id ? saved : entry)) ?? null)
      } catch {
        toast.error(t('lifecycle.debrief.errors.save'))
      } finally {
        setBusy(null)
      }
    },
    [memoryUrl, t]
  )

  const dismiss = useCallback(
    async (item: DebriefItem) => {
      setBusy(item.id)
      try {
        await send<{ item: DebriefItem }>(`${memoryUrl}/${item.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'dismissed' }),
        })
        setItems((current) => current?.filter((entry) => entry.id !== item.id) ?? null)
      } catch {
        toast.error(t('lifecycle.debrief.errors.save'))
      } finally {
        setBusy(null)
      }
    },
    [memoryUrl, t]
  )

  const accept = useCallback(
    async (key: string, value: ProjectPrimitiveValue) => {
      setBusy(`fact:${key}`)
      try {
        await send<unknown>(`/api/projects/${projectId}/profile/patches`, {
          method: 'POST',
          body: JSON.stringify({ patch: [{ op: 'add', path: `/facts/${key}`, value }] }),
        })
        router.refresh()
      } catch {
        toast.error(t('lifecycle.debrief.errors.save'))
      } finally {
        setBusy(null)
      }
    },
    [projectId, router, t]
  )

  const record = useCallback(async () => {
    const content = lesson.trim()
    if (!content) return
    setBusy('lesson')
    try {
      const { item } = await send<{ item: DebriefItem }>(memoryUrl, {
        method: 'POST',
        body: JSON.stringify({ kind: 'decision', content }),
      })
      setItems((current) => [item, ...(current ?? [])])
      setLesson('')
      toast.success(t('lifecycle.debrief.lesson.added'))
    } catch {
      toast.error(t('lifecycle.debrief.errors.save'))
    } finally {
      setBusy(null)
    }
  }, [lesson, memoryUrl, t])

  const valueText = (key: string, value: ProjectPrimitiveValue): string => {
    if (key === OIB_KEY) return t('lifecycle.debrief.fingerprint.oibEdition', { edition: String(value) })
    if (key === 'gebaeudeklasse') return `GK ${String(value)}`
    const tokens = Array.isArray(value) ? value : [String(value)]
    return tokens.map((token) => factLabel(key, token)).join('/')
  }

  const facts = fingerprintOf(profile)
  // Missing is what a person can add in the briefing: a fact the intake does not
  // ask of this project, or one it derives, is shown but never counted. A
  // suggestion is not an answer yet, so it still counts until it is accepted.
  const fillable = facts.filter(
    (fact) => fact.applies && fact.editable && (fact.value === null || suggestionFor(profile, fact.key) !== null)
  )
  const missing = fillable.length + (startedOn ? 0 : 1)
  const startLabel = startedOn
    ? new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(monthToDate(startedOn)))
    : null
  const oibFact: ProjectFact | undefined = profile?.facts[OIB_KEY]
  const oibConfirmed = oibFact && oibFact.value !== null ? valueText(OIB_KEY, oibFact.value) : null
  const oibSuggested = suggestionFor(profile, OIB_KEY)

  const renderRow = (key: string, label: string, confirmed: string | null, unset: string) => {
    const suggestion = suggestionFor(profile, key)
    return (
      <Item as="li" key={key} className={suggestion ? 'items-start py-2' : 'py-2'}>
        <ItemContent className="space-y-1">
          <span className="text-foreground text-sm">{label}</span>
          {suggestion && (
            <>
              <Badge variant="info">{t('lifecycle.debrief.fingerprint.suggested')}</Badge>
              <p className="text-muted-foreground text-xs leading-snug">{suggestion.reason}</p>
            </>
          )}
        </ItemContent>
        <ItemActions className={suggestion || confirmed ? 'text-foreground text-sm' : 'text-muted-foreground text-sm italic'}>
          {suggestion ? (
            <>
              <span>{valueText(key, suggestion.value)}</span>
              {canWriteMemory && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void accept(key, suggestion.value)}
                >
                  {t('lifecycle.debrief.fingerprint.accept')}
                </Button>
              )}
            </>
          ) : (
            (confirmed ?? unset)
          )}
        </ItemActions>
      </Item>
    )
  }

  const extractionText = extracting
    ? t('lifecycle.debrief.extract.pending')
    : extraction?.status === 'done'
      ? extraction.suggested + extraction.drafted === 0
        ? t('lifecycle.debrief.extract.none')
        : t('lifecycle.debrief.extract.result', {
            suggested: extraction.suggested,
            drafted: extraction.drafted,
            documents: extraction.documents,
          })
      : extraction
        ? t(`lifecycle.debrief.extract.errors.${EXTRACTION_ERROR_KEY[extraction.error ?? 'extraction_failed']}`)
        : null

  return (
    <div className="space-y-5" data-testid="closing-debrief">
      <p className="text-muted-foreground text-sm leading-relaxed">{t('lifecycle.debrief.intro')}</p>

      {canWriteMemory && (
        <div className="space-y-2">
          <Button variant="outline" size="sm" disabled={extracting || busy !== null} onClick={() => void extract()}>
            {t('lifecycle.debrief.extract.action')}
          </Button>
          {extractionText && (
            <p role="status" className="text-muted-foreground text-sm leading-relaxed">
              {extractionText}
            </p>
          )}
        </div>
      )}

      <section className="space-y-2" aria-labelledby="debrief-fingerprint">
        <div className="flex flex-wrap items-center gap-2">
          <SectionLabel as="h3" id="debrief-fingerprint">
            {t('lifecycle.debrief.fingerprint.heading')}
          </SectionLabel>
          <Badge variant={missing > 0 ? 'warning' : 'success'}>
            {missing > 0
              ? t('lifecycle.debrief.fingerprint.missing', { count: missing })
              : t('lifecycle.debrief.fingerprint.complete')}
          </Badge>
        </div>
        <p className="text-muted-foreground text-xs">{t('lifecycle.debrief.fingerprint.description')}</p>
        <ItemList as="ul">
          {facts.map((fact) =>
            renderRow(
              fact.key,
              t(`lifecycle.debrief.fingerprint.labels.${fact.key satisfies FingerprintKey}`),
              fact.value,
              !fact.applies
                ? t('lifecycle.debrief.fingerprint.notApplicable')
                : fact.editable
                  ? t('lifecycle.debrief.fingerprint.open')
                  : t('lifecycle.debrief.fingerprint.derivedOpen')
            )
          )}
          <Item as="li" className="py-2">
            <ItemContent className="text-sm">{t('lifecycle.debrief.fingerprint.period')}</ItemContent>
            <ItemActions className={startLabel ? 'text-foreground text-sm' : 'text-muted-foreground text-sm italic'}>
              {startLabel
                ? t('lifecycle.debrief.fingerprint.periodOpen', { start: startLabel })
                : t('lifecycle.debrief.fingerprint.periodNone')}
            </ItemActions>
          </Item>
          {(oibConfirmed !== null || oibSuggested !== null) &&
            renderRow(OIB_KEY, t('lifecycle.debrief.fingerprint.labels.oibEdition'), oibConfirmed, '')}
        </ItemList>
        {fillable.length > 0 && (
          <Button asChild variant="link" size="sm" className="h-auto px-0">
            <Link href={`/app/projects/${projectId}/intake`}>{t('lifecycle.debrief.fingerprint.edit')}</Link>
          </Button>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="debrief-decisions">
        <SectionLabel as="h3" id="debrief-decisions">
          {t('lifecycle.debrief.decisions.heading')}
        </SectionLabel>
        <p className="text-muted-foreground text-xs">{t('lifecycle.debrief.decisions.description')}</p>
        {failed && <p className="text-destructive text-sm">{t('lifecycle.debrief.errors.load')}</p>}
        {items !== null && items.length === 0 && (
          <p className="text-muted-foreground text-sm">{t('lifecycle.debrief.decisions.empty')}</p>
        )}
        {items !== null && items.length > 0 && (
          <ItemList as="ul">
            {items.map((item) => {
              const grounded = isSourceGrounded(item)
              return (
                <Item as="li" key={item.id} className="items-start py-2">
                  <ItemContent className="space-y-1">
                    <Badge variant="outline">{t(`lifecycle.debrief.decisions.kind.${item.kind === 'constraint' ? 'constraint' : 'decision'}`)}</Badge>
                    {grounded && <Badge variant="info">{t('lifecycle.debrief.decisions.grounded')}</Badge>}
                    <p className="text-foreground text-sm leading-snug">{item.content}</p>
                    {grounded && item.evidence && item.evidence.length > 0 && (
                      <p className="text-muted-foreground text-xs">
                        {item.evidence
                          .map((evidence) =>
                            evidence.page
                              ? t('lifecycle.debrief.decisions.evidencePage', { file: evidence.fileName, page: evidence.page })
                              : evidence.fileName
                          )
                          .join('; ')}
                      </p>
                    )}
                  </ItemContent>
                  <ItemActions>
                    {isConfirmed(item) ? (
                      <Badge variant="success">{t('lifecycle.debrief.decisions.confirmed')}</Badge>
                    ) : (
                      canWriteMemory && (
                        <>
                          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void confirm(item)}>
                            {t('lifecycle.debrief.decisions.confirm')}
                          </Button>
                          {grounded && (
                            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void dismiss(item)}>
                              {t('lifecycle.debrief.decisions.dismiss')}
                            </Button>
                          )}
                        </>
                      )
                    )}
                  </ItemActions>
                </Item>
              )
            })}
          </ItemList>
        )}
        {canWriteMemory ? (
          <div className="space-y-2">
            <label htmlFor="debrief-lesson" className="text-foreground text-sm font-medium">
              {t('lifecycle.debrief.lesson.label')}
            </label>
            <Textarea
              id="debrief-lesson"
              value={lesson}
              rows={2}
              maxLength={2000}
              placeholder={t('lifecycle.debrief.lesson.placeholder')}
              onChange={(event) => setLesson(event.target.value)}
            />
            <Button variant="outline" size="sm" disabled={busy !== null || !lesson.trim()} onClick={() => void record()}>
              {t('lifecycle.debrief.lesson.add')}
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">{t('lifecycle.debrief.readOnly')}</p>
        )}
      </section>
    </div>
  )
}
