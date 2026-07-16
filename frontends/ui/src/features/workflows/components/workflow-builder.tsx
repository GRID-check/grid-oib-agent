'use client'

/**
 * Workflow builder — create/edit a saved research brief. Two columns: the
 * blocks form on the left, a live "What the agent receives" preview on the
 * right (the preview mirrors the server compiler; see brief-preview.tsx). On
 * narrow viewports the columns stack (preview below the form).
 *
 * Scalar text fields use TanStack Form + Zod (src/components/form); the dynamic
 * pieces that don't fit a single field — the research-questions list, the
 * data-source checkboxes, and the schedule editor — are managed as local state
 * and merged into the definition on submit.
 */

import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Lock, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { useAppForm } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
  createWorkflow,
  updateWorkflow,
  WorkflowApiError,
  type CreateWorkflowInput,
  type WorkflowDefinition,
  type WorkflowDetail,
} from '@/adapters/api/workflows-client'
import { compilePreview, MAX_COMPILED_PROMPT_LENGTH } from '../lib/compile-preview'
import {
  browserTimezone,
  isPlausibleCron,
  PRESET_CRON,
  presetForCron,
  SCHEDULE_PRESETS,
  supportedTimezones,
  type SchedulePreset,
} from '../lib/schedule'
import type { ResolvedTemplate } from '../lib/templates'
import { BriefPreview } from './brief-preview'

// The always-included knowledge source is rendered as a pinned, non-interactive
// row (never a checkbox); it is server-guaranteed on every run, so we defensively
// drop it from the fetched additional-source list even though the data-sources
// client already filters it out.
const KNOWLEDGE_LAYER_ID = 'knowledge_layer'

interface WorkflowBuilderProps {
  projectId: string
  /** The workflow being edited, or null when creating. */
  workflow: WorkflowDetail | null
  /** A GRID template to pre-fill from when creating (ignored while editing). */
  template?: ResolvedTemplate | null
  onSaved: () => void
  onCancel: () => void
}

interface BuilderValues {
  name: string
  description: string
  objective: string
  context: string
  outputFormat: string
}

/** Merge the scalar form values and the question list into a definition. */
function buildDefinition(values: BuilderValues, questions: string[]): WorkflowDefinition {
  const cleanedQuestions = questions.map((q) => q.trim()).filter(Boolean)
  return {
    version: 1,
    blocks: {
      objective: values.objective.trim(),
      context: values.context.trim() || undefined,
      questions: cleanedQuestions.length > 0 ? cleanedQuestions : undefined,
      outputFormat: values.outputFormat.trim() || undefined,
    },
  }
}

