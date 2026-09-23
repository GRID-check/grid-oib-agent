'use client'

/**
 * The schedule wizard — three steps, one decision each.
 *
 * What this replaced was one page holding six stacked cards: name, prompt,
 * output, data sources, cron, timezone, two switches, and a live preview
 * pane beside them. Every field was justified on its own and the page was still
 * wrong, because the cost of a form is not the number of fields — it is the
 * number a person has to hold in mind AT ONCE. Sixteen controls with no stated
 * order is a page you read three times before touching anything, and the first
 * thing most people did with it was leave.
 *
 * The rules this is built to, in the order they mattered:
 *
 *   1. **One required decision per step.** Step 1 asks what Piloti should do.
 *      Step 2 asks when. Step 3 asks nothing and shows what will happen.
 *      Nothing else is required anywhere.
 *   2. **Everything optional is folded away.** The data sources, the
 *      timezone and the raw cron field live behind one "Erweitert" disclosure
 *      per step, shut by default. They are not hidden because they do not
 *      matter; they are hidden because the dictionary's own copy says most
 *      schedules need none of them, and an option nobody needs still costs
 *      every reader the moment it takes to rule it out.
 *   3. **The form arrives half-answered.** The name proposes itself from the
 *      first line of the prompt, the timezone is the browser's, the schedule
 *      starts at weekly-Monday-06:00. Endowed progress: a
 *      form that starts empty is a form you start; one that starts answered is
 *      one you finish.
 *   4. **The claim is made checkable.** Step 2 shows the next three real fire
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
 * pieces — the data-source checkboxes, the schedule composer
 * — are local state merged on submit, as before.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  ChevronDown,
  FileText,
  Lock,
  Play,
} from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'

import { FieldShell, useAppForm } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ChoiceCard, ChoiceCards } from '@/components/ui/choice-card'
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
import { Advanced, StepHeading } from '@/components/ui/step-form'
import { Switch } from '@/components/ui/switch'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { createDataSourcesClient, type DataSourceFromAPI } from '@/adapters/api/data-sources-client'
import {
  createJob,
  runJob,
  updateJob,
  JobApiError,
  type CreateJobInput,
  type Job,
} from '@/adapters/api/jobs-client'
import { SkillPromptField } from '@/features/skills/components/SkillPromptField'
import { capturePosthog } from '@/lib/analytics/posthog'
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
  CADENCES,
  type Cadence,
  cadenceOf,
  toDateTimeLocal,
  defaultDueAt,
} from '../lib/schedule'
import type { ScheduleDraft } from '../lib/schedule-draft'

/**
 * The sources every run gets: a pinned row, never checkboxes.
 *
 * Mirrors `ALWAYS_ON_SOURCE_IDS` on the server, which is what actually enforces
 * it — this list only decides which rows the wizard withholds, so a checkbox is
 * never offered for something the submit will turn on regardless. An unchecked
 * box you cannot uncheck is a lie about who is in control.
 */
const ALWAYS_ON_IDS: readonly string[] = ['knowledge_layer', 'ris']

/**
 * Three questions, not four.
 *
 * „Was soll dabei herauskommen? Chat oder Bericht?" used to be step 2. Since
 * ADR-0062 both land in a thread, so the only difference the choice still
 * carried was whether anything was FILED — and a standing task whose result is
 * not a deliverable is a standing task nobody reads. It is always a research
 * run that files a report; the data sources it used to hide moved up to the
 * step that states the work.
 */
const STEP_KEYS = ['task', 'schedule', 'review'] as const
type StepKey = (typeof STEP_KEYS)[number]

/**
 * Where a schedule error is shown, derived rather than counted.
 *
 * It was the literal `2`, which was the schedule step while there were four of
 * them. Dropping the output step moved the schedule to 1 and left `2` pointing
 * at the review — so an invalid cron, or the server refusing the interval, sent
 * the reader to a step that does not render `scheduleError` and said nothing at
 * all. An error a reader cannot see is an error they cannot fix, which is the
 * thing the code around it claims to prevent.
 */
const SCHEDULE_STEP = STEP_KEYS.indexOf('schedule')

