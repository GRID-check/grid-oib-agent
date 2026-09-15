'use client'

/**
 * The schedule wizard — four steps, one decision each.
 *
 * What this replaced was one page holding six stacked cards: name, prompt,
 * output, skill, data sources, cron, timezone, two switches, and a live preview
 * pane beside them. Every field was justified on its own and the page was still
 * wrong, because the cost of a form is not the number of fields — it is the
 * number a person has to hold in mind AT ONCE. Sixteen controls with no stated
 * order is a page you read three times before touching anything, and the first
 * thing most people did with it was leave.
 *
 * The rules this is built to, in the order they mattered:
 *
 *   1. **One required decision per step.** Step 1 asks what Piloti should do.
 *      Step 2 asks what should come out. Step 3 asks when. Step 4 asks nothing
 *      and shows what will happen. Nothing else is required anywhere.
 *   2. **Everything optional is folded away.** The skill, the data sources, the
 *      timezone and the raw cron field live behind one "Erweitert" disclosure
 *      per step, shut by default. They are not hidden because they do not
 *      matter; they are hidden because the dictionary's own copy says most
 *      schedules need none of them, and an option nobody needs still costs
 *      every reader the moment it takes to rule it out.
 *   3. **The form arrives half-answered.** The name proposes itself from the
 *      first line of the prompt, the timezone is the browser's, the schedule
 *      starts at weekly-Monday-06:00, the output at Chat. Endowed progress: a
 *      form that starts empty is a form you start; one that starts answered is
 *      one you finish.
 *   4. **The claim is made checkable.** Step 3 shows the next three real fire
 *      times, computed by the library the scheduler itself advances rows with.
 *      A cron expression — or the sentence built from one — is something nobody
 *      can verify by reading it.
 *   5. **Going back costs nothing.** Every visited step is a button on the
 *      rail, and no state is dropped when you leave a step. A form that
 *      punishes correction gets answered defensively.
 *
 * The server still owns validation (cron parseability and minimum interval,
 * prompt length, name rules) and snapshot semantics. This wizard only mirrors
 * the client-knowable rules, for instant feedback.
 *
 * Scalar text fields use TanStack Form + Zod (`components/form`); the dynamic
 * pieces — the skill picker, the data-source checkboxes, the schedule composer
 * — are local state merged on submit, as before.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  ChevronDown,
  FileText,
  Lock,
  MessageSquare,
  ScrollText,
} from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'

import { useAppForm } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Chip } from '@/components/ui/chip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Stepper } from '@/components/ui/stepper'
import { Switch } from '@/components/ui/switch'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { createDataSourcesClient, type DataSourceFromAPI } from '@/adapters/api/data-sources-client'
import {
  createJob,
  listAttachableSkills,
  updateJob,
  JobApiError,
  type AttachableSkill,
  type CreateJobInput,
  type Job,
  type JobOutput,
} from '@/adapters/api/jobs-client'
import type { SkillSnapshot } from '@/adapters/api/skills-client'
import { buildFirePromptPreview } from '../lib/fire-prompt-preview'
import { nextOccurrences } from '../lib/occurrences'
import {
  buildCron,
  browserTimezone,
  DEFAULT_CRON_PARTS,
  isPlausibleCron,
  partsToTimeValue,
  parseCronParts,
  SCHEDULE_FREQUENCIES,
  scheduleSummary,
  supportedTimezones,
  timeValueToParts,
  weekdayName,
  type CronParts,
} from '../lib/schedule'
import type { ScheduleDraft } from '../lib/schedule-draft'

/** The always-included knowledge source: a pinned row, never a checkbox. */
const KNOWLEDGE_LAYER_ID = 'knowledge_layer'

/**
 * The picker's "no skill" value.
 *
 * A sentinel rather than the empty string: Radix reserves `''` for "nothing
 * selected", and "no skill" here is a CHOICE the reader can make explicitly —
 * it has to be a selectable row, not the absence of one.
 */
const NO_SKILL = '__none__'

/** The two output kinds, in the order they are offered. */
const JOB_OUTPUTS: readonly JobOutput[] = ['chat', 'deep-research']

const STEP_KEYS = ['task', 'output', 'schedule', 'review'] as const
type StepKey = (typeof STEP_KEYS)[number]

/** How many upcoming fire times step 3 proves the schedule with. */
const PREVIEW_COUNT = 3

/** Longest name the wizard will propose from a prompt's first line. */
const NAME_SUGGESTION_MAX = 60

interface ScheduleWizardProps {
  projectId: string
  /** The schedule being edited, or null when creating. */
  job: Job | null
  /** A pre-filled draft — a task the reader asked to make recurring. */
  draft?: ScheduleDraft | null
  onSaved: () => void
  onCancel: () => void
}

interface WizardValues {
  name: string
  prompt: string
}

/** The picker rows and the pinned snapshot share this shape. */
function toSnapshot(item: AttachableSkill): SkillSnapshot {
  return {
    name: item.name,
    description: item.description,
    body: item.body,
    metadata: item.metadata,
    origin: item.origin,
  }
}

/**
 * A name proposed from the prompt's first line.
 *
 * The name is a label on a list, not a second statement of intent, and asking
 * for it before the prompt asks a person to summarise something they have not
 * written yet. So it proposes itself and stays editable — and it stops
 * proposing the moment the reader types their own, because a field that
 * overwrites what you typed is worse than one that starts empty.
 */