export function WorkflowBuilder({
  projectId,
  workflow,
  template = null,
  onSaved,
  onCancel,
}: WorkflowBuilderProps): JSX.Element {
  const t = useTranslations('workflows')
  const isEdit = workflow !== null

  // When creating from a GRID template, its content seeds every field; the user
  // reviews the pre-filled brief and saves it (templates never auto-create).
  // While editing an existing workflow, the template is ignored.
  const seed = workflow ?? template

  // --- Auxiliary (non-TanStack) state -------------------------------------
  const [questions, setQuestions] = useState<string[]>(seed?.definition.blocks.questions ?? [])
  const [selectedSources, setSelectedSources] = useState<Set<string>>(
    new Set(seed?.dataSources ?? []),
  )
  const [enabled, setEnabled] = useState<boolean>(workflow?.enabled ?? true)
  const [scheduleEnabled, setScheduleEnabled] = useState<boolean>(Boolean(seed?.scheduleCron))
  const [preset, setPreset] = useState<SchedulePreset>(presetForCron(seed?.scheduleCron))
  const [cron, setCron] = useState<string>(seed?.scheduleCron ?? PRESET_CRON.daily)
  const [timezone, setTimezone] = useState<string>(seed?.scheduleTimezone ?? browserTimezone())
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

  // The knowledge layer is rendered as the pinned always-included row, so it is
  // never offered as a checkbox even if the API includes it in the list.
  const additionalSources = useMemo(
    () => sources?.filter((source) => source.id !== KNOWLEDGE_LAYER_ID) ?? null,
    [sources],
  )

  const timezones = useMemo(() => supportedTimezones(), [])

  const schema = useMemo(
    () =>
      // Form values are always strings (empty = unset, mapped at submit), so
      // the schema mirrors that shape exactly — TanStack Form's StandardSchema
      // integration requires schema input == form values (no optionals here).
      z.object({
        name: z.string().trim().min(1, t('builder.nameRequired')).max(200, t('builder.nameTooLong')),
        description: z.string().max(2000),
        objective: z.string().trim().min(1, t('builder.objectiveRequired')),
        context: z.string(),
        outputFormat: z.string(),
      }),
    [t],
  )

  const form = useAppForm({
    defaultValues: {
      name: seed?.name ?? '',
      description: seed?.description ?? '',
      objective: seed?.definition.blocks.objective ?? '',
      context: seed?.definition.blocks.context ?? '',
      outputFormat: seed?.definition.blocks.outputFormat ?? '',
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

      const definition = buildDefinition(value, questions)
      if (compilePreview(definition).length > MAX_COMPILED_PROMPT_LENGTH) {
        setFormError(t('builder.compiledTooLong'))
        return
      }

      // Create schema accepts description as optional() (not nullish), so omit
      // it when empty on create; PATCH accepts null, so an empty edit clears it.
      const trimmedDescription = value.description.trim()
      const payload: CreateWorkflowInput = {
        name: value.name.trim(),
        description: trimmedDescription || (workflow ? null : undefined),
        definition,
        dataSources: selectedSources.size > 0 ? Array.from(selectedSources) : null,
        enabled,
        scheduleCron: effectiveCron,
        scheduleTimezone: timezone,
      }

      try {
        if (workflow) {
          await updateWorkflow(projectId, workflow.id, payload)
          toast.success(t('builder.updateSuccess'))
        } else {
          await createWorkflow(projectId, payload)
          toast.success(t('builder.createSuccess'))
        }
        onSaved()
      } catch (err) {
        // 400/422 are validation failures — most reach here via the schedule
        // (cron / min interval), so surface the server's message inline there.
        if (err instanceof WorkflowApiError && (err.status === 400 || err.status === 422)) {
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
          {/* ---- LEFT: blocks form ---- */}
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
                <form.AppField name="description">
                  {(field) => (
                    <field.TextAreaField
                      label={t('builder.descriptionLabel')}
                      placeholder={t('builder.descriptionPlaceholder')}
                      rows={2}
                    />
                  )}
                </form.AppField>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('builder.briefSection')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <form.AppField name="objective">
                  {(field) => (
                    <field.TextAreaField
                      label={t('builder.objectiveLabel')}
                      placeholder={t('builder.objectivePlaceholder')}
                      required
                      rows={3}
                    />
                  )}
                </form.AppField>
                <form.AppField name="context">
                  {(field) => (
                    <field.TextAreaField
                      label={t('builder.contextLabel')}
                      placeholder={t('builder.contextPlaceholder')}
                      rows={3}
                    />
                  )}
                </form.AppField>

                {/* Research questions — dynamic list */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-sm font-medium">{t('builder.questionsLabel')}</Label>
                  <p className="text-xs text-muted-foreground">{t('builder.questionsHint')}</p>
                  <div className="mt-1 space-y-2">
                    {questions.map((question, index) => (
                      // Index key is acceptable: the list is small, reorder-free,
                      // and each row is a controlled input tied to its position.
                      <div key={index} className="flex items-center gap-2">
                        <Input
                          value={question}
                          placeholder={`${t('builder.questionPlaceholder')} ${index + 1}`}
                          aria-label={`${t('builder.questionPlaceholder')} ${index + 1}`}
                          onChange={(event) =>
                            setQuestions((prev) =>
                              prev.map((q, i) => (i === index ? event.target.value : q)),
                            )
                          }
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-9 shrink-0 text-muted-foreground"
                          aria-label={t('builder.removeQuestion')}
                          onClick={() => setQuestions((prev) => prev.filter((_, i) => i !== index))}
                        >
                          <X className="size-4" aria-hidden />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-1 w-fit"
                    onClick={() => setQuestions((prev) => [...prev, ''])}
                  >
                    <Plus className="size-3.5" aria-hidden />
                    {t('builder.addQuestion')}
                  </Button>
                </div>

                <form.AppField name="outputFormat">
                  {(field) => (
                    <field.TextAreaField
                      label={t('builder.outputFormatLabel')}
                      placeholder={t('builder.outputFormatPlaceholder')}
                      rows={2}
                    />
                  )}
                </form.AppField>
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
                    <Label htmlFor="wf-schedule-enabled" className="text-sm font-medium">
                      {t('builder.enableScheduleLabel')}
                    </Label>
                    <p className="text-xs text-muted-foreground">{t('builder.enableScheduleHint')}</p>
                  </div>
                  <Switch
                    id="wf-schedule-enabled"
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
                        <Label htmlFor="wf-cron" className="text-sm font-medium">
                          {t('builder.cronLabel')}
                        </Label>
                        <Input
                          id="wf-cron"
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
                  <Label htmlFor="wf-enabled" className="text-sm font-medium">
                    {t('builder.enabledLabel')}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t('builder.enabledHint')}</p>
                </div>
                <Switch id="wf-enabled" checked={enabled} onCheckedChange={setEnabled} />
              </CardContent>
            </Card>
          </div>

          {/* ---- RIGHT: live preview ---- */}
          <div>
            <form.Subscribe selector={(state) => state.values as BuilderValues}>
              {(values) => <BriefPreview definition={buildDefinition(values, questions)} />}
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
