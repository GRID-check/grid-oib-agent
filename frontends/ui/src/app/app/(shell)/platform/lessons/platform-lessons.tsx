'use client'

/**
 * Platform → Lessons: the fleet-wide register of failure patterns distilled
 * from user down-votes (docs/architecture/platform-failure-learning.md).
 *
 * The framing IS the feature: every lesson is presented as what it is — a
 * SYMPTOMATIC bandage, automatically applied so a reported failure does not
 * recur, while the root cause stays honestly marked as open until somebody
 * closes it. The callout at the top says exactly that, because a register
 * that looked like a list of fixes would teach its operators to stop fixing
 * causes (docs/contributing/correction-ratchet.md).
 *
 * Everything the pipeline does is inspectable here: candidates the auditor
 * held back, the active set the fleet runs on, retirements with their
 * reasons, and per lesson the full event trail + anonymized provenance.
 *
 * A row action (activate, retire, root cause) updates that ONE lesson in
 * place from the PATCH response; the backlog sweep refreshes the list without
 * dropping it for skeletons. Reloading the whole register after every click
 * collapsed it to placeholders and threw the reader's keyboard focus away.
 */

import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bandage, CircleAlert, CircleCheck, History, Lock, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CountPill } from '@/components/ui/count-pill'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { SectionCard } from '@/features/platform/components/section-card'
import { usePlatformCan } from '@/features/platform/platform-access'
import { useLocale, useTranslations } from '@/i18n'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { cn } from '@/lib/utils'

interface LessonDto {
  id: string
  content: string
  category: 'inaccurate' | 'too_slow' | 'wrong_source' | 'other'
  status: 'candidate' | 'active' | 'retired'
  heldReason: string | null
  reportCount: number
  orgCount: number
  lastReportedAt: string
  retiredReason: string | null
  rootCauseStatus: 'open' | 'addressed'
  rootCauseNote: string | null
}

interface OverviewDto {
  lessons: LessonDto[]
  counts: Record<string, number>
}

interface ProvenanceDto {
  lesson: LessonDto
  events: {
    id: string
    action: string
    actor: string
    actorEmail: string | null
    detail: Record<string, string | number | boolean>
    createdAt: string
  }[]
  reports: {
    id: string
    feedbackId: string
    outcome: string
    orgHash: string
    canonicalSummary: string | null
    reason: string | null
    createdAt: string
  }[]
}

type LessonPatch = Partial<Pick<LessonDto, 'status' | 'rootCauseStatus'>>

const STATUS_ORDER: LessonDto['status'][] = ['candidate', 'active', 'retired']

/**
 * The overview with one lesson replaced. A status move also moves one unit
 * between the per-status counts, so the group pills stay right without a
 * reload.
 */
export function applyLessonUpdate(overview: OverviewDto, next: LessonDto): OverviewDto {
  const previous = overview.lessons.find((lesson) => lesson.id === next.id)
  if (!previous) return overview
  const counts = { ...overview.counts }
  if (previous.status !== next.status) {
    if (counts[previous.status] !== undefined)
      counts[previous.status] = Math.max(0, counts[previous.status] - 1)
    if (counts[next.status] !== undefined) counts[next.status] += 1
  }
  return {
    lessons: overview.lessons.map((lesson) => (lesson.id === next.id ? next : lesson)),
    counts,
  }
}