export function suggestName(prompt: string): string {
  const firstLine = prompt.trim().split('\n')[0]?.trim() ?? ''
  if (firstLine.length <= NAME_SUGGESTION_MAX) return firstLine
  const clipped = firstLine.slice(0, NAME_SUGGESTION_MAX)
  const lastSpace = clipped.lastIndexOf(' ')
  return `${(lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`
}

export function ScheduleWizard({
  projectId,
  job,
  draft,
  onSaved,
  onCancel,
}: ScheduleWizardProps): JSX.Element {
  const t = useTranslations('jobs')
  const { locale } = useLocale()

  const [stepIndex, setStepIndex] = useState(0)
  // The furthest step reached, so the rail can offer a jump back without ever
  // offering a jump forward past a question that has not been answered.
  const [furthest, setFurthest] = useState(0)

  // --- What comes out, and everything that follows from it -----------------
  const [output, setOutput] = useState<JobOutput>(job?.output ?? 'chat')
  const [attachable, setAttachable] = useState<AttachableSkill[] | null>(null)
  const [skillsError, setSkillsError] = useState(false)
  const [skill, setSkill] = useState<SkillSnapshot | null>(job?.skillSnapshot ?? null)
  /** Set when switching output dropped the attachment — shown, never silent. */
  const [detached, setDetached] = useState<{ name: string; output: JobOutput } | null>(null)
  /**
   * The attachment as the picker effect sees it. A ref, not a dependency: the
   * effect re-fetches on OUTPUT change, and listing `skill` would make every
   * pick of a skill re-request the list it was picked from.
   */
  const skillRef = useRef<SkillSnapshot | null>(skill)
  skillRef.current = skill

  // --- Sources --------------------------------------------------------------
  const [sources, setSources] = useState<DataSourceFromAPI[] | null>(null)
  const [sourcesError, setSourcesError] = useState(false)
  const [selectedSources, setSelectedSources] = useState<Set<string>>(
    new Set(job?.dataSources ?? []),
  )

  // --- When -----------------------------------------------------------------
  const [enabled, setEnabled] = useState<boolean>(job?.enabled ?? true)
  const [scheduleEnabled, setScheduleEnabled] = useState<boolean>(
    job ? Boolean(job.scheduleCron) : true,
  )
  /**
   * Whether the schedule is being written as a raw cron expression.
   *
   * Decided once, from the row being edited: a schedule whose cron the composer
   * cannot round-trip opens in the cron field, because rewriting it into the
   * nearest thing the composer CAN express would silently change when somebody
   * else's schedule fires.
   */
  const [customCron, setCustomCron] = useState<boolean>(
    Boolean(job?.scheduleCron) && parseCronParts(job?.scheduleCron) === null,
  )
  const [parts, setParts] = useState<CronParts>(
    () => parseCronParts(job?.scheduleCron) ?? DEFAULT_CRON_PARTS,
  )
  const [cron, setCron] = useState<string>(job?.scheduleCron ?? buildCron(DEFAULT_CRON_PARTS))
  const [timezone, setTimezone] = useState<string>(job?.scheduleTimezone ?? browserTimezone())
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  /** The expression the schedule will actually be saved with. */
  const effectiveCron = scheduleEnabled ? (customCron ? cron.trim() : buildCron(parts)) : null

  useEffect(() => {
    const controller = new AbortController()
    createDataSourcesClient()
      .getDataSources(controller.signal)
      .then((response) => setSources(response.data_sources))
      .catch(() => {
        if (!controller.signal.aborted) setSourcesError(true)
      })
    return () => controller.abort()
  }, [])

  /**
   * The attachable skills for the CURRENT output kind.
   *
   * Re-runs whenever the output changes, and an attachment the new list does
   * not contain is dropped here — the picker must never be able to offer, or
   * keep, a skill the chosen output cannot run. A failed fetch keeps whatever
   * is attached: not knowing the list is not evidence against the attachment.
   */
  useEffect(() => {
    const controller = new AbortController()
    listAttachableSkills(output)
      .then((items) => {
        if (controller.signal.aborted) return
        setAttachable(items)
        setSkillsError(false)
        const current = skillRef.current
        if (current && !items.some((item) => item.name === current.name)) {
          setSkill(null)
          setDetached({ name: current.name, output })
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setAttachable(null)
          setSkillsError(true)
        }
      })
    return () => controller.abort()
  }, [output])

  const additionalSources = useMemo(
    () => sources?.filter((source) => source.id !== KNOWLEDGE_LAYER_ID) ?? null,
    [sources],
  )

  const schema = useMemo(
    () =>
      z.object({
        name: z.string().trim().min(1, t('builder.nameRequired')).max(200, t('builder.nameTooLong')),
        prompt: z
          .string()
          .trim()
          .min(1, t('builder.promptRequired'))
          .max(8000, t('builder.promptTooLong')),
      }),
    [t],
  )

  const form = useAppForm({
    defaultValues: {
      name: job?.name ?? draft?.name ?? '',
      prompt: job?.prompt ?? draft?.prompt ?? '',
    } satisfies WizardValues,
    validators: { onChange: schema },
    onSubmit: async ({ value }) => {
      setFormError(null)
      setScheduleError(null)

      // Client-side cron shape check for instant feedback; the server owns the
      // authoritative validation (parseability, minimum interval).
      if (effectiveCron && !isPlausibleCron(effectiveCron)) {
        setScheduleError(t('builder.cronInvalid'))
        setStepIndex(2)
        return
      }

      const payload: CreateJobInput = {
        name: value.name.trim(),
        prompt: value.prompt.trim(),
        output,
        // Explicit null, not omitted: on PATCH that is what DETACHES a skill,
        // and omitting it would leave a removed attachment in place.
        skillName: skill?.name ?? null,
        dataSources: selectedSources.size > 0 ? Array.from(selectedSources) : null,
        enabled,
        scheduleCron: effectiveCron,
        scheduleTimezone: timezone,
      }

      try {
        if (job) {
          await updateJob(projectId, job.id, payload)
          toast.success(t('builder.updateSuccess'))
        } else {
          await createJob(projectId, payload)
          toast.success(t('builder.createSuccess'))
        }
        onSaved()
      } catch (err) {
        // 400/422 are validation failures — most reach here through the
        // schedule (cron / minimum interval), so the server's message is shown
        // inline THERE, on the step that owns it, with the wizard stepped back
        // to it. An error a reader cannot see is an error they cannot fix.
        if (err instanceof JobApiError && (err.status === 400 || err.status === 422)) {
          const message = err.serverMessage ?? t('builder.saveError')
          if (scheduleEnabled) {
            setScheduleError(message)
            setStepIndex(2)
          } else {
            setFormError(message)
          }
        } else {
          setFormError(t('builder.saveError'))
        }
        toast.error(t('builder.saveError'))
      }
    },
  })

  const steps = STEP_KEYS.map((key) => ({ key, label: t(`builder.steps.${key}`) }))
  const step: StepKey = STEP_KEYS[stepIndex]

  const goTo = useCallback(
    (index: number) => {
      const next = Math.max(0, Math.min(STEP_KEYS.length - 1, index))
      // Leaving step 1 with no name accepts the one the placeholder has been
      // showing. Only while the field is empty: a name the reader typed is
      // theirs, and a field that rewrites what you typed is worse than one that
      // starts blank.
      const values = form.state.values as WizardValues
      if (values.name.trim().length === 0) {
        const suggested = suggestName(values.prompt)
        if (suggested) form.setFieldValue('name', suggested)
      }
      setStepIndex(next)
      setFurthest((reached) => Math.max(reached, next))
    },
    [form],
  )

  const toggleSource = (id: string, checked: boolean): void => {
    setSelectedSources((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const changeOutput = (next: JobOutput): void => {
    if (next === output) return
    setDetached(null)
    setAttachable(null)
    setOutput(next)
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void form.handleSubmit()
      }}
      // A readability column, not a page: every step here is a short list of
      // questions, and a form measured in the full width of a desktop viewport
      // reads as a settings page no matter how few fields it has.
      className="mx-auto flex w-full max-w-2xl flex-col gap-6"
      data-testid="schedule-wizard"
    >
      <Stepper
        steps={steps}
        current={stepIndex}
        furthest={furthest}
        onSelect={goTo}
        label={t('builder.stepsLabel')}
        progressLabel={t('builder.stepProgress', {
          current: stepIndex + 1,
          total: STEP_KEYS.length,
        })}
      />

      <div className="min-h-[22rem]">
        {/* Step 1 is rendered here rather than extracted, because it is the
            only step that binds form FIELDS and `form.AppField` has to be
            reached from the form it belongs to. */}
        {step === 'task' && (
          <section data-testid="wizard-step-task">
            <StepHeading title={t('builder.steps.taskTitle')} hint={t('builder.steps.taskHint')} />
            {/* The prompt is the only required answer in the whole wizard, so
                it gets the page: eight rows, first, and nothing above it to
                read past. */}
            <form.AppField name="prompt">
              {(field) => (
                <field.TextAreaField
                  label={t('builder.promptLabel')}
                  placeholder={t('builder.promptPlaceholder')}
                  description={t('builder.promptHint')}
                  required
                  rows={8}
                />
              )}
            </form.AppField>

            {/* The name is a LABEL on a list, not a second statement of intent,
                and asking for it first asks a person to summarise something
                they have not written yet. So the placeholder shows what this
                will be called, live, and moving on fills it in — nothing is
                ever overwritten, because the fill only happens while the field
                is still empty. */}
            <form.Subscribe selector={(state) => (state.values as WizardValues).prompt}>
              {(prompt) => (
                <form.AppField name="name">
                  {(field) => (
                    <field.TextField
                      containerClassName="mt-5"
                      label={t('builder.nameLabel')}
                      placeholder={suggestName(prompt) || t('builder.namePlaceholder')}
                      description={t('builder.nameHint')}
                    />
                  )}
                </form.AppField>
              )}
            </form.Subscribe>
          </section>
        )}

        {step === 'output' && (
          <OutputStep
            output={output}
            onOutputChange={changeOutput}
            skill={skill}
            onSkillChange={(next) => {
              setDetached(null)
              setSkill(next)
            }}
            attachable={attachable}
            skillsError={skillsError}
            detached={detached}
            sources={additionalSources}
            sourcesError={sourcesError}
            selectedSources={selectedSources}
            onToggleSource={toggleSource}
          />
        )}

        {step === 'schedule' && (
          <ScheduleStep
            scheduleEnabled={scheduleEnabled}
            onScheduleEnabledChange={(next) => {
              setScheduleEnabled(next)
              setScheduleError(null)
            }}
            customCron={customCron}
            onCustomCronChange={(next) => {
              setCustomCron(next)
              setScheduleError(null)
              // Carry the composed expression INTO the cron field rather than
              // opening it empty: the reader is refining what they just built,
              // not starting again.
              if (next) setCron(buildCron(parts))
            }}
            parts={parts}
            onPartsChange={(next) => {
              setParts(next)
              setScheduleError(null)
            }}
            cron={cron}
            onCronChange={(next) => {
              setCron(next)
              setScheduleError(null)
            }}
            timezone={timezone}
            onTimezoneChange={setTimezone}
            effectiveCron={effectiveCron}
            error={scheduleError}
            locale={locale}
          />
        )}

        {step === 'review' && (
          <form.Subscribe selector={(state) => state.values as WizardValues}>
            {(values) => (
              <ReviewStep
                values={values}
                output={output}
                skill={skill}
                sourceCount={selectedSources.size}
                effectiveCron={effectiveCron}
                timezone={timezone}
                enabled={enabled}
                onEnabledChange={setEnabled}
                locale={locale}
              />
            )}
          </form.Subscribe>
        )}
      </div>

      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <form.Subscribe
        selector={(state) =>
          [state.values as WizardValues, state.canSubmit, state.isSubmitting] as const
        }
      >
        {([values, canSubmit, isSubmitting]) => (
          <WizardNav
            step={step}
            stepIndex={stepIndex}
            // Only step 1 can block: it is the only one with a required answer.
            // A "Weiter" that refuses without saying why is the cruellest
            // control in a wizard, so the button stays enabled and the fields
            // carry their own errors — the reader is stopped by the answer, not
            // by a dead button.
            blocked={step === 'task' && values.prompt.trim().length === 0}
            isSubmitting={isSubmitting}
            canSubmit={canSubmit}
            onBack={() => (stepIndex === 0 ? onCancel() : goTo(stepIndex - 1))}
            onNext={() => goTo(stepIndex + 1)}
            editing={job !== null}
          />
        )}
      </form.Subscribe>
    </form>
  )
}


/**
 * The footer. Back is always available and never destructive — on the first
 * step it is Cancel, which is the only place leaving loses anything.
 */
function WizardNav({
  step,
  stepIndex,
  blocked,
  isSubmitting,
  canSubmit,
  onBack,
  onNext,
  editing,
}: {
  step: StepKey
  stepIndex: number
  blocked: boolean
  isSubmitting: boolean
  canSubmit: boolean
  onBack: () => void
  onNext: () => void
  editing: boolean
}): JSX.Element {
  const t = useTranslations('jobs')
  const last = step === 'review'

  return (
    <div className="border-border flex items-center justify-between gap-2 border-t pt-4">
      <Button type="button" variant="ghost" onClick={onBack}>
        <ArrowLeft className="size-4" aria-hidden />
        {stepIndex === 0 ? t('builder.cancel') : t('builder.back')}
      </Button>
      {last ? (
        <Button type="submit" disabled={!canSubmit || isSubmitting} aria-busy={isSubmitting}>
          {/* Both labels stay mounted so the button width does not jump when
              "Speichern" becomes "Wird gespeichert…". */}
          <span className="inline-grid justify-items-start">
            <span
              className={cn(
                'col-start-1 row-start-1 inline-flex items-center gap-2',
                isSubmitting && 'invisible',
              )}
              aria-hidden={isSubmitting}
            >
              <Check className="size-4" aria-hidden />
              {editing ? t('builder.save') : t('builder.create')}
            </span>
            <span
              className={cn(
                'col-start-1 row-start-1 inline-flex items-center gap-2',
                !isSubmitting && 'invisible',
              )}
              aria-hidden={!isSubmitting}
            >
              <Spinner size="sm" aria-hidden />
              {t('builder.saving')}
            </span>
          </span>
        </Button>
      ) : (
        <Button type="button" onClick={onNext} disabled={blocked} data-testid="wizard-next">
          {t('builder.next')}
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      )}
    </div>
  )
}

/** The heading every step wears: one question, one sentence under it. */
function StepHeading({ title, hint }: { title: string; hint: string }): JSX.Element {
  return (
    <div className="mb-4">
      <h2 className="text-foreground text-lg font-semibold tracking-[-0.01em]">{title}</h2>
      <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{hint}</p>
    </div>
  )
}

/**
 * The one disclosure every step gets, shut by default.
 *
 * Progressive disclosure done as a RULE rather than case by case: if a control
 * is not needed by most schedules, it goes behind this, and the label says what
 * is inside so nobody has to open it to find out. The count on the trigger is
 * how a reader knows something in there is already set — an "Erweitert" that
 * quietly holds three of your answers is a trap.
 */
function Advanced({
  label,
  summary,
  children,
}: {
  label: string
  /** What is already set inside, or null when everything is at its default. */
  summary: string | null
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-border mt-5 border-t pt-4">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 flex w-full items-center gap-2 rounded-md text-sm focus-visible:outline-none focus-visible:ring-2"
          data-testid="wizard-advanced"
        >
          <ChevronDown
            className={cn(
              'size-4 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none',
              open && 'rotate-180',
            )}
            aria-hidden
          />
          {label}
          {summary && !open && (
            <span className="text-muted-foreground/80 min-w-0 truncate text-xs">· {summary}</span>
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="duration-base ease-out motion-reduce:animate-none">
        <div className="space-y-4 pt-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Step 2 — what should come out. Two choices; everything else is folded away. */
function OutputStep({
  output,
  onOutputChange,
  skill,
  onSkillChange,
  attachable,
  skillsError,
  detached,
  sources,
  sourcesError,
  selectedSources,
  onToggleSource,
}: {
  output: JobOutput
  onOutputChange: (next: JobOutput) => void
  skill: SkillSnapshot | null
  onSkillChange: (next: SkillSnapshot | null) => void
  attachable: AttachableSkill[] | null
  skillsError: boolean
  detached: { name: string; output: JobOutput } | null
  sources: DataSourceFromAPI[] | null
  sourcesError: boolean
  selectedSources: Set<string>
  onToggleSource: (id: string, checked: boolean) => void
}): JSX.Element {
  const t = useTranslations('jobs')
  const outputLabel = (kind: JobOutput): string =>
    kind === 'chat' ? t('builder.output.chatLabel') : t('builder.output.deepResearchLabel')

  // What the folded section already holds, so nobody has to open it to find
  // out whether they set something in there.
  const advancedSummary = [
    skill ? t('builder.skillSummary', { name: skill.name }) : null,
    selectedSources.size > 0
      ? t('builder.sourcesSummary', { count: selectedSources.size })
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')

  return (
    <section data-testid="wizard-step-output">
      <StepHeading title={t('builder.steps.outputTitle')} hint={t('builder.steps.outputHint')} />

      {/* Two cards rather than a select: the choice decides which agent runs
          the schedule, and "Chat" and "Deep Research" mean nothing on their own
          to somebody setting up their first one. The sentence is the control. */}
      <div role="radiogroup" aria-label={t('builder.outputLabel')} className="grid gap-3 sm:grid-cols-2">
        {JOB_OUTPUTS.map((kind) => {
          const active = output === kind
          const Icon = kind === 'chat' ? MessageSquare : ScrollText
          return (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onOutputChange(kind)}
              data-testid={`wizard-output-${kind}`}
              className={cn(
                'focus-visible:ring-ring/60 flex flex-col items-start gap-2 rounded-xl border p-4 text-left',
                'transition-colors duration-snap ease-out focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none',
                active
                  ? 'border-primary bg-primary/5 ring-primary/15 ring-2'
                  : 'border-border hover:border-foreground/30',
              )}
            >
              <span
                className={cn(
                  'flex size-9 items-center justify-center rounded-lg',
                  active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                )}
              >
                <Icon className="size-4.5" aria-hidden />
              </span>
              <span className="text-foreground text-sm font-semibold">{outputLabel(kind)}</span>
              <span className="text-muted-foreground text-sm leading-relaxed">
                {kind === 'chat'
                  ? t('builder.output.chatHint')
                  : t('builder.output.deepResearchHint')}
              </span>
            </button>
          )
        })}
      </div>

      <Advanced label={t('builder.advancedOutput')} summary={advancedSummary || null}>
        <Field>
          <FieldLabel>{t('builder.skillLabel')}</FieldLabel>
          {attachable === null && !skillsError ? (
            <p className="text-muted-foreground flex min-h-9 items-center text-sm">
              {t('builder.skillsLoading')}
            </p>
          ) : skillsError ? (
            <p className="text-muted-foreground flex min-h-9 items-center text-sm">
              {t('builder.skillsError')}
            </p>
          ) : (
            <Select
              value={skill?.name ?? NO_SKILL}
              onValueChange={(name) => {
                if (name === NO_SKILL) {
                  onSkillChange(null)
                  return
                }
                const item = attachable?.find((entry) => entry.name === name)
                if (item) onSkillChange(toSnapshot(item))
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('builder.skillPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {/* The empty state is a row, not the absence of one. */}
                <SelectItem value={NO_SKILL}>{t('builder.skillNone')}</SelectItem>
                {(attachable ?? []).map((item) => (
                  <SelectItem key={item.name} value={item.name}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <FieldDescription>
            {skill !== null ? skill.description : t('builder.skillNoneHint')}
          </FieldDescription>
          {attachable !== null && attachable.length === 0 && !skillsError && (
            <FieldDescription>{t('builder.skillsEmpty')}</FieldDescription>
          )}
        </Field>

        {detached && (
          <p
            role="status"
            className="animate-in fade-in-0 text-foreground text-xs font-medium duration-base ease-out motion-reduce:animate-none"
          >
            {t('builder.skillDetached', {
              name: detached.name,
              output: outputLabel(detached.output),
            })}
          </p>
        )}

        <div>
          {/* The knowledge layer is server-guaranteed on every run, so it is a
              pinned row and never a checkbox — an unchecked box you cannot
              uncheck is a lie about who is in control. */}
          <div className="border-border bg-muted flex items-start gap-2.5 rounded-lg border px-2.5 py-2">
            <Lock className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="text-foreground text-sm">{t('builder.knowledgeAlways')}</span>
          </div>

          <Field className="mt-3">
            <FieldLabel>{t('builder.additionalSourcesLabel')}</FieldLabel>
            <FieldDescription>{t('builder.sourcesHint')}</FieldDescription>
          </Field>

          {sources === null && !sourcesError && (
            <p className="text-muted-foreground flex min-h-9 items-center text-sm">
              {t('builder.sourcesLoading')}
            </p>
          )}
          {sourcesError && (
            <p className="text-muted-foreground flex min-h-9 items-center text-sm">
              {t('builder.sourcesError')}
            </p>
          )}
          {sources !== null && sources.length > 0 && (
            <div className="mt-2 space-y-2">
              {sources.map((source) => (
                <Field
                  key={source.id}
                  orientation="horizontal"
                  className="hover:border-border justify-start rounded-lg border border-transparent px-1 py-1.5 transition-colors duration-snap ease-out"
                >
                  <Checkbox
                    id={`schedule-source-${source.id}`}
                    checked={selectedSources.has(source.id)}
                    onCheckedChange={(value) => onToggleSource(source.id, value === true)}
                    className="mt-0.5"
                  />
                  <div className="flex flex-col gap-0.5">
                    <FieldLabel htmlFor={`schedule-source-${source.id}`} className="font-medium">
                      {source.name}
                    </FieldLabel>
                    {source.description && (
                      <FieldDescription>{source.description}</FieldDescription>
                    )}
                  </div>
                </Field>
              ))}
              {selectedSources.size === 0 && (
                <FieldDescription>{t('builder.sourcesAll')}</FieldDescription>
              )}
            </div>
          )}
        </div>
      </Advanced>
    </section>
  )
}

/**
 * Step 3 — when. Four cadences, a time, and the next three real fire times.
 *
 * The preview underneath is the reason this step is worth a page of its own. A
 * schedule is the one thing in the section a person cannot check by looking at
 * it: „Monatlich am 1. um 06:00" is true until the month it is not, and
 * `0 6 1 * *` is true to nobody. Three dates, from the library the scheduler
 * itself advances rows with, turn the setting into something a reader can
 * confirm before they commit to it.
 */
function ScheduleStep({
  scheduleEnabled,
  onScheduleEnabledChange,
  customCron,
  onCustomCronChange,
  parts,
  onPartsChange,
  cron,
  onCronChange,
  timezone,
  onTimezoneChange,
  effectiveCron,
  error,
  locale,
}: {
  scheduleEnabled: boolean
  onScheduleEnabledChange: (next: boolean) => void
  customCron: boolean
  onCustomCronChange: (next: boolean) => void
  parts: CronParts
  onPartsChange: (next: CronParts) => void
  cron: string
  onCronChange: (next: string) => void
  timezone: string
  onTimezoneChange: (next: string) => void
  effectiveCron: string | null
  error: string | null
  locale: string
}): JSX.Element {
  const t = useTranslations('jobs')
  const timezones = useMemo(() => supportedTimezones(), [])

  return (
    <section data-testid="wizard-step-schedule">
      <StepHeading title={t('builder.steps.scheduleTitle')} hint={t('builder.steps.scheduleHint')} />

      <Field orientation="horizontal" className="border-border rounded-lg border px-3 py-2.5">
        <div className="flex flex-col gap-0.5">
          <FieldLabel htmlFor="schedule-on">{t('builder.enableScheduleLabel')}</FieldLabel>
          <FieldDescription>{t('builder.enableScheduleHint')}</FieldDescription>
        </div>
        <Switch
          id="schedule-on"
          checked={scheduleEnabled}
          onCheckedChange={onScheduleEnabledChange}
        />
      </Field>

      {scheduleEnabled && (
        <div className="animate-in fade-in-0 mt-5 space-y-5 duration-base ease-out motion-reduce:animate-none">
          {!customCron && (
            <>
              <Field>
                <FieldLabel id="schedule-frequency-label">{t('builder.presetLabel')}</FieldLabel>
                {/* Chips, not a dropdown: four options that fit on one line are
                    faster to compare side by side than behind a click, and the
                    chosen one stays visible while the time below it is set. */}
                <div
                  role="radiogroup"
                  aria-labelledby="schedule-frequency-label"
                  className="flex flex-wrap gap-2"
                >
                  {SCHEDULE_FREQUENCIES.map((frequency) => (
                    <Chip
                      key={frequency}
                      size="md"
                      interactive
                      asChild
                      variant={parts.frequency === frequency ? 'default' : 'outline'}
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-checked={parts.frequency === frequency}
                        onClick={() => onPartsChange({ ...parts, frequency })}
                        data-testid={`wizard-frequency-${frequency}`}
                      >
                        {t(`schedule.frequency.${frequency}`)}
                      </button>
                    </Chip>
                  ))}
                </div>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                {/* Hourly reads only the minute, so asking for a full time
                    would be asking for an answer that is then half-ignored. */}
                {parts.frequency !== 'hourly' && (
                  <Field>
                    <FieldLabel htmlFor="schedule-time">{t('builder.timeLabel')}</FieldLabel>
                    <Input
                      id="schedule-time"
                      type="time"
                      value={partsToTimeValue(parts)}
                      onChange={(event) => {
                        const next = timeValueToParts(event.target.value)
                        if (next) onPartsChange({ ...parts, ...next })
                      }}
                      className="tabular-nums"
                    />
                  </Field>
                )}
                {parts.frequency === 'hourly' && (
                  <Field>
                    <FieldLabel htmlFor="schedule-minute">{t('builder.minuteLabel')}</FieldLabel>
                    <Select
                      value={String(parts.minute)}
                      onValueChange={(value) => onPartsChange({ ...parts, minute: Number(value) })}
                    >
                      <SelectTrigger id="schedule-minute">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[0, 15, 30, 45].map((minute) => (
                          <SelectItem key={minute} value={String(minute)}>
                            {t('builder.minutePast', { minute: String(minute).padStart(2, '0') })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}

                {parts.frequency === 'monthly' && (
                  <Field>
                    <FieldLabel htmlFor="schedule-monthday">{t('builder.monthDayLabel')}</FieldLabel>
                    <Select
                      value={String(parts.monthDay)}
                      onValueChange={(value) => onPartsChange({ ...parts, monthDay: Number(value) })}
                    >
                      <SelectTrigger id="schedule-monthday">
                        <SelectValue />
                      </SelectTrigger>
                      {/* Capped at 28 so a monthly schedule never skips
                          February — a "31st" schedule fires seven times a year
                          and nobody means that. */}
                      <SelectContent className="max-h-72">
                        {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                          <SelectItem key={day} value={String(day)}>
                            {t('builder.monthDayValue', { day })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              </div>

              {/* Seven toggles, not a dropdown. "Montag, Mittwoch und Freitag"
                  and "werktags" are ordinary asks, and a single-day picker sent
                  both of them to the raw cron field — where nobody could check
                  what they had written. Monday first: this product's week
                  starts there. */}
              {parts.frequency === 'weekly' && (
                <Field>
                  <FieldLabel id="schedule-weekdays-label">{t('builder.weekdayLabel')}</FieldLabel>
                  <div
                    role="group"
                    aria-labelledby="schedule-weekdays-label"
                    className="flex flex-wrap gap-1.5"
                  >
                    {[1, 2, 3, 4, 5, 6, 0].map((weekday) => {
                      const on = parts.weekdays.includes(weekday)
                      return (
                        <Chip
                          key={weekday}
                          size="md"
                          interactive
                          asChild
                          variant={on ? 'default' : 'outline'}
                        >
                          <button
                            type="button"
                            aria-pressed={on}
                            aria-label={weekdayName(weekday, locale)}
                            data-testid={`wizard-weekday-${weekday}`}
                            onClick={() => onPartsChange({ ...parts, weekdays: toggleDay(parts.weekdays, weekday) })}
                          >
                            {weekdayName(weekday, locale, 'short')}
                          </button>
                        </Chip>
                      )
                    })}
                  </div>
                  <FieldDescription>{t('builder.weekdayHint')}</FieldDescription>
                </Field>
              )}
            </>
          )}

          {customCron && (
            <Field>
              <FieldLabel htmlFor="schedule-cron">{t('builder.cronLabel')}</FieldLabel>
              <Input
                id="schedule-cron"
                value={cron}
                placeholder={t('builder.cronPlaceholder')}
                spellCheck={false}
                autoComplete="off"
                className="font-mono"
                onChange={(event) => onCronChange(event.target.value)}
                aria-invalid={error ? true : undefined}
              />
              <FieldDescription>{t('builder.cronHint')}</FieldDescription>
            </Field>
          )}

          <UpcomingRuns cron={effectiveCron} timezone={timezone} locale={locale} />

          {error && <FieldError>{error}</FieldError>}

          <Advanced
            label={t('builder.advancedSchedule')}
            summary={customCron ? t('builder.cronLabel') : null}
          >
            <Field>
              <FieldLabel htmlFor="schedule-timezone">{t('builder.timezoneLabel')}</FieldLabel>
              <Select value={timezone} onValueChange={onTimezoneChange}>
                <SelectTrigger id="schedule-timezone">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {timezones.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{t('builder.timezoneHint')}</FieldDescription>
            </Field>

            <Field orientation="horizontal">
              <div className="flex flex-col gap-0.5">
                <FieldLabel htmlFor="schedule-custom-cron">{t('builder.customCronLabel')}</FieldLabel>
                <FieldDescription>{t('builder.customCronHint')}</FieldDescription>
              </div>
              <Switch
                id="schedule-custom-cron"
                checked={customCron}
                onCheckedChange={onCustomCronChange}
              />
            </Field>
          </Advanced>
        </div>
      )}
    </section>
  )
}

/**
 * A weekday added or removed, never emptied.
 *
 * Turning the last day off would leave an expression cron cannot write, and a
 * picker that can reach an invalid state is a picker that will. The last day on
 * simply stays on — the reader turns another one on first, which is what they
 * meant anyway.
 */
function toggleDay(weekdays: readonly number[], weekday: number): number[] {
  if (!weekdays.includes(weekday)) return [...weekdays, weekday].sort((a, b) => a - b)
  if (weekdays.length === 1) return [...weekdays]
  return weekdays.filter((day) => day !== weekday)
}

/**
 * The next few fire times of the expression as it currently stands.
 *
 * Debounced, because it recomputes on every keystroke in the cron field and a
 * list that flickers under a typing hand is noise rather than feedback.
 */
function UpcomingRuns({
  cron,
  timezone,
  locale,
}: {
  cron: string | null
  timezone: string
  locale: string
}): JSX.Element {
  const t = useTranslations('jobs')
  const [upcoming, setUpcoming] = useState<Date[] | null>(null)

  useEffect(() => {
    if (!cron) {
      setUpcoming([])
      return
    }
    let cancelled = false
    setUpcoming(null)
    const timer = setTimeout(() => {
      void nextOccurrences(cron, timezone, PREVIEW_COUNT).then((dates) => {
        if (!cancelled) setUpcoming(dates)
      })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [cron, timezone])

  return (
    <div className="bg-muted rounded-lg p-3" data-testid="wizard-upcoming">
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
        <CalendarClock className="size-3.5 shrink-0" aria-hidden />
        {t('builder.upcomingLabel')}
      </p>
      {upcoming === null ? (
        <p className="text-muted-foreground mt-1.5 flex h-16 items-center gap-2 text-sm">
          <Spinner size="sm" aria-hidden />
        </p>
      ) : upcoming.length === 0 ? (
        <p className="text-muted-foreground mt-1.5 flex h-16 items-center text-sm">
          {t('builder.upcomingNone')}
        </p>
      ) : (
        <ul className="mt-1.5 flex h-16 flex-col justify-center gap-0.5">
          {upcoming.map((at) => (
            <li key={at.toISOString()} className="text-foreground text-sm tabular-nums">
              {formatAbsoluteTime(at.toISOString(), locale)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Step 4 — what will happen, in one sentence, before anything is saved.
 *
 * Not a form. The peak-end rule says the last thing a person does colours their
 * memory of the whole flow, and the last thing this flow does should be
 * confidence: they read a plain sentence describing what they just built, see
 * that it is right, and press one button. The compiled fire prompt is still
 * here — it is the WYSIWYG contract the builder has always carried — but folded,
 * because "what the agent literally receives" is a thing you check when you
 * doubt something, not a thing you read every time.
 */
function ReviewStep({
  values,
  output,
  skill,
  sourceCount,
  effectiveCron,
  timezone,
  enabled,
  onEnabledChange,
  locale,
}: {
  values: WizardValues
  output: JobOutput
  skill: SkillSnapshot | null
  sourceCount: number
  effectiveCron: string | null
  timezone: string
  enabled: boolean
  onEnabledChange: (next: boolean) => void
  locale: string
}): JSX.Element {
  const t = useTranslations('jobs')
  const [promptOpen, setPromptOpen] = useState(false)
  const compiled = buildFirePromptPreview({ prompt: values.prompt, skill })

  const cadence = scheduleSummary(t, effectiveCron, timezone, locale, { withTimezone: false })
  const summary = effectiveCron
    ? t('builder.reviewSentence', {
        cadence: cadence.toLocaleLowerCase(locale),
        output: t(`builder.output.${output === 'chat' ? 'chatNoun' : 'deepResearchNoun'}`),
      })
    : t('builder.reviewSentenceManual', {
        output: t(`builder.output.${output === 'chat' ? 'chatNoun' : 'deepResearchNoun'}`),
      })

  return (
    <section data-testid="wizard-step-review">
      <StepHeading title={t('builder.steps.reviewTitle')} hint={t('builder.steps.reviewHint')} />

      <p className="text-foreground text-base leading-relaxed" data-testid="wizard-review-sentence">
        {summary}
      </p>

      <dl className="border-border mt-4 divide-y rounded-lg border">
        <ReviewRow label={t('builder.nameLabel')} value={values.name.trim()} />
        <ReviewRow
          label={t('builder.scheduleSection')}
          value={effectiveCron ? `${cadence} · ${timezone}` : t('list.manualOnly')}
        />
        <ReviewRow label={t('builder.outputSection')} value={t(`list.output.${output}`)} />
        <ReviewRow
          label={t('builder.skillSection')}
          value={skill ? skill.name : t('builder.skillNone')}
        />
        <ReviewRow
          label={t('builder.sourcesSection')}
          value={
            sourceCount > 0
              ? t('builder.sourcesSummary', { count: sourceCount })
              : t('builder.sourcesAll')
          }
        />
      </dl>

      <Collapsible open={promptOpen} onOpenChange={setPromptOpen} className="mt-4">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 flex w-full items-center gap-2 rounded-md text-sm focus-visible:outline-none focus-visible:ring-2"
          >
            <ChevronDown
              className={cn(
                'size-4 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none',
                promptOpen && 'rotate-180',
              )}
              aria-hidden
            />
            <FileText className="size-4 shrink-0" aria-hidden />
            {t('builder.preview.title')}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="duration-base ease-out motion-reduce:animate-none">
          <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
            {t('builder.preview.subtitle')}
          </p>
          <pre
            data-testid="job-prompt-preview"
            className="bg-muted text-foreground mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg p-4 font-mono text-xs leading-relaxed"
          >
            {compiled}
          </pre>
        </CollapsibleContent>
      </Collapsible>

      {/* The last switch, and the only one on this step: a schedule can be
          saved switched OFF, which is how somebody sets one up before the site
          work starts. Default on — the reader came here to make it happen. */}
      <Field orientation="horizontal" className="border-border mt-5 rounded-lg border px-3 py-2.5">
        <div className="flex flex-col gap-0.5">
          <FieldLabel htmlFor="schedule-enabled">{t('builder.enabledLabel')}</FieldLabel>
          <FieldDescription>{t('builder.enabledHint')}</FieldDescription>
        </div>
        <Switch id="schedule-enabled" checked={enabled} onCheckedChange={onEnabledChange} />
      </Field>
    </section>
  )
}

function ReviewRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 px-3 py-2.5">
      <dt className="text-muted-foreground shrink-0 text-xs">{label}</dt>
      <dd className="text-foreground min-w-0 truncate text-sm font-medium">{value}</dd>
    </div>
  )
}