/** How many upcoming fire times step 2 proves the schedule with. */
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
  // --- Sources --------------------------------------------------------------
  const [sources, setSources] = useState<DataSourceFromAPI[] | null>(null)
  const [sourcesError, setSourcesError] = useState(false)
  const [selectedSources, setSelectedSources] = useState<Set<string>>(
    new Set(job?.dataSources ?? []),
  )

  // --- When -----------------------------------------------------------------
  const [enabled, setEnabled] = useState<boolean>(job?.enabled ?? true)
  /**
   * Which of the three shapes this task has. One question with three answers,
   * not two switches: "run on a schedule" on/off could not express "once, on
   * Friday" at all, and a second boolean for it would have made four states of
   * which one is nonsense. See `cadenceOf`.
   */
  const [cadence, setCadence] = useState<Cadence>(() =>
    job ? cadenceOf(job) : 'recurring',
  )
  /**
   * A one-shot's due date, held as the `datetime-local` string the input reads
   * and writes — i.e. in the VIEWER's timezone. It becomes an instant once, at
   * submit, so no intermediate keystroke has to be a valid date.
   */
  const [dueAtLocal, setDueAtLocal] = useState<string>(() =>
    toDateTimeLocal(job?.dueAt ? new Date(job.dueAt) : defaultDueAt()),
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
  const effectiveCron =
    cadence === 'recurring' ? (customCron ? cron.trim() : buildCron(parts)) : null
  /**
   * The instant a one-shot will be saved with, or null.
   *
   * `datetime-local` gives no timezone, so `new Date(value)` reads it in the
   * viewer's — which is exactly right: the reader picked a wall-clock time
   * where they are sitting. An unparseable half-typed value is null, and the
   * WHEN step refuses to leave rather than posting it.
   */
  /**
   * The earliest the date picker offers, computed ONCE per mount rather than
   * per render: a `min` that tracks the clock would re-render the input every
   * time anything else in the wizard changed, and a reader mid-keystroke would
   * see the calendar's floor move under them.
   */
  const minDueAtLocal = useMemo(() => toDateTimeLocal(new Date()), [])

  /**
   * Whether this submit should also fire the task once, immediately.
   *
   * A ref and not state: it is read inside `onSubmit` and setting state would
   * re-render the form between the click and the submit, which TanStack Form
   * treats as a change mid-flight. Reset in `finally` so a failed save does not
   * leave the next attempt silently armed to run.
   */
  const runAfterSaveRef = useRef(false)

  /**
   * Fire the task once, right after it was saved.
   *
   * Deliberately swallows its own failure. The save already SUCCEEDED by the
   * time this runs, so letting the run's error reach the form's catch would
   * show "could not be saved" over a task that is sitting in the list — the
   * single most confusing thing this flow could tell somebody. A warning toast
   * says what actually happened, and the task's own run list is where the
   * outcome belongs anyway.
   */
  const runOnce = useCallback(
    async (jobId: string): Promise<void> => {
      try {
        await runJob(projectId, jobId)
      } catch {
        toast.warning(t('builder.runNowFailed'))
      }
    },
    [projectId, t],
  )

  const effectiveDueAt = useMemo(() => {
    if (cadence !== 'once' || !dueAtLocal) return null
    const parsed = new Date(dueAtLocal)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }, [cadence, dueAtLocal])

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

  const additionalSources = useMemo(
    () => sources?.filter((source) => !ALWAYS_ON_IDS.includes(source.id)) ?? null,
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
        setStepIndex(SCHEDULE_STEP)
        return
      }

      const payload: CreateJobInput = {
        name: value.name.trim(),
        prompt: value.prompt.trim(),
        // Always null. A task names a skill IN ITS PROMPT (`/name`, the chat
        // gesture), which the model reads and decides on. Explicit rather than
        // omitted because on PATCH that is what DETACHES a skill a previous
        // build attached — a job edited here stops carrying one.
        skillName: null,
        dataSources: selectedSources.size > 0 ? Array.from(selectedSources) : null,
        enabled,
        scheduleCron: effectiveCron,
        scheduleTimezone: timezone,
        // Explicit null, not omitted, for the same reason `skillName` is: on
        // PATCH that is what CLEARS a due date, and omitting it would leave a
        // one-shot's date in place after somebody moved it to a cron.
        dueAt: effectiveDueAt ? effectiveDueAt.toISOString() : null,
      }

      try {
        // The product events the retired builder emitted, carried over
        // unchanged — same names, same properties. A surface that replaces
        // another inherits its measurements, or the series breaks at the
        // rewrite and nobody can tell whether the new flow does better.
        const analytics = {
          additional_source_count: selectedSources.size,
          // Kept as it was named when the step was a switch, so the series
          // does not break at the rewrite: "is this task on a timer at all".
          schedule_enabled: cadence !== 'manual',
          cadence,
          enabled,
        }
        const runNow = runAfterSaveRef.current
        if (job) {
          await updateJob(projectId, job.id, payload)
          capturePosthog('job_updated', analytics)
          if (runNow) await runOnce(job.id)
          toast.success(t('builder.updateSuccess'))
        } else {
          const created = await createJob(projectId, payload)
          if (runNow) await runOnce(created.id)
          capturePosthog('job_created', analytics)
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
          if (cadence !== 'manual') {
            setScheduleError(message)
            setStepIndex(SCHEDULE_STEP)
          } else {
            setFormError(message)
          }
        } else {
          setFormError(t('builder.saveError'))
        }
        toast.error(t('builder.saveError'))
      } finally {
        // Always, so a failed save cannot leave the next attempt armed to fire
        // a run the reader did not ask for a second time.
        runAfterSaveRef.current = false
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
                read past.

                And it is the CHAT INPUT, `/` and all. A task that should run a
                playbook names it here the way a person would name it in a
                message — the model reads the name and decides. The advanced
                section used to hold a one-or-none `<Select>` instead, whose
                body the fire prompt then pasted in front of the model: the
                last mechanism in the product that could impose a skill on a
                turn, which ADR-0060 says nothing may do, "not the request, not
                the deployment, not a job". */}
            <form.AppField name="prompt">
              {(field) => (
                <FieldShell
                  label={t('builder.promptLabel')}
                  description={t('builder.promptHint')}
                  required
                  htmlFor="wizard-prompt"
                  errors={field.state.meta.isTouched ? field.state.meta.errors : []}
                >
                  <SkillPromptField
                    id="wizard-prompt"
                    value={field.state.value}
                    onChange={(next) => field.handleChange(next)}
                    onBlur={field.handleBlur}
                    placeholder={t('builder.promptPlaceholder')}
                    rows={8}
                    data-testid="wizard-prompt"
                  />
                </FieldShell>
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

            <Advanced
              label={t('builder.advancedSources')}
              summary={
                selectedSources.size > 0
                  ? t('builder.sourcesSummary', { count: selectedSources.size })
                  : null
              }
            >
              {/* No skill picker: a task that should run a playbook NAMES it in
            the prompt above, with the same `/` a chat message uses. */}
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

          {additionalSources === null && !sourcesError && (
            <p className="text-muted-foreground flex min-h-9 items-center text-sm">
              {t('builder.sourcesLoading')}
            </p>
          )}
          {sourcesError && (
            <p className="text-muted-foreground flex min-h-9 items-center text-sm">
              {t('builder.sourcesError')}
            </p>
          )}
          {additionalSources !== null && additionalSources.length > 0 && (
            <div className="mt-2 space-y-2">
              {additionalSources.map((source) => (
                <Field
                  key={source.id}
                  orientation="horizontal"
                  className="hover:border-border justify-start rounded-lg border border-transparent px-1 py-1.5 transition-colors duration-snap ease-out"
                >
                  <Checkbox
                    id={`schedule-source-${source.id}`}
                    checked={selectedSources.has(source.id)}
                    onCheckedChange={(value) => toggleSource(source.id, value === true)}
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
        )}

        {step === 'schedule' && (
          <ScheduleStep
            cadence={cadence}
            onCadenceChange={(next) => {
              setCadence(next)
              setScheduleError(null)
            }}
            dueAtLocal={dueAtLocal}
            onDueAtLocalChange={(next) => {
              setDueAtLocal(next)
              setScheduleError(null)
            }}
            minDueAtLocal={minDueAtLocal}
            dueAt={effectiveDueAt}
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
                sourceCount={selectedSources.size}
                cadence={cadence}
                effectiveCron={effectiveCron}
                effectiveDueAt={effectiveDueAt}
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
            onRunAfterSave={() => {
              runAfterSaveRef.current = true
            }}
          />
        )}
      </form.Subscribe>
    </form>
  )
}


/**
 * The footer. Back is always available and never destructive — on the first
 * step it is Cancel, which is the only place leaving loses anything.
 *
 * The last step offers TWO ways to finish, and the extra one is the point: a
 * task saved against a weekly cron gives its author no evidence it works until
 * the following Monday, which is the worst possible feedback loop for a prompt
 * written once, in a box, with no conversation to correct it. "Save and run
 * now" makes the first run the proof — and it is where somebody finds out the
 * prompt says the wrong thing while they still remember what they meant.
 *
 * It leads on CREATE and is secondary when editing: a new task has nothing to
 * show yet, an edited one already has a run history.
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
  onRunAfterSave,
}: {
  step: StepKey
  stepIndex: number
  blocked: boolean
  isSubmitting: boolean
  canSubmit: boolean
  onBack: () => void
  onNext: () => void
  editing: boolean
  onRunAfterSave: () => void
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
        <div className="flex items-center gap-2">
          {/* Secondary, and never the busy one: exactly one control shows the
              spinner so a reader is never asked which of two buttons is the
              one that is working. Both are disabled while it saves. */}
          <Button
            type="submit"
            variant="outline"
            disabled={!canSubmit || isSubmitting}
            onClick={onRunAfterSave}
            data-testid="wizard-save-and-run"
          >
            <Play className="size-4" aria-hidden />
            {editing ? t('builder.saveAndRun') : t('builder.createAndRun')}
          </Button>
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
        </div>
      ) : (
        <Button type="button" onClick={onNext} disabled={blocked} data-testid="wizard-next">
          {t('builder.next')}
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      )}
    </div>
  )
}