export const PlatformLessons: FC = () => {
  const t = useTranslations('platform')
  const tc = useTranslations('common')
  const { locale } = useLocale()
  const canManage = usePlatformCan(PLATFORM_PERMISSIONS.settingsManage)
  const [overview, setOverview] = useState<OverviewDto | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(false)
  const [sweeping, setSweeping] = useState(false)
  const [busyLessonId, setBusyLessonId] = useState<string | null>(null)
  const [retireTarget, setRetireTarget] = useState<LessonDto | null>(null)
  const [provenance, setProvenance] = useState<ProvenanceDto | null>(null)
  const [provenanceOpen, setProvenanceOpen] = useState(false)
  /** A row whose status moved re-mounts in its new group; focus follows it there. */
  const [focusLessonId, setFocusLessonId] = useState<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const loaded = useRef(false)

  const load = useCallback(async () => {
    if (loaded.current) setRefreshing(true)
    setError(false)
    try {
      const res = await fetch('/api/platform/lessons')
      if (!res.ok) throw new Error(String(res.status))
      setOverview((await res.json()) as OverviewDto)
      loaded.current = true
    } catch {
      if (loaded.current) toast.error(t('lessons.loadError'))
      else setError(true)
    } finally {
      setRefreshing(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!focusLessonId) return
    rowRefs.current.get(focusLessonId)?.focus()
    setFocusLessonId(null)
  }, [focusLessonId, overview])

  const formatDate = useCallback(
    (iso: string) =>
      new Date(iso).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }),
    [locale]
  )

  const groups = useMemo(() => {
    const byStatus = new Map<LessonDto['status'], LessonDto[]>()
    for (const lesson of overview?.lessons ?? []) {
      const bucket = byStatus.get(lesson.status) ?? []
      bucket.push(lesson)
      byStatus.set(lesson.status, bucket)
    }
    return STATUS_ORDER.flatMap((status) => {
      const lessons = byStatus.get(status) ?? []
      return lessons.length > 0 ? [{ status, lessons }] : []
    })
  }, [overview])

  const handleSweep = useCallback(async () => {
    setSweeping(true)
    try {
      const res = await fetch('/api/platform/lessons', { method: 'POST' })
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as {
        result: {
          processed: number
          created: number
          linked: number
          skipped: number
          deferred: number
        }
      }
      toast.success(
        t('lessons.sweepDone', {
          processed: body.result.processed,
          created: body.result.created,
          linked: body.result.linked,
        })
      )
      await load()
    } catch {
      toast.error(t('lessons.sweepError'))
    } finally {
      setSweeping(false)
    }
  }, [t, load])

  /** PATCH one lesson and swap the answer in place. Resolves false on failure. */
  const patchLesson = useCallback(
    async (lesson: LessonDto, patch: LessonPatch): Promise<boolean> => {
      setBusyLessonId(lesson.id)
      try {
        const res = await fetch(`/api/platform/lessons/${lesson.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
        if (!res.ok) throw new Error(String(res.status))
        const body = (await res.json().catch(() => ({}))) as { lesson?: LessonDto }
        // The server's row when it sent one with the right id; otherwise the
        // patch itself, which is exactly what the server was asked to store.
        const next = body.lesson?.id === lesson.id ? body.lesson : { ...lesson, ...patch }
        setOverview((current) => (current ? applyLessonUpdate(current, next) : current))
        if (next.status !== lesson.status) setFocusLessonId(lesson.id)
        toast.success(t('lessons.updated'))
        return true
      } catch {
        toast.error(t('lessons.updateError'))
        return false
      } finally {
        setBusyLessonId(null)
      }
    },
    [t]
  )

  const openProvenance = useCallback(
    async (lessonId: string) => {
      setProvenance(null)
      setProvenanceOpen(true)
      try {
        const res = await fetch(`/api/platform/lessons/${lessonId}`)
        if (!res.ok) throw new Error(String(res.status))
        setProvenance((await res.json()) as ProvenanceDto)
      } catch {
        toast.error(t('lessons.provenanceError'))
        setProvenanceOpen(false)
      }
    },
    [t]
  )

  const counts = overview?.counts ?? {}

  return (
    <SectionCard
      description={t('lessons.description')}
      loading={overview === null && !error}
      refreshing={refreshing}
      skeletonRows={4}
      error={error}
      errorMessage={t('lessons.loadError')}
      onRetry={() => void load()}
      empty={overview !== null && overview.lessons.length === 0}
      emptyIcon={Bandage}
      emptyTitle={t('lessons.emptyTitle')}
      emptyDescription={t('lessons.emptyBody')}
      testId="platform-lessons"
      action={
        canManage ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleSweep()}
            disabled={sweeping}
          >
            <RefreshCw
              className={cn('size-3.5', sweeping && 'animate-spin motion-reduce:animate-none')}
              aria-hidden
            />
            {sweeping ? t('lessons.sweeping') : t('lessons.sweep')}
          </Button>
        ) : undefined
      }
    >
      {/* The doctrine, where nobody can miss it: this register is the weakest
          ratchet, and looking away from root causes is its failure mode. */}
      <Alert variant="warning" className="mb-6">
        <Bandage aria-hidden />
        <AlertTitle className="line-clamp-none">{t('lessons.doctrineTitle')}</AlertTitle>
        <AlertDescription className="text-foreground/80">
          {t('lessons.doctrineBody')}
        </AlertDescription>
      </Alert>

      {!canManage ? (
        <Alert className="mb-6">
          <Lock aria-hidden />
          <AlertDescription>{t('lessons.readOnly')}</AlertDescription>
        </Alert>
      ) : null}

      <ConfirmDialog
        open={retireTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRetireTarget(null)
        }}
        title={t('lessons.retireConfirmTitle')}
        description={t('lessons.retireConfirmBody')}
        confirmLabel={t('lessons.retire')}
        cancelLabel={tc('actions.cancel')}
        tone="warning"
        onConfirm={async () => {
          // Thrown so the dialog stays open on failure; it closes itself on success.
          if (retireTarget && !(await patchLesson(retireTarget, { status: 'retired' }))) {
            throw new Error('retire failed')
          }
        }}
      />

      <Dialog open={provenanceOpen} onOpenChange={setProvenanceOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('lessons.provenanceTitle')}</DialogTitle>
            <DialogDescription>{t('lessons.provenanceSubtitle')}</DialogDescription>
          </DialogHeader>
          {provenance ? (
            <div className="flex flex-col gap-6">
              <blockquote className="border-l-2 pl-3 text-sm leading-relaxed">
                {provenance.lesson.content}
              </blockquote>
              <section className="space-y-2">
                <SectionLabel as="h3">{t('lessons.provenanceReports')}</SectionLabel>
                <ul className="flex flex-col divide-y">
                  {provenance.reports.length === 0 && (
                    <li className="text-muted-foreground py-2 text-sm">
                      {t('lessons.provenanceNoReports')}
                    </li>
                  )}
                  {provenance.reports.map((report) => (
                    <li key={report.id} className="py-2">
                      <p className="text-sm">
                        {report.canonicalSummary ?? t('lessons.provenanceNoSummary')}
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {formatDate(report.createdAt)}
                        {report.reason ? ` · ${t(`answerFeedback.reasons.${report.reason}`)}` : ''}
                        {` · ${t('lessons.provenanceOrg', { hash: report.orgHash.slice(0, 8) })}`}
                        {` · ${t('lessons.provenanceFeedback', { id: report.feedbackId.slice(0, 8) })}`}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="space-y-2">
                <SectionLabel as="h3">{t('lessons.provenanceEvents')}</SectionLabel>
                <ul className="flex flex-col divide-y">
                  {provenance.events.map((event) => (
                    <li
                      key={event.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5"
                    >
                      <span className="text-sm">{t(`lessons.eventActions.${event.action}`)}</span>
                      <span className="text-muted-foreground text-xs">
                        {event.actorEmail ?? event.actor} · {formatDate(event.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          ) : (
            <div className="flex flex-col gap-3" aria-busy="true" aria-label={tc('states.loading')}>
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <div className="flex flex-col gap-8">
        {groups.map((group) => (
          <section key={group.status} className="space-y-1">
            <SectionLabel as="h3" className="flex items-center gap-2">
              {t(`lessons.groups.${group.status}`)}
              <CountPill>{counts[group.status] ?? group.lessons.length}</CountPill>
            </SectionLabel>
            <ul className="flex flex-col divide-y">
              {group.lessons.map((lesson) => {
                const busy = busyLessonId === lesson.id
                const open = lesson.rootCauseStatus === 'open'
                return (
                  <li
                    key={lesson.id}
                    ref={(node) => {
                      if (node) rowRefs.current.set(lesson.id, node)
                      else rowRefs.current.delete(lesson.id)
                    }}
                    tabIndex={-1}
                    aria-busy={busy || undefined}
                    className="focus-visible:ring-ring flex flex-col gap-2.5 rounded-sm py-4 outline-none focus-visible:ring-2"
                    data-testid={`lesson-${lesson.id}`}
                  >
                    <p className="text-sm leading-relaxed">{lesson.content}</p>
                    <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
                      <Badge variant={open ? 'warning' : 'success'} className="font-normal">
                        {open ? <CircleAlert aria-hidden /> : <CircleCheck aria-hidden />}
                        {t(`lessons.rootCause.${lesson.rootCauseStatus}`)}
                      </Badge>
                      {lesson.heldReason ? (
                        <Badge variant="outline" className="font-normal">
                          {t(`lessons.held.${lesson.heldReason}`)}
                        </Badge>
                      ) : null}
                      {lesson.retiredReason === 'evicted_capacity' ? (
                        <Badge variant="outline" className="font-normal">
                          {t('lessons.evicted')}
                        </Badge>
                      ) : null}
                      <span>{t(`answerFeedback.reasons.${lesson.category}`)}</span>
                      <span className="tabular-nums">
                        {t('lessons.reportMeta', { count: lesson.reportCount })}
                      </span>
                      <span className="tabular-nums">
                        {t('lessons.orgMeta', { count: lesson.orgCount })}
                      </span>
                      <span>
                        {t('lessons.lastReported', { date: formatDate(lesson.lastReportedAt) })}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {canManage && lesson.status !== 'active' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          loading={busy}
                          onClick={() => void patchLesson(lesson, { status: 'active' })}
                        >
                          {t('lessons.activate')}
                        </Button>
                      ) : null}
                      {canManage && lesson.status === 'active' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => setRetireTarget(lesson)}
                        >
                          {t('lessons.retire')}
                        </Button>
                      ) : null}
                      {canManage ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void patchLesson(lesson, {
                              rootCauseStatus: open ? 'addressed' : 'open',
                            })
                          }
                        >
                          {open ? t('lessons.markAddressed') : t('lessons.reopenRootCause')}
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void openProvenance(lesson.id)}
                        aria-label={`${t('lessons.provenance')}: ${lesson.content.slice(0, 40)}`}
                      >
                        <History className="size-3.5" aria-hidden />
                        {t('lessons.provenance')}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </SectionCard>
  )
}
