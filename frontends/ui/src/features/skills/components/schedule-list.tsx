'use client'

/**
 * Skill schedules list — the "Schedules" section of the Skills tab. One card
 * per project schedule: name, the pinned skill, an enable switch (PATCH,
 * optimistic), a humanized schedule summary, next/last run, and actions
 * (run now, edit, delete, and an expandable run history). Run-now and all
 * mutations require project:skills:manage — without it the card is read-only.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  CalendarClock,
  ChevronDown,
  History,
  Pencil,
  Play,
  Plus,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useLocale, useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import {
  deleteSkillSchedule,
  listSkillSchedules,
  runSkillSchedule,
  SkillApiError,
  updateSkillSchedule,
  type SkillSchedule,
} from '@/adapters/api/skills-client'
import { presetForCron } from '../lib/schedule'
import { RunHistory } from './run-history'
import { ConfirmDeleteDialog } from './confirm-delete-dialog'

interface ScheduleListProps {
  projectId: string
  /** Qdrant collection of this project — scopes the run history's live job statuses. */
  projectCollection: string | null
  /** Whether this member may create/edit/delete/run schedules (project:skills:manage). */
  canManage: boolean
  onCreate: () => void
  onEdit: (schedule: SkillSchedule) => void
}

type Translate = ReturnType<typeof useTranslations>

/** Humanized schedule summary for a card, including the timezone. */
function scheduleSummary(t: Translate, cron: string | null, timezone: string): string {
  if (!cron) return t('list.manualOnly')
  const preset = presetForCron(cron)
  const summary =
    preset === 'hourly'
      ? t('schedule.summaryHourly')
      : preset === 'daily'
        ? t('schedule.summaryDaily')
        : preset === 'weekly'
          ? t('schedule.summaryWeekly')
          : preset === 'monthly'
            ? t('schedule.summaryMonthly')
            : t('schedule.summaryCustom', { cron })
  return t('schedule.inTimezone', { summary, timezone })
}

