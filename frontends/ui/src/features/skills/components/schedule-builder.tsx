'use client'

/**
 * Skill schedule builder — create/edit a schedule that pins ONE skill from
 * the merged toolbox (builtin platform skills + org rows) and fires it
 * manually or on a cron. Two columns: the form on the left, a live "What the
 * agent receives" preview on the right (the preview mirrors the server's fire
 * prompt; see fire-prompt-preview.ts). On narrow viewports the columns stack.
 *
 * Scalar text fields use TanStack Form + Zod (src/components/form); the
 * dynamic pieces — the skill picker, the data-source checkboxes and the
 * schedule editor — are managed as local state and merged on submit. The
 * server owns validation (cron parseability/min-interval, name rules,
 * grid-schedulable veto) and snapshot semantics; this builder only mirrors
 * the client-knowable rules for instant feedback.
 */

import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, FileText, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { useAppForm } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
import { createDataSourcesClient, type DataSourceFromAPI } from '@/adapters/api/data-sources-client'
import {
  createSkillSchedule,
  listSkills,
  SkillApiError,
  updateSkillSchedule,
  type CreateSkillScheduleInput,
  type SkillListItem,
  type SkillSchedule,
} from '@/adapters/api/skills-client'
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

/** Reserved metadata key that opts a skill out of cron scheduling. */
const METADATA_SCHEDULABLE = 'grid-schedulable'

interface ScheduleBuilderProps {
  projectId: string
  /** The schedule being edited, or null when creating. */
  schedule: SkillSchedule | null
  onSaved: () => void
  onCancel: () => void
}

interface BuilderValues {
  name: string
}

/** Client-side mirror of the server's schedulability rule. */
function isSchedulable(metadata: Record<string, string>): boolean {
  return metadata[METADATA_SCHEDULABLE] !== 'false'
}

/**
 * A debounced skill picker value is not needed — every toolbox row already
 * carries its full body (added at the BFF list so the preview needs no extra
 * fetch), so the preview is derived synchronously from the picker state.
 */
function toSnapshot(item: SkillListItem | null) {
  return item
    ? { name: item.name, description: item.description, body: item.body, metadata: item.metadata, origin: item.origin }
    : null
}

