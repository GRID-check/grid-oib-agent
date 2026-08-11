'use client'

/**
 * Job builder — create/edit a job: a PROMPT on a timer, which MAY have a skill
 * attached and which chooses what a run produces. Two columns: the form on the
 * left, a live "What the agent receives" preview on the right (the preview
 * mirrors the server's fire prompt; see lib/fire-prompt-preview.ts). On narrow
 * viewports the columns stack.
 *
 * Field order is the order the decisions actually happen in: name → prompt →
 * output → skill → sources → schedule. The prompt is the primary field because
 * it is what the job IS; the skill is the optional extra typed as `/name` would
 * be, and its empty state is the common case.
 *
 * The output kind is not cosmetic: it decides which agent runs the job, and
 * therefore which skills can be attached at all (`grid-agents`, resolved
 * server-side). Changing it re-fetches the picker, and a skill the new output
 * cannot run is detached with an inline sentence rather than silently kept and
 * rejected at fire time.
 *
 * Scalar text fields use TanStack Form + Zod (src/components/form); the dynamic
 * pieces — the skill picker, the data-source checkboxes and the schedule editor
 * — are local state merged on submit. The server owns validation (cron
 * parseability/min-interval, prompt length, name rules) and snapshot semantics;
 * this builder only mirrors the client-knowable rules for instant feedback.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, FileText, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { useAppForm } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useTranslations } from '@/i18n'
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
import {
  browserTimezone,
  isPlausibleCron,
  PRESET_CRON,
  presetForCron,
  SCHEDULE_PRESETS,
  supportedTimezones,
  type SchedulePreset,
} from '../lib/schedule'
import { buildFirePromptPreview } from '../lib/fire-prompt-preview'

// The always-included knowledge source is rendered as a pinned, non-interactive
// row (never a checkbox); it is server-guaranteed on every run.
const KNOWLEDGE_LAYER_ID = 'knowledge_layer'

/**
 * The picker's "no skill" value.
 *
 * A sentinel rather than the empty string: Radix reserves `''` for "nothing
 * selected", and "no skill" here is a CHOICE the user can make explicitly — it
 * has to be a selectable row, not the absence of one.
 */
const NO_SKILL = '__none__'

/** The two output kinds, in the order they are offered. */
const JOB_OUTPUTS: readonly JobOutput[] = ['chat', 'deep-research']

interface JobBuilderProps {
  projectId: string
  /** The job being edited, or null when creating. */
  job: Job | null
  onSaved: () => void
  onCancel: () => void
}

