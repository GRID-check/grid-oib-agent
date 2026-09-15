'use client'

/**
 * Zeitplan tab root — what this project has committed Piloti to, and when.
 *
 * Two views of ONE set of schedules, stacked rather than toggled: the timetable
 * on top and the schedule cards below it. They answer different halves of the
 * same question and a person needs both at once — the grid says how the week
 * is arranged (what collides, what is empty), the cards say what each schedule
 * IS (its cadence, its skill, whether it is paused). Hiding either behind a
 * view switch would make a reader flip back and forth to hold one thought.
 *
 * The list is polled while the tab is visible, on the same cadence as Tasks: a
 * schedule paused in another tab, or a `next_run_at` the scheduler advanced,
 * has to reach this surface without a reload.
 *
 * The wizard REPLACES the list rather than opening over it. It is a four-step
 * flow with its own footer, and a sheet would put two scroll containers and two
 * sets of primary actions on the screen at once.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CalendarPlus, Plus } from 'lucide-react'

import { ProjectSectionActions } from '@/components/shell/project-section-frame'
import { SeriesPaletteStyle, SERIES_SLOT_COUNT } from '@/components/charts/palette'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import { listJobs, type Job } from '@/adapters/api/jobs-client'
import type { ScheduleDraft } from '../lib/schedule-draft'
import { ScheduleCard } from './schedule-card'
import { ScheduleDetail } from './schedule-detail'
import { ScheduleTimetable } from './schedule-timetable'
import { ScheduleWizard } from './schedule-wizard'

/** Gap between re-asks while the panel is visible. */
export const SCHEDULES_POLL_MS = 10_000

interface SchedulePanelProps {
  projectId: string
  /**
   * Qdrant collection of this project — scopes the drawer's run history to the
   * project's live job statuses. Null disables the join; rows keep their
   * recorded state.
   */
  projectCollection: string | null
  /** Whether this member may create/edit/run/delete schedules. */
  canManageJobs: boolean
  /** A task the reader asked to make recurring — opens the wizard pre-filled. */
  draft?: ScheduleDraft | null
  /** Called once the draft has been handed to the wizard, so it fires once. */
  onDraftConsumed?: () => void
}

/** The `?schedule=` on the URL, if any. */
function readSelectionFromUrl(): string | null {
  try {
    if (typeof window === 'undefined') return null
    return new URL(window.location.href).searchParams.get('schedule')
  } catch {
    return null
  }
}

