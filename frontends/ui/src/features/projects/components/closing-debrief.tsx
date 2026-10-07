'use client'

/**
 * The closing debrief (docs/roadmap/office-experience.md, step 3): what a
 * project leaves the office when it closes, shown in the close dialog before
 * the project locks. Closing makes project memory read-only (ADR-0082), so this
 * is the last moment to keep what the project learned.
 *
 * Two parts, each composing what already exists rather than a second editor:
 *
 *   - the fingerprint the reference ranking reads (`lib/cross-project/fingerprint.ts`),
 *     each fact, „offen", or „trifft nicht zu" where the intake does not ask it
 *     of this project, with one link to the intake wizard, the profile's one
 *     editor, when a fact it writes is open; and the Steckbrief's period;
 *   - the decisions and constraints the project memory recorded. Confirming one
 *     (`PATCH …/memory/{id}`, verification `user_confirmed`) makes other
 *     projects cite it as „von einer Person bestätigt"; a lesson in the
 *     closer's words is added as a decision (`POST …/memory`).
 *
 * Nothing here blocks closing: an incomplete fingerprint is said, not enforced.
 */

import { useCallback, useEffect, useState, type JSX } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemList } from '@/components/ui/item'
import { SectionLabel } from '@/components/ui/section-label'
import { Textarea } from '@/components/ui/textarea'
import { useLocale, useTranslations } from '@/i18n'
import { fingerprintOf, type FingerprintKey } from '@/lib/cross-project/fingerprint'
import type { ProjectMemoryItem } from '@/lib/db/schema'
import type { ProjectProfile } from '@/lib/project-profile/types'
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
type DebriefItem = Pick<ProjectMemoryItem, 'id' | 'kind' | 'content' | 'status' | 'verification' | 'pinned' | 'provenanceType'>

/** The memory kinds that are experience for other projects: what the lookups search. */
const KEPT_KINDS = new Set(['decision', 'constraint'])

export function isConfirmed(item: Pick<DebriefItem, 'verification' | 'pinned' | 'provenanceType'>): boolean {
  return item.pinned || item.verification === 'user_confirmed' || item.provenanceType === 'user'
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
  const [items, setItems] = useState<DebriefItem[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [lesson, setLesson] = useState('')
  const memoryUrl = `/api/projects/${projectId}/memory`

  useEffect(() => {
    let live = true
    send<{ items: DebriefItem[] }>(memoryUrl)
      .then(({ items: loaded }) => {
        if (live) setItems(loaded.filter((item) => KEPT_KINDS.has(item.kind) && item.status === 'active'))
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [memoryUrl])

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

  const facts = fingerprintOf(profile)
  // Missing is what a person can add in the briefing: a fact the intake does not
  // ask of this project, or one it derives, is shown but never counted.
  const fillable = facts.filter((fact) => fact.applies && fact.editable && fact.value === null)
  const missing = fillable.length + (startedOn ? 0 : 1)
  const startLabel = startedOn
    ? new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(monthToDate(startedOn)))
    : null

  return (
    <div className="space-y-5" data-testid="closing-debrief">
      <p className="text-muted-foreground text-sm leading-relaxed">{t('lifecycle.debrief.intro')}</p>

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
          {facts.map((fact) => (
            <Item as="li" key={fact.key} className="py-2">
              <ItemContent className="text-sm">{t(`lifecycle.debrief.fingerprint.labels.${fact.key satisfies FingerprintKey}`)}</ItemContent>
              <ItemActions className={fact.value ? 'text-foreground text-sm' : 'text-muted-foreground text-sm italic'}>
                {fact.value ??
                  (!fact.applies
                    ? t('lifecycle.debrief.fingerprint.notApplicable')
                    : fact.editable
                      ? t('lifecycle.debrief.fingerprint.open')
                      : t('lifecycle.debrief.fingerprint.derivedOpen'))}
              </ItemActions>
            </Item>
          ))}
          <Item as="li" className="py-2">
            <ItemContent className="text-sm">{t('lifecycle.debrief.fingerprint.period')}</ItemContent>
            <ItemActions className={startLabel ? 'text-foreground text-sm' : 'text-muted-foreground text-sm italic'}>
              {startLabel
                ? t('lifecycle.debrief.fingerprint.periodOpen', { start: startLabel })
                : t('lifecycle.debrief.fingerprint.periodNone')}
            </ItemActions>
          </Item>
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
            {items.map((item) => (
              <Item as="li" key={item.id} className="items-start py-2">
                <ItemContent className="space-y-1">
                  <Badge variant="outline">{t(`lifecycle.debrief.decisions.kind.${item.kind === 'constraint' ? 'constraint' : 'decision'}`)}</Badge>
                  <p className="text-foreground text-sm leading-snug">{item.content}</p>
                </ItemContent>
                <ItemActions>
                  {isConfirmed(item) ? (
                    <Badge variant="success">{t('lifecycle.debrief.decisions.confirmed')}</Badge>
                  ) : (
                    canWriteMemory && (
                      <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void confirm(item)}>
                        {t('lifecycle.debrief.decisions.confirm')}
                      </Button>
                    )
                  )}
                </ItemActions>
              </Item>
            ))}
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
