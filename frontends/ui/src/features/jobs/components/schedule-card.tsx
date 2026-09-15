'use client'

/**
 * One standing schedule, as the product's card.
 *
 * A schedule is not work — it is a COMMITMENT — so the card answers the two
 * questions a commitment raises and nothing else: when does this fire next, and
 * is it still on. Its lifecycle, its runs and its prompt live in the drawer; a
 * card that tried to carry them would be a worse version of the drawer stacked
 * eight times down a page.
 *
 * The pause switch sits on the card rather than behind a click because pausing
 * is the one thing a person does to a schedule in passing ("we are on site this
 * week, stop the Monday scan"), and it stops the click from propagating so the
 * toggle never also opens the drawer.
 *
 * Paused is drawn by draining the card, not by adding a red chip: a paused
 * schedule is not a problem, it is a thing switched off, and the surface should
 * look like one switch is off rather than like something is wrong.
 */

import type { KeyboardEvent, MouseEvent } from 'react'
import { useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { toast } from 'sonner'

import { Chip } from '@/components/ui/chip'
import { RaisedCard, RaisedCardBody, RaisedCardFooter } from '@/components/ui/raised-card'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { updateJob, type Job } from '@/adapters/api/jobs-client'
import { scheduleSummary } from '../lib/schedule'

type Translate = ReturnType<typeof useTranslations>

export interface ScheduleCardProps {
  job: Job
  /** Whether this member may pause/resume schedules (`project:skills:manage`). */
  canManage: boolean
  onChanged?: (job: Job) => void
  onSelect: (job: Job) => void
  /**
   * The colour this schedule wears on the timetable, so the card and the block
   * are recognisably the same thing. Omitted for a schedule the grid cannot
   * place (no cron, or paused).
   */
  accent?: string
}

export function ScheduleCard({
  job,
  canManage,
  onChanged,
  onSelect,
  accent,
}: ScheduleCardProps): JSX.Element {
  const t = useTranslations('jobs')
  const { locale } = useLocale()

  const nextRun = job.nextRunAt
    ? t('list.nextRun', { time: formatRelativeTime(job.nextRunAt, locale) })
    : null
  const lastRun = job.lastRunAt
    ? t('list.lastRun', { time: formatRelativeTime(job.lastRunAt, locale) })
    : t('list.neverRun')

  const open = (): void => onSelect(job)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    open()
  }

  return (
    <RaisedCard interactive>
      <div
        role="button"
        data-testid="schedule-card"
        tabIndex={0}
        onClick={open}
        onKeyDown={onKeyDown}
        aria-label={t('card.openAria', { name: job.name })}
        className="focus-visible:ring-ring/60 flex h-full min-w-0 flex-col rounded-lg outline-none focus-visible:ring-2"
      >
        <RaisedCardBody className="flex flex-1 flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div
              className={cn(
                'flex min-w-0 flex-1 flex-col gap-2 transition-opacity duration-quick ease-out motion-reduce:transition-none',
                !job.enabled && 'opacity-45',
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                {accent && (
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-[3px]"
                    style={{ backgroundColor: accent }}
                  />
                )}
                <h3 className="text-foreground min-w-0 truncate text-sm font-semibold">
                  {job.name}
                </h3>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip
                  size="sm"
                  variant={job.scheduleCron ? 'info' : 'outline'}
                  data-testid="schedule-cadence"
                >
                  <CalendarClock aria-hidden />
                  {scheduleSummary(t, job.scheduleCron, job.scheduleTimezone, locale, {
                    withTimezone: false,
                  })}
                </Chip>
                <Chip size="sm" variant="secondary">
                  {t(`list.output.${job.output}`)}
                </Chip>
                {!job.enabled && (
                  <Chip size="sm" variant="outline" data-testid="schedule-paused">
                    {t('list.disabled')}
                  </Chip>
                )}
              </div>
              {/* WHAT IT DOES, not what it uses.
                  This line used to read „Skill: schallschutz-bericht" or „Kein
                  Skill", which is machinery: it names a component of the run to
                  somebody deciding whether this schedule is the one they were
                  looking for. Two thirds of the cards said "Kein Skill", which
                  is a line spent telling a reader that nothing is there.
                  The request itself is the answer — it is what fires, in the
                  words the person wrote — clamped to two lines so a long prompt
                  cannot set the height of every card beside it. The skill is
                  still one click away, in the drawer, where machinery belongs. */}
              <p className="text-muted-foreground line-clamp-2 text-sm leading-relaxed">
                {job.prompt}
              </p>
            </div>
            {canManage && (
              <ScheduleEnableSwitch job={job} onChanged={onChanged} t={t} />
            )}
          </div>
        </RaisedCardBody>

        <RaisedCardFooter>
          <span
            className="min-w-0 truncate"
            title={job.nextRunAt ? formatAbsoluteTime(job.nextRunAt, locale) : undefined}
          >
            {nextRun ? `${nextRun} · ${lastRun}` : lastRun}
          </span>
        </RaisedCardFooter>
      </div>
    </RaisedCard>
  )
}

/**
 * The pause switch the card and the drawer share. Optimistic — reverts on
 * failure — and it swallows its own clicks so toggling inside an interactive
 * card never also opens the card.
 */
export function ScheduleEnableSwitch({
  job,
  onChanged,
  t,
}: {
  job: Job
  onChanged: ((job: Job) => void) | undefined
  t: Translate
}): JSX.Element {
  const [toggling, setToggling] = useState(false)

  const toggleEnabled = async (enabled: boolean) => {
    setToggling(true)
    onChanged?.({ ...job, enabled })
    try {
      const updated = await updateJob(job.projectId, job.id, { enabled })
      onChanged?.(updated)
    } catch {
      onChanged?.({ ...job, enabled: !enabled })
      toast.error(t('list.toggleError'))
    } finally {
      setToggling(false)
    }
  }

  return (
    <span
      className="flex shrink-0 items-center gap-2 pt-0.5"
      onClick={(event: MouseEvent) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {toggling && <Spinner size="sm" />}
      <Switch
        checked={job.enabled}
        disabled={toggling}
        onCheckedChange={(checked) => void toggleEnabled(checked)}
        aria-label={
          job.enabled
            ? t('list.disableAria', { name: job.name })
            : t('list.enableAria', { name: job.name })
        }
      />
    </span>
  )
}