/** Keep the deep link on the URL while the drawer is open, drop it on close. */
function syncSelectionToUrl(jobId: string | null): void {
  try {
    const url = new URL(window.location.href)
    url.searchParams.delete('schedule')
    if (jobId) url.searchParams.set('schedule', jobId)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {
    // History unavailable (embedded preview) — the drawer still works.
  }
}

export function SchedulePanel({
  projectId,
  projectCollection,
  canManageJobs,
  draft = null,
  onDraftConsumed,
}: SchedulePanelProps): JSX.Element {
  const t = useTranslations('jobs')
  const [jobs, setJobs] = useState<readonly Job[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [mode, setMode] = useState<'list' | 'wizard'>(draft ? 'wizard' : 'list')
  /** The schedule the wizard is editing, or null when it is creating one. */
  const [editing, setEditing] = useState<Job | null>(null)
  /** The draft the wizard opened with, captured once so it cannot re-apply. */
  const [wizardDraft, setWizardDraft] = useState<ScheduleDraft | null>(draft)
  const [selected, setSelected] = useState<string | null>(() => readSelectionFromUrl())

  const firstLoadRef = useRef(true)
  const inFlightRef = useRef(false)
  // A reload asked for while a fetch is in flight (notably the post-save one)
  // is queued, never lost — the in-flight fetch resolves with stale data by
  // construction, so dropping the second read would leave a just-saved schedule
  // out of the list until the next focus.
  const pendingRef = useRef(false)
  const generationRef = useRef(0)
  const projectIdRef = useRef(projectId)
  const everResolvedRef = useRef(false)
  const draftConsumedRef = useRef(false)

  // The draft is a one-shot: the section hands it over, the wizard opens with
  // it, and the section is told so it cannot arrive twice.
  useEffect(() => {
    if (!draft || draftConsumedRef.current) return
    draftConsumedRef.current = true
    setWizardDraft(draft)
    setEditing(null)
    setMode('wizard')
    onDraftConsumed?.()
  }, [draft, onDraftConsumed])

  const load = useCallback(
    async (quiet: boolean): Promise<void> => {
      if (inFlightRef.current) {
        pendingRef.current = true
        return
      }
      inFlightRef.current = true
      const startedFor = generationRef.current
      try {
        const next = await listJobs(projectId)
        if (startedFor !== generationRef.current) return
        setJobs(next)
        setFailed(false)
      } catch {
        if (startedFor !== generationRef.current) return
        if (!quiet) setFailed(true)
      } finally {
        if (startedFor === generationRef.current) {
          inFlightRef.current = false
          if (firstLoadRef.current) {
            firstLoadRef.current = false
            setLoading(false)
          }
          if (pendingRef.current) {
            pendingRef.current = false
            void load(true)
          }
        }
      }
    },
    [projectId]
  )

  useEffect(() => {
    generationRef.current += 1
    if (projectIdRef.current !== projectId) {
      projectIdRef.current = projectId
      setSelected(null)
      syncSelectionToUrl(null)
    }
    firstLoadRef.current = true
    inFlightRef.current = false
    pendingRef.current = false
    setLoading(true)
    setFailed(false)
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const clearTimer = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }

    const reschedule = () => {
      clearTimer()
      if (cancelled || document.visibilityState !== 'visible') return
      timer = setTimeout(tick, SCHEDULES_POLL_MS)
    }

    const tick = () => {
      if (cancelled) return
      void load(true).finally(() => {
        if (cancelled) return
        if (document.visibilityState === 'visible') reschedule()
        else clearTimer()
      })
    }

    const onVisibilityChange = () => {
      if (cancelled) return
      if (document.visibilityState !== 'visible') {
        clearTimer()
        return
      }
      if (inFlightRef.current) return
      clearTimer()
      void load(true).finally(() => {
        if (!cancelled) reschedule()
      })
    }

    const onFocus = () => {
      if (!cancelled) void load(true)
    }

    void load(false).finally(() => {
      if (!cancelled) reschedule()
    })
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearTimer()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
    }
  }, [projectId, load])

  const handleChanged = useCallback((next: Job) => {
    setJobs((prev) => prev.map((job) => (job.id === next.id ? next : job)))
  }, [])

  const handleDeleted = useCallback((jobId: string) => {
    setJobs((prev) => prev.filter((job) => job.id !== jobId))
    setSelected(null)
    syncSelectionToUrl(null)
  }, [])

  const openDetail = useCallback((job: Job) => {
    setSelected(job.id)
    syncSelectionToUrl(job.id)
  }, [])

  const closeDetail = useCallback(() => {
    setSelected(null)
    syncSelectionToUrl(null)
  }, [])

  const openCreate = useCallback(() => {
    setEditing(null)
    setWizardDraft(null)
    setMode('wizard')
  }, [])

  const openEdit = useCallback((job: Job) => {
    // The wizard replaces the list, so the drawer that opened it closes and its
    // `?schedule=` deep link goes with it; the URL then names no draft.
    setSelected(null)
    syncSelectionToUrl(null)
    setWizardDraft(null)
    setEditing(job)
    setMode('wizard')
  }, [])

  const backToList = useCallback(() => {
    setEditing(null)
    setWizardDraft(null)
    setMode('list')
  }, [])

  const handleSaved = useCallback(() => {
    void load(true)
    backToList()
  }, [load, backToList])

  const selectedJob = selected === null ? null : (jobs.find((job) => job.id === selected) ?? null)

  useEffect(() => {
    everResolvedRef.current = false
  }, [selected])

  useEffect(() => {
    if (selectedJob !== null) everResolvedRef.current = true
  }, [selectedJob])

  /**
   * The colour each schedule wears on the grid, so a card and its blocks are
   * recognisably the same thing. Derived from the SAME ordering the timetable
   * uses (id-sorted, placeable only), because two independent orderings is how
   * a legend and a grid end up disagreeing.
   */
  const accentOf = useMemo(() => {
    const placeable = jobs.filter((job) => job.scheduleCron && job.enabled)
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
    const slots = new Map<string, string>()
    placeable.forEach((job, index) => {
      slots.set(
        job.id,
        index < SERIES_SLOT_COUNT ? `var(--grid-series-${index + 1})` : 'var(--grid-series-other)',
      )
    })
    return (jobId: string): string | undefined => slots.get(jobId)
  }, [jobs])

  const isList = mode === 'list'

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="schedule-panel">
      <ProjectSectionActions>
        {isList ? (
          canManageJobs ? (
            <Button size="sm" onClick={openCreate} data-testid="schedule-new">
              <Plus className="size-4" aria-hidden />
              {t('list.empty.action')}
            </Button>
          ) : null
        ) : (
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={backToList}>
            <ArrowLeft className="size-4" aria-hidden />
            {t('backToList')}
          </Button>
        )}
      </ProjectSectionActions>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isList ? (
          <div className="grid-usage-viz mx-auto w-full max-w-5xl p-4 md:p-6">
            <SeriesPaletteStyle />
            <ScheduleTimetable
              schedules={jobs}
              loading={loading}
              onSelect={openDetail}
            />

            <section className="mt-8" aria-label={t('list.heading')}>
              <SectionLabel as="h2" className="mb-2">
                {t('list.heading')}
              </SectionLabel>
              {loading ? (
                <div className="grid gap-3 lg:grid-cols-2" data-testid="schedules-loading" aria-hidden="true">
                  {[0, 1].map((row) => (
                    <div key={row} className="bg-muted/50 rounded-lg border p-3">
                      <Skeleton className="h-4 w-2/5" />
                      <Skeleton className="mt-2.5 h-3.5 w-3/5" />
                      <Skeleton className="mt-1.5 h-3.5 w-2/5" />
                    </div>
                  ))}
                </div>
              ) : failed ? (
                <EmptyState
                  icon={CalendarPlus}
                  tone="destructive"
                  title={t('loadError')}
                  action={
                    <Button variant="outline" size="sm" onClick={() => void load(false)}>
                      {t('tryAgain')}
                    </Button>
                  }
                />
              ) : jobs.length === 0 ? (
                <EmptyState
                  icon={CalendarPlus}
                  title={t('list.empty.title')}
                  description={t('list.empty.description')}
                  action={
                    canManageJobs ? (
                      <Button onClick={openCreate}>
                        <Plus className="size-4" aria-hidden />
                        {t('list.empty.action')}
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="grid gap-3 lg:grid-cols-2" data-testid="schedule-cards">
                  {jobs.map((job) => (
                    <ScheduleCard
                      key={job.id}
                      job={job}
                      canManage={canManageJobs}
                      accent={accentOf(job.id)}
                      onChanged={handleChanged}
                      onSelect={openDetail}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        ) : (
          <div className="p-4 md:p-6">
            <ScheduleWizard
              projectId={projectId}
              job={editing}
              draft={wizardDraft}
              onSaved={handleSaved}
              onCancel={backToList}
            />
          </div>
        )}
      </div>

      <ScheduleDetail
        projectId={projectId}
        projectCollection={projectCollection}
        job={selectedJob}
        open={selected !== null}
        canManage={canManageJobs}
        goneReason={everResolvedRef.current ? 'deleted' : 'unresolved'}
        resolving={selected !== null && selectedJob === null && loading}
        onChanged={handleChanged}
        onDeleted={handleDeleted}
        onEdit={openEdit}
        onClose={closeDetail}
      />
    </div>
  )
}