function ScheduleStep({
  cadence,
  onCadenceChange,
  dueAtLocal,
  onDueAtLocalChange,
  minDueAtLocal,
  dueAt,
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
  cadence: Cadence
  onCadenceChange: (next: Cadence) => void
  dueAtLocal: string
  onDueAtLocalChange: (next: string) => void
  minDueAtLocal: string
  /** The parsed instant, or null while the field is half-typed. */
  dueAt: Date | null
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

      {/* Cards, not chips, because each answer needs a sentence: "once" and
          "recurring" are indistinguishable from their one-word labels alone,
          and a reader choosing between them is choosing between behaviours. */}
      <ChoiceCards
        value={cadence}
        onValueChange={(next) => onCadenceChange(next as typeof cadence)}
        aria-label={t('builder.cadence.label')}
        className="sm:grid-cols-3 lg:grid-cols-3"
        data-testid="cadence-choice"
      >
        {CADENCES.map((option) => (
          <ChoiceCard
            key={option}
            value={option}
            label={t(`builder.cadence.${option}`)}
            hint={t(`builder.cadence.${option}Hint`)}
            data-testid={`cadence-${option}`}
          />
        ))}
      </ChoiceCards>

      {cadence === 'once' && (
        <div className="animate-in fade-in-0 mt-5 space-y-5 duration-base ease-out motion-reduce:animate-none">
          <Field>
            <FieldLabel htmlFor="due-at">{t('builder.dueAtLabel')}</FieldLabel>
            <FieldDescription>{t('builder.dueAtHint')}</FieldDescription>
            {/* `min` is advisory — the browser will not stop a typed past date
                and the server is the real check — but it makes the calendar
                open on the right side of today. */}
            <Input
              id="due-at"
              type="datetime-local"
              value={dueAtLocal}
              min={minDueAtLocal}
              onChange={(event) => onDueAtLocalChange(event.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </Field>

          <UpcomingRuns cron={null} dueAt={dueAt} timezone={timezone} locale={locale} />

          {error && <FieldError>{error}</FieldError>}
        </div>
      )}

      {cadence === 'recurring' && (
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
 * When this task will actually run, as dates rather than as a setting.
 *
 * Both cadences that fire on their own share this box, because both need the
 * same reassurance and a one-shot needs it MORE: a cron at least repeats, so a
 * wrong one is visibly wrong next week, while a date typed into a
 * `datetime-local` is read back exactly once and by then it has happened.
 * Showing the chosen instant in the same words as a schedule's occurrences is
 * what makes "Freitag, 2. Oktober 2026, 07:00" checkable at all.
 *
 * The cron path is debounced, because it recomputes on every keystroke in the
 * cron field and a list that flickers under a typing hand is noise rather than
 * feedback. A due date needs no library and no wait — it IS the answer.
 */
function UpcomingRuns({
  cron,
  dueAt = null,
  timezone,
  locale,
}: {
  cron: string | null
  dueAt?: Date | null
  timezone: string
  locale: string
}): JSX.Element {
  const t = useTranslations('jobs')
  const [upcoming, setUpcoming] = useState<Date[] | null>(null)

  useEffect(() => {
    if (dueAt) {
      setUpcoming([dueAt])
      return
    }
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
  }, [cron, dueAt, timezone])

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
  sourceCount,
  cadence,
  effectiveCron,
  effectiveDueAt,
  timezone,
  enabled,
  onEnabledChange,
  locale,
}: {
  values: WizardValues
  sourceCount: number
  cadence: Cadence
  effectiveCron: string | null
  effectiveDueAt: Date | null
  timezone: string
  enabled: boolean
  onEnabledChange: (next: boolean) => void
  locale: string
}): JSX.Element {
  const t = useTranslations('jobs')
  const [promptOpen, setPromptOpen] = useState(false)
  // The prompt IS what the agent receives, verbatim. It used to be the prompt
  // plus the attached skill's whole body, which is why this pane existed: what
  // was submitted differed from what was typed. Nothing is appended any more —
  // a `/name` in the text is part of the text — so the pane shows the trimmed
  // prompt, and that is now the honest answer rather than a stale one.
  const compiled = values.prompt.trim()

  const rhythm = scheduleSummary(t, effectiveCron, timezone, locale, { withTimezone: false })
  const dueAtText = effectiveDueAt ? formatAbsoluteTime(effectiveDueAt.toISOString(), locale) : ''

  // One sentence per cadence rather than one with a hole in it: "läuft einmal
  // am …" and "läuft jeden Montag …" are different sentences in German, and
  // interpolating a cadence into a single frame produces neither.
  const summary =
    cadence === 'recurring'
      ? t('builder.reviewSentence', { cadence: rhythm.toLocaleLowerCase(locale) })
      : cadence === 'once'
        ? t('builder.reviewSentenceOnce', { dueAt: dueAtText })
        : t('builder.reviewSentenceManual')

  const whenValue =
    cadence === 'recurring'
      ? `${rhythm} · ${timezone}`
      : cadence === 'once'
        ? `${dueAtText} · ${timezone}`
        : t('list.manualOnly')

  return (
    <section data-testid="wizard-step-review">
      <StepHeading title={t('builder.steps.reviewTitle')} hint={t('builder.steps.reviewHint')} />

      <p className="text-foreground text-base leading-relaxed" data-testid="wizard-review-sentence">
        {summary}
      </p>

      <dl className="border-border mt-4 divide-y rounded-lg border">
        <ReviewRow label={t('builder.nameLabel')} value={values.name.trim()} />
        <ReviewRow label={t('builder.scheduleSection')} value={whenValue} />
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

      {/* The only switch left in the wizard, and only where "paused" says
          something: a task that fires on its own can be saved switched OFF,
          which is how somebody sets one up before the site work starts.
          A manual task has nothing to pause — it runs when a person presses
          the button — so offering it there produced a task that could not run
          at all and did not say why. It still appears on a manual task that is
          ALREADY paused, or there would be no way back. */}
      {(cadence !== 'manual' || !enabled) && (
        <Field
          orientation="horizontal"
          className="border-border mt-5 rounded-lg border px-3 py-2.5"
        >
          <div className="flex flex-col gap-0.5">
            <FieldLabel htmlFor="schedule-enabled">{t('builder.enabledLabel')}</FieldLabel>
            <FieldDescription>{t('builder.enabledHint')}</FieldDescription>
          </div>
          <Switch id="schedule-enabled" checked={enabled} onCheckedChange={onEnabledChange} />
        </Field>
      )}
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
