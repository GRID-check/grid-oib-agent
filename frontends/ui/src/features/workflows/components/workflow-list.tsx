'use client'

/**
 * Workflows list view — the default Workflows tab surface. The GRID template
 * gallery sits at the top (always visible; cards open the builder pre-filled),
 * followed by the configured workflows: cards for each saved brief with
 * name/description, an enable switch (PATCH), a humanized schedule summary,
 * next/last run, and actions (run now, edit, delete, and an expandable run
 * history). Empty and error states reuse the shared primitives.
 */

import { type JSX, useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  CalendarClock,
  ChevronDown,
  History,
  Pencil,
  Play,
  Plus,
  Trash2,
  Workflow as WorkflowIcon,
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
  deleteWorkflow,
  listWorkflows,
  runWorkflow,
  updateWorkflow,
  WorkflowApiError,
  type WorkflowSummary,
} from '@/adapters/api/workflows-client'
import { presetForCron } from '../lib/schedule'
import { resolveAllTemplates, type ResolvedTemplate } from '../lib/templates'
import { RunHistory } from './run-history'
import { TemplateCards } from './template-cards'
import { ConfirmDeleteDialog } from './confirm-delete-dialog'

interface WorkflowListProps {
  projectId: string
  onCreate: () => void
  /** Open the builder pre-filled from a GRID default template. */
  onUseTemplate: (template: ResolvedTemplate) => void
  onEdit: (workflowId: string) => void
  /** Id whose detail is currently being fetched for editing (shows a spinner). */
  openingId: string | null
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

function WorkflowCard({
  projectId,
  workflow,
  onEdit,
  opening,
  onChanged,
  onDeleted,
}: {
  projectId: string
  workflow: WorkflowSummary
  onEdit: (id: string) => void
  opening: boolean
  onChanged: (next: WorkflowSummary) => void
  onDeleted: (id: string) => void
}): JSX.Element {
  const t = useTranslations('workflows')
  const { locale } = useLocale()
  const [toggling, setToggling] = useState(false)
  const [running, setRunning] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const toggleEnabled = async (enabled: boolean) => {
    setToggling(true)
    // Optimistic — revert on failure.
    onChanged({ ...workflow, enabled })
    try {
      const updated = await updateWorkflow(projectId, workflow.id, { enabled })
      onChanged(updated)
    } catch {
      onChanged({ ...workflow, enabled: !enabled })
      toast.error(t('list.toggleError'))
    } finally {
      setToggling(false)
    }
  }

  const runNow = async () => {
    setRunning(true)
    try {
      const result = await runWorkflow(projectId, workflow.id)
      if (result.status === 'submitted') {
        toast.success(t('run.submitted'), { description: t('run.submittedDetail') })
        onChanged({ ...workflow, lastRunAt: new Date().toISOString() })
      } else if (result.status === 'skipped') {
        toast.warning(t('run.skipped'), { description: result.detail ?? undefined })
      } else {
        toast.error(t('run.error'), { description: result.detail ?? undefined })
      }
    } catch (err) {
      if (err instanceof WorkflowApiError && err.status === 409) {
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
      await deleteWorkflow(projectId, workflow.id)
      setConfirmOpen(false)
      onDeleted(workflow.id)
    } catch {
      toast.error(t('deleteDialog.error'))
    } finally {
      setDeleting(false)
    }
  }

  const nextRun = workflow.nextRunAt
    ? t('list.nextRun', { time: formatRelativeTime(workflow.nextRunAt, locale) })
    : null
  const lastRun = workflow.lastRunAt
    ? t('list.lastRun', { time: formatRelativeTime(workflow.lastRunAt, locale) })
    : t('list.neverRun')

  return (
    <Card className={cn(!workflow.enabled && 'opacity-75')}>
      <CardContent className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-foreground">{workflow.name}</h3>
              {!workflow.enabled && <Badge variant="secondary">{t('list.disabled')}</Badge>}
            </div>
            {workflow.description && (
              <p className="line-clamp-2 text-sm text-muted-foreground">{workflow.description}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {toggling && <Spinner size="sm" />}
            <Switch
              checked={workflow.enabled}
              disabled={toggling}
              onCheckedChange={(checked) => void toggleEnabled(checked)}
              aria-label={
                workflow.enabled
                  ? t('list.disableAria', { name: workflow.name })
                  : t('list.enableAria', { name: workflow.name })
              }
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <CalendarClock className="size-3.5" aria-hidden />
            {scheduleSummary(t, workflow.scheduleCron, workflow.scheduleTimezone)}
          </span>
          {nextRun && <span>{nextRun}</span>}
          <span title={workflow.lastRunAt ? formatAbsoluteTime(workflow.lastRunAt, locale) : undefined}>
            {lastRun}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void runNow()} disabled={running || !workflow.enabled}>
            {running ? <Spinner size="sm" /> : <Play className="size-3.5" aria-hidden />}
            {running ? t('actions.running') : t('actions.runNow')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onEdit(workflow.id)} disabled={opening}>
            {opening ? <Spinner size="sm" /> : <Pencil className="size-3.5" aria-hidden />}
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
            {historyOpen && <RunHistory projectId={projectId} workflowId={workflow.id} />}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>

      <ConfirmDeleteDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('deleteDialog.title')}
        description={t('deleteDialog.description', { name: workflow.name })}
        confirmLabel={t('deleteDialog.confirm')}
        cancelLabel={t('deleteDialog.cancel')}
        pending={deleting}
        onConfirm={confirmDelete}
      />
    </Card>
  )
}

export function WorkflowList({
  projectId,
  onCreate,
  onUseTemplate,
  onEdit,
  openingId,
}: WorkflowListProps): JSX.Element {
  const t = useTranslations('workflows')
  const templates = resolveAllTemplates(t)
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(() => {
    setWorkflows(null)
    setError(false)
    listWorkflows(projectId)
      .then(setWorkflows)
      .catch(() => setError(true))
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  const handleChanged = useCallback((next: WorkflowSummary) => {
    setWorkflows((prev) => prev?.map((w) => (w.id === next.id ? next : w)) ?? prev)
  }, [])

  const handleDeleted = useCallback((id: string) => {
    setWorkflows((prev) => prev?.filter((w) => w.id !== id) ?? prev)
  }, [])

  return (
    <div className="mx-auto w-full max-w-[1080px] px-6 pb-10 pt-6 md:px-10 md:pt-[34px]">
      <header className="mb-7 flex min-h-9 items-center">
        <h1 className="text-[20px] font-medium tracking-[-0.01em] text-foreground">{t('title')}</h1>
      </header>

      {/* Curated template gallery — always visible, cards pre-fill the builder. */}
      {templates.length > 0 && <TemplateCards onUse={onUseTemplate} />}

      {/* Configured workflows + their run history. */}
      <section
        className="mt-10 space-y-4"
        aria-labelledby="configured-workflows-heading"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="configured-workflows-heading" className="text-sm font-semibold text-foreground">
            {t('list.heading')}
          </h2>
          <Button size="sm" onClick={onCreate}>
            <Plus className="size-4" aria-hidden />
            {t('newWorkflow')}
          </Button>
        </div>

        {workflows === null && !error && (
          <div className="space-y-3" data-testid="workflows-loading">
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

        {workflows !== null && !error && workflows.length === 0 && (
          <EmptyState
            icon={WorkflowIcon}
            title={t('list.empty.title')}
            description={t('list.empty.description')}
            action={
              <Button onClick={onCreate}>
                <Plus className="size-4" aria-hidden />
                {t('list.empty.action')}
              </Button>
            }
          />
        )}

        {workflows !== null && !error && workflows.length > 0 && (
          <div className="space-y-4">
            {workflows.map((workflow) => (
              <WorkflowCard
                key={workflow.id}
                projectId={projectId}
                workflow={workflow}
                onEdit={onEdit}
                opening={openingId === workflow.id}
                onChanged={handleChanged}
                onDeleted={handleDeleted}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