function ScheduleCard({
  projectId,
  projectCollection,
  schedule,
  canManage,
  onEdit,
  onChanged,
  onDeleted,
}: {
  projectId: string
  projectCollection: string | null
  schedule: SkillSchedule
  canManage: boolean
  onEdit: (schedule: SkillSchedule) => void
  onChanged: (next: SkillSchedule) => void
  onDeleted: (id: string) => void
}): JSX.Element {
  const t = useTranslations('skills')
  const { locale } = useLocale()
  const router = useRouter()
  const [toggling, setToggling] = useState(false)
  const [running, setRunning] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Remounts the run history so a just-started run shows up immediately.
  const [historyToken, setHistoryToken] = useState(0)

  const toggleEnabled = async (enabled: boolean) => {
    setToggling(true)
    // Optimistic — revert on failure.
    onChanged({ ...schedule, enabled })
    try {
      const updated = await updateSkillSchedule(projectId, schedule.id, { enabled })
      onChanged(updated)
    } catch {
      onChanged({ ...schedule, enabled: !enabled })
      toast.error(t('list.toggleError'))
    } finally {
      setToggling(false)
    }
  }

  const runNow = async () => {
    setRunning(true)
    try {
      const result = await runSkillSchedule(projectId, schedule.id)
      if (result.status === 'submitted') {
        // The run is now a live job. Open the history (so the new row and its
        // status are visible right away) and offer a one-click jump into the
        // research panel that follows it.
        const jobId = result.jobId
        toast.success(t('run.submitted'), {
          description: t('run.submittedDetail'),
          ...(jobId
            ? {
                action: {
                  label: t('run.viewProgress'),
                  onClick: () =>
                    router.push(`/app/projects/${projectId}/chat?job=${jobId}&tab=tasks`),
                },
              }
            : {}),
        })
        setHistoryOpen(true)
        setHistoryToken((token) => token + 1)
        onChanged({ ...schedule, lastRunAt: new Date().toISOString() })
      } else if (result.status === 'skipped') {
        toast.warning(t('run.skipped'), { description: result.detail ?? undefined })
      } else {
        toast.error(t('run.error'), { description: result.detail ?? undefined })
      }
    } catch (err) {
      if (err instanceof SkillApiError && err.status === 409) {
        toast.error(t('run.disabled'))
      } else {
        toast.error(t('run.error'))
      }
    } finally {
      setRunning(false)
    }
  }

  const confirmDelete = async () => {
    setDeleting(true)
    try {
      await deleteSkillSchedule(projectId, schedule.id)
      setConfirmOpen(false)
      onDeleted(schedule.id)
    } catch {
      toast.error(t('deleteDialog.error'))
    } finally {
      setDeleting(false)
    }
  }

  const nextRun = schedule.nextRunAt
    ? t('list.nextRun', { time: formatRelativeTime(schedule.nextRunAt, locale) })
    : null
  const lastRun = schedule.lastRunAt
    ? t('list.lastRun', { time: formatRelativeTime(schedule.lastRunAt, locale) })
    : t('list.neverRun')

  return (
    <Card className={cn(!schedule.enabled && 'opacity-75')}>
      <CardContent className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-foreground">{schedule.name}</h3>
              {!schedule.enabled && <Badge variant="secondary">{t('list.disabled')}</Badge>}
            </div>
            {schedule.skillSnapshot.description && (
              <p className="line-clamp-2 text-sm text-muted-foreground">
                {schedule.skillSnapshot.description}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {toggling && <Spinner size="sm" />}
            {canManage && (
              <Switch
                checked={schedule.enabled}
                disabled={toggling}
                onCheckedChange={(checked) => void toggleEnabled(checked)}
                aria-label={
                  schedule.enabled
                    ? t('list.disableAria', { name: schedule.name })
                    : t('list.enableAria', { name: schedule.name })
                }
              />
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <CalendarClock className="size-3.5" aria-hidden />
            {scheduleSummary(t, schedule.scheduleCron, schedule.scheduleTimezone)}
          </span>
          {nextRun && <span>{nextRun}</span>}
          <span
            title={schedule.lastRunAt ? formatAbsoluteTime(schedule.lastRunAt, locale) : undefined}
          >
            {lastRun}
          </span>
        </div>

        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => void runNow()}
              disabled={running || !schedule.enabled}
            >
              {running ? <Spinner size="sm" /> : <Play className="size-3.5" aria-hidden />}
              {running ? t('actions.running') : t('actions.runNow')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onEdit(schedule)}>
              <Pencil className="size-3.5" aria-hidden />
              {t('actions.edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmOpen(true)}
            >
              <Trash2 className="size-3.5" aria-hidden />
              {t('actions.delete')}
            </Button>
          </div>
        )}

        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="text-muted-foreground">
              <History className="size-3.5" aria-hidden />
              {t('actions.history')}
              <ChevronDown
                className={cn('size-3.5 transition-transform', historyOpen && 'rotate-180')}
                aria-hidden
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t border-border pt-1">
            {historyOpen && (
              <RunHistory
                key={historyToken}
                projectId={projectId}
                projectCollection={projectCollection}
                scheduleId={schedule.id}
              />
            )}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>

      <ConfirmDeleteDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('deleteDialog.title')}
        description={t('deleteDialog.description', { name: schedule.name })}
        confirmLabel={t('deleteDialog.confirm')}
        cancelLabel={t('deleteDialog.cancel')}
        pending={deleting}
        onConfirm={confirmDelete}
      />
    </Card>
  )
}

export function ScheduleList({
  projectId,
  projectCollection,
  canManage,
  onCreate,
  onEdit,
}: ScheduleListProps): JSX.Element {
  const t = useTranslations('skills')
  const [schedules, setSchedules] = useState<SkillSchedule[] | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(() => {
    setSchedules(null)
    setError(false)
    listSkillSchedules(projectId)
      .then(setSchedules)
      .catch(() => setError(true))
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  const handleChanged = useCallback((next: SkillSchedule) => {
    setSchedules((prev) => prev?.map((s) => (s.id === next.id ? next : s)) ?? prev)
  }, [])

  const handleDeleted = useCallback((id: string) => {
    setSchedules((prev) => prev?.filter((s) => s.id !== id) ?? prev)
  }, [])

  return (
    <section className="mt-10 space-y-4" aria-labelledby="skill-schedules-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="skill-schedules-heading" className="text-sm font-semibold text-foreground">
          {t('list.heading')}
        </h2>
        {canManage && (
          <Button size="sm" onClick={onCreate}>
            <Plus className="size-4" aria-hidden />
            {t('list.empty.action')}
          </Button>
        )}
      </div>

      {schedules === null && !error && (
        <div className="space-y-3" data-testid="schedules-loading">
          <Skeleton className="h-36 w-full rounded-xl" />
          <Skeleton className="h-36 w-full rounded-xl" />
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" aria-hidden />
          <AlertTitle>{t('loadError')}</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="sm" onClick={load}>
              {t('tryAgain')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {schedules !== null && !error && schedules.length === 0 && (
        <EmptyState
          icon={CalendarClock}
          title={t('list.empty.title')}
          description={t('list.empty.description')}
          action={
            canManage ? (
              <Button onClick={onCreate}>
                <Plus className="size-4" aria-hidden />
                {t('list.empty.action')}
              </Button>
            ) : undefined
          }
        />
      )}

      {schedules !== null && !error && schedules.length > 0 && (
        <div className="space-y-4">
          {schedules.map((schedule) => (
            <ScheduleCard
              key={schedule.id}
              projectId={projectId}
              projectCollection={projectCollection}
              schedule={schedule}
              canManage={canManage}
              onEdit={onEdit}
              onChanged={handleChanged}
              onDeleted={handleDeleted}
            />
          ))}
        </div>
      )}
    </section>
  )
}