export function ScheduleBuilder({
  projectId,
  schedule,
  onSaved,
  onCancel,
}: ScheduleBuilderProps): JSX.Element {
  const t = useTranslations('skills')
  const isEdit = schedule !== null

  // --- Auxiliary (non-TanStack) state -------------------------------------
  const [skills, setSkills] = useState<SkillListItem[] | null>(null)
  const [skillsError, setSkillsError] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<SkillListItem | null>(null)
  // Wait for the toolbox list: the edited schedule's skill may have been
  // deleted since (then keep editing it anyway — its snapshot still fires).
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(
    schedule?.skillName ?? null,
  )
  const [selectedSources, setSelectedSources] = useState<Set<string>>(
    new Set(schedule?.dataSources ?? []),
  )
  const [enabled, setEnabled] = useState<boolean>(schedule?.enabled ?? true)
  const [scheduleEnabled, setScheduleEnabled] = useState<boolean>(Boolean(schedule?.scheduleCron))
  const [preset, setPreset] = useState<SchedulePreset>(presetForCron(schedule?.scheduleCron))
  const [cron, setCron] = useState<string>(schedule?.scheduleCron ?? PRESET_CRON.daily)
  const [timezone, setTimezone] = useState<string>(schedule?.scheduleTimezone ?? browserTimezone())
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

  useEffect(() => {
    const controller = new AbortController()
    listSkills()
      .then((items) => {
        if (controller.signal.aborted) return
        setSkills(items)
        setSkillsError(false)
        // An edited schedule's skill may no longer exist in the toolbox
        // (deleted org skill / renamed): fall back to its saved snapshot so
        // the schedule stays editable and visible.
        if (selectedSkillName) {
          const match = items.find((item) => item.name === selectedSkillName)
          if (match) setSelectedSkill(match)
          else {
            const snapshot = schedule?.skillSnapshot
            if (snapshot) {
              setSelectedSkill({
                id: null,
                name: snapshot.name,
                description: snapshot.description,
                body: snapshot.body,
                metadata: snapshot.metadata,
                origin: snapshot.origin,
                enabled: true,
                clonedFrom: null,
                createdAt: null,
                updatedAt: null,
              })
            }
          }
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setSkillsError(true)
      })
    return () => controller.abort()
  }, [selectedSkillName, schedule])

  // The knowledge layer is rendered as the pinned always-included row, so it
  // is never offered as a checkbox even if the API includes it in the list.
  const additionalSources = useMemo(
    () => sources?.filter((source) => source.id !== KNOWLEDGE_LAYER_ID) ?? null,
    [sources],
  )

  const timezones = useMemo(() => supportedTimezones(), [])

  const schema = useMemo(
    () =>
      z.object({
        name: z.string().trim().min(1, t('builder.nameRequired')).max(200, t('builder.nameTooLong')),
      }),
    [t],
  )

  const form = useAppForm({
    defaultValues: {
      name: schedule?.name ?? '',
    } satisfies BuilderValues,
    validators: { onChange: schema },
    onSubmit: async ({ value }) => {
      setFormError(null)
      setScheduleError(null)

      if (!selectedSkill) {
        setFormError(t('builder.skillRequired'))
        return
      }

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

      // Mirrors the server: cron writes are vetoed for skills that opted out
      // via grid-schedulable=false (manual runs stay possible).
      if (effectiveCron && !isSchedulable(selectedSkill.metadata)) {
        setScheduleError(t('builder.skillNotSchedulable', { name: selectedSkill.name }))
        return
      }

      const payload: CreateSkillScheduleInput = {
        name: value.name.trim(),
        skillName: selectedSkill.name,
        dataSources: selectedSources.size > 0 ? Array.from(selectedSources) : null,
        enabled,
        scheduleCron: effectiveCron,
        scheduleTimezone: timezone,
      }

      try {
        if (schedule) {
          await updateSkillSchedule(projectId, schedule.id, payload)
          toast.success(t('builder.updateSuccess'))
        } else {
          await createSkillSchedule(projectId, payload)
          toast.success(t('builder.createSuccess'))
        }
        onSaved()
      } catch (err) {
        // 400/422 are validation failures — most reach here via the schedule
        // (cron / min interval / schedulability veto), so surface the server's
        // message inline there.
        if (err instanceof SkillApiError && (err.status === 400 || err.status === 422)) {
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

  const snapshot = toSnapshot(selectedSkill)

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

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('builder.skillSection')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-col gap-1.5">
                  <Label className="text-sm font-medium">{t('builder.skillLabel')}</Label>
                  {skills === null && !skillsError && (
                    <p className="text-sm text-muted-foreground">{t('builder.skillsLoading')}</p>
                  )}
                  {skillsError ? (
                    <p className="text-sm text-muted-foreground">{t('builder.skillsError')}</p>
                  ) : (
                    skills !== null && (
                      <Select
                        value={selectedSkill?.name ?? ''}
                        onValueChange={(name) => {
                          const item = skills.find((skill) => skill.name === name)
                          if (item) {
                            setSelectedSkill(item)
                            setSelectedSkillName(item.name)
                            setScheduleError(null)
                          }
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t('builder.skillPlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          {skills.map((skill) => (
                            <SelectItem key={skill.name} value={skill.name}>
                              {skill.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )
                  )}
                </div>
                {selectedSkill !== null && (
                  <p className="text-xs text-muted-foreground">{selectedSkill.description}</p>
                )}
                {selectedSkill !== null && !isSchedulable(selectedSkill.metadata) &&
                  scheduleEnabled && (
                    <p role="alert" className="text-xs font-medium text-destructive">
                      {t('builder.skillNotSchedulable', { name: selectedSkill.name })}
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
                    <Label htmlFor="skill-schedule-enabled" className="text-sm font-medium">
                      {t('builder.enableScheduleLabel')}
                    </Label>
                    <p className="text-xs text-muted-foreground">{t('builder.enableScheduleHint')}</p>
                  </div>
                  <Switch
                    id="skill-schedule-enabled"
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
                      <Select value={preset} onValueChange={(value) => changePreset(value as SchedulePreset)}>
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
                        <Label htmlFor="skill-cron" className="text-sm font-medium">
                          {t('builder.cronLabel')}
                        </Label>
                        <Input
                          id="skill-cron"
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
                  <Label htmlFor="skill-enabled" className="text-sm font-medium">
                    {t('builder.enabledLabel')}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t('builder.enabledHint')}</p>
                </div>
                <Switch id="skill-enabled" checked={enabled} onCheckedChange={setEnabled} />
              </CardContent>
            </Card>
          </div>

          {/* ---- RIGHT: live preview ---- */}
          <div>
            <form.Subscribe selector={(state) => state.values as BuilderValues}>
              {() => <SkillPreview snapshot={snapshot} />}
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
              <Button type="submit" disabled={!canSubmit || isSubmitting || skillsError}>
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
 * `buildFirePromptPreview` output verbatim — the WYSIWYG contract is that
 * this text equals the prompt submitted when the schedule fires (the server
 * builds the same prompt at fire time; the two sides are pinned by
 * fire-prompt-preview.spec.ts).
 */
function SkillPreview({
  snapshot,
}: {
  snapshot: ReturnType<typeof toSnapshot>
}): JSX.Element {
  const t = useTranslations('skills')
  const compiled = snapshot ? buildFirePromptPreview(snapshot) : ''
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
            data-testid="skill-prompt-preview"
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