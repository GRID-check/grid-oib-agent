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
 */

import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { Bandage, History, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SectionCard } from '@/features/platform/components/section-card'
import { useLocale, useTranslations } from '@/i18n'

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

const STATUS_ORDER: LessonDto['status'][] = ['candidate', 'active', 'retired']

export const PlatformLessons: FC = () => {
  const t = useTranslations('platform')
  const tc = useTranslations('common')
  const { locale } = useLocale()
  const [overview, setOverview] = useState<OverviewDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [sweeping, setSweeping] = useState(false)
  const [busyLessonId, setBusyLessonId] = useState<string | null>(null)
  const [retireTarget, setRetireTarget] = useState<LessonDto | null>(null)
  const [provenance, setProvenance] = useState<ProvenanceDto | null>(null)
  const [provenanceOpen, setProvenanceOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const res = await fetch('/api/platform/lessons')
      if (!res.ok) throw new Error(String(res.status))
      setOverview((await res.json()) as OverviewDto)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const formatDate = useCallback(
    (iso: string) =>
      new Date(iso).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }),
    [locale],
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
        result: { processed: number; created: number; linked: number; skipped: number; deferred: number }
      }
      toast.success(
        t('lessons.sweepDone', {
          processed: body.result.processed,
          created: body.result.created,
          linked: body.result.linked,
        }),
      )
      await load()
    } catch {
      toast.error(t('lessons.sweepError'))
    } finally {
      setSweeping(false)
    }
  }, [t, load])

  const patchLesson = useCallback(
    async (lessonId: string, patch: Record<string, unknown>) => {
      setBusyLessonId(lessonId)
      try {
        const res = await fetch(`/api/platform/lessons/${lessonId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
        if (!res.ok) throw new Error(String(res.status))
        toast.success(t('lessons.updated'))
        await load()
      } catch {
        toast.error(t('lessons.updateError'))
      } finally {
        setBusyLessonId(null)
      }
    },
    [t, load],
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
        toast.error(t('lessons.loadError'))
        setProvenanceOpen(false)
      }
    },
    [t],
  )

  const counts = overview?.counts ?? {}

  return (
    <SectionCard
      title={t('lessons.title')}
      description={t('lessons.description')}
      loading={loading}
      skeletonRows={4}
      error={error}
      errorMessage={t('lessons.loadError')}
      onRetry={() => void load()}
      empty={!loading && !error && (overview?.lessons.length ?? 0) === 0}
      emptyIcon={Bandage}
      emptyTitle={t('lessons.emptyTitle')}
      emptyDescription={t('lessons.emptyBody')}
      testId="platform-lessons"
      action={
        <Button variant="outline" size="sm" onClick={() => void handleSweep()} disabled={sweeping}>
          <RefreshCw
            className={`size-3.5 ${sweeping ? 'animate-spin motion-reduce:animate-none' : ''}`}
            aria-hidden
          />
          {sweeping ? t('lessons.sweeping') : t('lessons.sweep')}
        </Button>
      }
    >
      {/* The doctrine, where nobody can miss it: this register is the weakest
          ratchet, and looking away from root causes is its failure mode. */}
      {/* `border-warning` / `bg-warning-subtle` solid classes on purpose: the
          warning tokens are static @utilities, so slash-opacity forms compile
          to nothing (see gotchas.md — check-static-utility-modifiers). */}
      <div className="mb-4 flex gap-3 rounded-lg border border-warning bg-warning-subtle p-4">
        <Bandage className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('lessons.doctrineTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('lessons.doctrineBody')}</p>
        </div>
      </div>

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
        onConfirm={() => {
          if (retireTarget) void patchLesson(retireTarget.id, { status: 'retired' })
          setRetireTarget(null)
        }}
      />

      <Dialog open={provenanceOpen} onOpenChange={setProvenanceOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('lessons.provenanceTitle')}</DialogTitle>
            <DialogDescription>{t('lessons.provenanceSubtitle')}</DialogDescription>
          </DialogHeader>
          {provenance ? (
            <div className="flex flex-col gap-5">
              <p className="rounded-md border bg-muted/40 p-3 text-sm">{provenance.lesson.content}</p>
              <section>
                <h3 className="text-sm font-medium">{t('lessons.provenanceReports')}</h3>
                <ul className="mt-2 flex flex-col divide-y">
                  {provenance.reports.length === 0 && (
                    <li className="py-2 text-sm text-muted-foreground">
                      {t('lessons.provenanceNoReports')}
                    </li>
                  )}
                  {provenance.reports.map((report) => (
                    <li key={report.id} className="py-2">
                      <p className="text-sm">
                        {report.canonicalSummary ?? t('lessons.provenanceNoSummary')}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {formatDate(report.createdAt)}
                        {report.reason
                          ? ` · ${t(`answerFeedback.reasons.${report.reason}`)}`
                          : ''}
                        {` · ${t('lessons.provenanceOrg', { hash: report.orgHash.slice(0, 8) })}`}
                        {` · ${t('lessons.provenanceFeedback', { id: report.feedbackId.slice(0, 8) })}`}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
              <section>
                <h3 className="text-sm font-medium">{t('lessons.provenanceEvents')}</h3>
                <ul className="mt-2 flex flex-col divide-y">
                  {provenance.events.map((event) => (
                    <li key={event.id} className="flex items-baseline justify-between gap-3 py-1.5">
                      <span className="text-sm">{t(`lessons.eventActions.${event.action}`)}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {event.actorEmail ?? event.actor} · {formatDate(event.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">{tc('states.loading')}</p>
          )}
        </DialogContent>
      </Dialog>

      <div className="flex flex-col gap-6">
        {groups.map((group) => (
          <section key={group.status}>
            <h3 className="flex items-center gap-2 text-sm font-medium">
              {t(`lessons.groups.${group.status}`)}
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {counts[group.status] ?? group.lessons.length}
              </Badge>
            </h3>
            <ul className="mt-2 flex flex-col divide-y">
              {group.lessons.map((lesson) => {
                const busy = busyLessonId === lesson.id
                return (
                  <li key={lesson.id} className="flex flex-col gap-2 py-3">
                    <p className="text-sm">{lesson.content}</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{t(`answerFeedback.reasons.${lesson.category}`)}</span>
                      <span>{t('lessons.reportMeta', { count: lesson.reportCount })}</span>
                      <span>{t('lessons.orgMeta', { count: lesson.orgCount })}</span>
                      <span>{t('lessons.lastReported', { date: formatDate(lesson.lastReportedAt) })}</span>
                      {lesson.heldReason && (
                        <Badge variant="outline" className="font-normal text-warning">
                          {t(`lessons.held.${lesson.heldReason}`)}
                        </Badge>
                      )}
                      {lesson.retiredReason === 'evicted_capacity' && (
                        <Badge variant="outline" className="font-normal text-muted-foreground">
                          {t('lessons.evicted')}
                        </Badge>
                      )}
                      <Badge
                        variant={lesson.rootCauseStatus === 'open' ? 'outline' : 'secondary'}
                        className={`font-normal ${lesson.rootCauseStatus === 'open' ? 'text-warning' : ''}`}
                      >
                        {t(`lessons.rootCause.${lesson.rootCauseStatus}`)}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {lesson.status !== 'active' && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void patchLesson(lesson.id, { status: 'active' })}
                        >
                          {t('lessons.activate')}
                        </Button>
                      )}
                      {lesson.status === 'active' && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => setRetireTarget(lesson)}
                        >
                          {t('lessons.retire')}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void patchLesson(lesson.id, {
                            rootCauseStatus: lesson.rootCauseStatus === 'open' ? 'addressed' : 'open',
                          })
                        }
                      >
                        {lesson.rootCauseStatus === 'open'
                          ? t('lessons.markAddressed')
                          : t('lessons.reopenRootCause')}
                      </Button>
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