interface BuilderValues {
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

export function JobBuilder({ projectId, job, onSaved, onCancel }: JobBuilderProps): JSX.Element {
  const t = useTranslations('jobs')
  const isEdit = job !== null

  // --- The output kind, and everything that follows from it ---------------
  const [output, setOutput] = useState<JobOutput>(job?.output ?? 'chat')
  const [attachable, setAttachable] = useState<AttachableSkill[] | null>(null)
  const [skillsError, setSkillsError] = useState(false)
  /** The attached skill, as the snapshot the preview and the payload need. */
  const [skill, setSkill] = useState<SkillSnapshot | null>(job?.skillSnapshot ?? null)
  /** Set when switching output dropped the attachment — shown, never silent. */
  const [detached, setDetached] = useState<{ name: string; output: JobOutput } | null>(null)
  /**
   * The attachment as the picker effect sees it.
   *
   * A ref, not a dependency: the effect re-fetches on OUTPUT change, and
   * listing `skill` would make every pick of a skill re-request the list it
   * was picked from.
   */
  const skillRef = useRef<SkillSnapshot | null>(skill)
  skillRef.current = skill

  // --- The rest of the form ------------------------------------------------
  const [selectedSources, setSelectedSources] = useState<Set<string>>(
    new Set(job?.dataSources ?? []),
  )
  const [enabled, setEnabled] = useState<boolean>(job?.enabled ?? true)
  const [scheduleEnabled, setScheduleEnabled] = useState<boolean>(Boolean(job?.scheduleCron))
  const [preset, setPreset] = useState<SchedulePreset>(presetForCron(job?.scheduleCron))
  const [cron, setCron] = useState<string>(job?.scheduleCron ?? PRESET_CRON.daily)
  const [timezone, setTimezone] = useState<string>(job?.scheduleTimezone ?? browserTimezone())
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  // --- Data sources -------------------------------------------------------
  const [sources, setSources] = useState<DataSourceFromAPI[] | null>(null)
  const [sourcesError, setSourcesError] = useState(false)

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

  // The knowledge layer is rendered as the pinned always-included row, so it
  // is never offered as a checkbox even if the API includes it in the list.
  const additionalSources = useMemo(
    () => sources?.filter((source) => source.id !== KNOWLEDGE_LAYER_ID) ?? null,
    [sources],
  )

  const timezones = useMemo(() => supportedTimezones(), [])

  const outputLabel = useCallback(
    (kind: JobOutput) =>
      kind === 'chat' ? t('builder.output.chatLabel') : t('builder.output.deepResearchLabel'),
    [t],
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
      name: job?.name ?? '',
      prompt: job?.prompt ?? '',
    } satisfies BuilderValues,
    validators: { onChange: schema },
    onSubmit: async ({ value }) => {
      setFormError(null)
      setScheduleError(null)

      const effectiveCron = scheduleEnabled
        ? preset === 'custom'
          ? cron.trim()
          : PRESET_CRON[preset]
        : null

      // Client-side cron shape check for instant feedback; the server owns the
      // authoritative validation (parseability, min interval).
      if (effectiveCron && !isPlausibleCron(effectiveCron)) {
        setScheduleError(t('builder.cronInvalid'))
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
        // 400/422 are validation failures — most reach here via the schedule
        // (cron / min interval), so surface the server's message inline there.
        if (err instanceof JobApiError && (err.status === 400 || err.status === 422)) {
          const message = err.serverMessage ?? t('builder.saveError')
          if (scheduleEnabled) {
            setScheduleError(message)
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

  const toggleSource = (id: string, checked: boolean) => {
    setSelectedSources((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const changePreset = (next: SchedulePreset) => {
    setPreset(next)
    setScheduleError(null)
    if (next !== 'custom') setCron(PRESET_CRON[next])
  }

  const changeOutput = (next: JobOutput) => {
    if (next === output) return
    setDetached(null)
    setAttachable(null)
    setOutput(next)
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 md:px-8 md:py-8">
      <div className="space-y-1.5">
        <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onCancel}>
          <ArrowLeft className="size-4" aria-hidden />
          {t('backToList')}
        </Button>
        <h1 className="text-xl font-semibold text-foreground">
          {isEdit ? t('builder.editTitle') : t('builder.createTitle')}
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {isEdit ? t('builder.editSubtitle') : t('builder.createSubtitle')}
        </p>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void form.handleSubmit()
        }}
        className="space-y-6"
      >
        <div className="grid gap-6 lg:grid-cols-2">
          {/* ---- LEFT: form ---- */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('builder.detailsSection')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <form.AppField name="name">
                  {(field) => (
                    <field.TextField
                      label={t('builder.nameLabel')}
                      placeholder={t('builder.namePlaceholder')}
                      required
                    />
                  )}
                </form.AppField>
              </CardContent>
            </Card>

            {/* The prompt. First and biggest, because it is the job. */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('builder.promptSection')}</CardTitle>
              </CardHeader>
              <CardContent>
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
              </CardContent>
            </Card>

            {/* Output. Two choices, each with the sentence that says what you
                actually get — "chat" and "deep research" mean nothing on their
                own to somebody setting up their first job. */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('builder.outputSection')}</CardTitle>
                <CardDescription>{t('builder.outputHint')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div
                  role="radiogroup"
                  aria-label={t('builder.outputLabel')}
                  className="grid gap-2 sm:grid-cols-2"
                >
                  {JOB_OUTPUTS.map((kind) => {
                    const active = output === kind
                    return (
                      <button
                        key={kind}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => changeOutput(kind)}
                        className={cn(
                          'flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors',
                          'focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-2',
                          active
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:border-foreground/30',
                        )}
                      >
                        <span className="flex w-full items-center justify-between gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {outputLabel(kind)}
                          </span>
                          {active && <Check className="size-4 text-primary" aria-hidden />}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {kind === 'chat'
                            ? t('builder.output.chatHint')
                            : t('builder.output.deepResearchHint')}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </CardContent>
            </Card>

            {/* Skill — optional, and it says so in the heading rather than only
                in a hint nobody reads. */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  {t('builder.skillSection')}
                  <Badge variant="secondary" className="font-normal">
                    {t('builder.skillOptional')}
                  </Badge>
                </CardTitle>
                <CardDescription>{t('builder.skillHint')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-col gap-1.5">
                  <Label className="text-sm font-medium">{t('builder.skillLabel')}</Label>
                  {attachable === null && !skillsError ? (
                    <p className="text-sm text-muted-foreground">{t('builder.skillsLoading')}</p>
                  ) : skillsError ? (
                    <p className="text-sm text-muted-foreground">{t('builder.skillsError')}</p>
                  ) : (
                    <Select
                      value={skill?.name ?? NO_SKILL}
                      onValueChange={(name) => {
                        setDetached(null)
                        if (name === NO_SKILL) {
                          setSkill(null)
                          return
                        }
                        const item = attachable?.find((entry) => entry.name === name)
                        if (item) setSkill(toSnapshot(item))
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
                </div>
                {skill !== null ? (
                  <p className="text-xs text-muted-foreground">{skill.description}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('builder.skillNoneHint')}</p>
                )}
                {attachable !== null && attachable.length === 0 && !skillsError && (
                  <p className="text-xs text-muted-foreground">{t('builder.skillsEmpty')}</p>
                )}
                {detached && (
                  <p role="status" className="text-xs font-medium text-foreground">
                    {t('builder.skillDetached', {
                      name: detached.name,
                      output: outputLabel(detached.output),
                    })}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Data sources */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('builder.sourcesSection')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Always-included knowledge source: a pinned, non-interactive row
                    (never a checkbox). The knowledge layer is guaranteed on every
                    run server-side, so it is shown here regardless of the API list. */}
                <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 px-2.5 py-2">
                  <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="text-sm text-foreground">{t('builder.knowledgeAlways')}</span>
                </div>

                <div className="space-y-1 border-t border-border pt-3">
                  <p className="text-sm font-medium text-foreground">
                    {t('builder.additionalSourcesLabel')}
                  </p>
                  <p className="text-xs text-muted-foreground">{t('builder.sourcesHint')}</p>
                </div>
                {sources === null && !sourcesError && (
                  <p className="text-sm text-muted-foreground">{t('builder.sourcesLoading')}</p>
                )}
                {sourcesError && (
                  <p className="text-sm text-muted-foreground">{t('builder.sourcesError')}</p>
                )}
                {additionalSources !== null && additionalSources.length > 0 && (
                  <div className="space-y-2">
                    {additionalSources.map((source) => {
                      const checked = selectedSources.has(source.id)
                      return (
                        <label
                          key={source.id}
                          className="flex items-start gap-2.5 rounded-lg border border-transparent px-1 py-1.5 hover:border-border"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(value) => toggleSource(source.id, value === true)}
                            className="mt-0.5"
                          />
                          <span className="flex flex-col gap-0.5">
                            <span className="text-sm font-medium text-foreground">{source.name}</span>
                            {source.description && (
                              <span className="text-xs text-muted-foreground">
                                {source.description}
                              </span>
                            )}
                          </span>
                        </label>
                      )
                    })}
                    <p className="pt-1 text-xs text-muted-foreground">
                      {selectedSources.size === 0 && t('builder.sourcesAll')}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Schedule */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('builder.scheduleSection')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex flex-col gap-0.5">
                    <Label htmlFor="job-schedule-enabled" className="text-sm font-medium">
                      {t('builder.enableScheduleLabel')}
                    </Label>
                    <p className="text-xs text-muted-foreground">{t('builder.enableScheduleHint')}</p>
                  </div>
                  <Switch
                    id="job-schedule-enabled"
                    checked={scheduleEnabled}
                    onCheckedChange={(checked) => {
                      setScheduleEnabled(checked)
                      setScheduleError(null)
                    }}
                  />
                </div>

                {scheduleEnabled && (
                  <div className="space-y-4 border-t border-border pt-4">
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-sm font-medium">{t('builder.presetLabel')}</Label>
                      <Select
                        value={preset}
                        onValueChange={(value) => changePreset(value as SchedulePreset)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SCHEDULE_PRESETS.map((option) => (
                            <SelectItem key={option} value={option}>
                              {t(`schedule.presets.${option}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {preset === 'custom' && (
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="job-cron" className="text-sm font-medium">
                          {t('builder.cronLabel')}
                        </Label>
                        <Input
                          id="job-cron"
                          value={cron}
                          placeholder={t('builder.cronPlaceholder')}
                          spellCheck={false}
                          autoComplete="off"
                          className="font-mono"
                          onChange={(event) => {
                            setCron(event.target.value)
                            setScheduleError(null)
                          }}
                          aria-invalid={scheduleError ? true : undefined}
                        />
                        <p className="text-xs text-muted-foreground">{t('builder.cronHint')}</p>
                      </div>
                    )}

                    <div className="flex flex-col gap-1.5">
                      <Label className="text-sm font-medium">{t('builder.timezoneLabel')}</Label>
                      <Select value={timezone} onValueChange={setTimezone}>
                        <SelectTrigger>
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
                    </div>

                    {scheduleError && (
                      <p role="alert" className="text-xs font-medium text-destructive">
                        {scheduleError}
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Master enabled switch */}
            <Card>
              <CardContent className="flex items-center justify-between gap-4 p-4">
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor="job-enabled" className="text-sm font-medium">
                    {t('builder.enabledLabel')}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t('builder.enabledHint')}</p>
                </div>
                <Switch id="job-enabled" checked={enabled} onCheckedChange={setEnabled} />
              </CardContent>
            </Card>
          </div>

          {/* ---- RIGHT: live preview ---- */}
          <div>
            <form.Subscribe selector={(state) => (state.values as BuilderValues).prompt}>
              {(prompt) => <FirePromptPreview prompt={prompt} skill={skill} />}
            </form.Subscribe>
          </div>
        </div>

        {formError && (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('builder.cancel')}
          </Button>
          <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
            {([canSubmit, isSubmitting]) => (
              <Button type="submit" disabled={!canSubmit || isSubmitting}>
                {isSubmitting && <Spinner size="sm" />}
                {isSubmitting ? t('builder.saving') : t('builder.save')}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </form>
    </div>
  )
}

/**
 * Live "What the agent receives" pane. Renders the client-side
 * `buildFirePromptPreview` output verbatim — the WYSIWYG contract is that this
 * text equals the prompt submitted when the job fires (the server builds the
 * same prompt at fire time; the two sides are pinned by
 * fire-prompt-preview.spec.ts).
 */
function FirePromptPreview({
  prompt,
  skill,
}: {
  prompt: string
  skill: SkillSnapshot | null
}): JSX.Element {
  const t = useTranslations('jobs')
  const compiled = buildFirePromptPreview({ prompt, skill })
  return (
    <Card className="lg:sticky lg:top-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="size-4 text-muted-foreground" aria-hidden />
          {t('builder.preview.title')}
        </CardTitle>
        <CardDescription>{t('builder.preview.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        {compiled ? (
          <pre
            data-testid="job-prompt-preview"
            className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground"
          >
            {compiled}
          </pre>
        ) : (
          <p className="rounded-lg border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">
            {t('builder.preview.empty')}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
