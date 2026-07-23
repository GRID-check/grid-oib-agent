'use client'

/**
 * Platform workflow template editor (ADR-0027) — the create/edit form the
 * platform owner uses to author a template published into every org's gallery.
 *
 * A template carries author-written text in BOTH locales (de + en), so the form
 * is organized as one shared block (provenance, additional data sources,
 * suggested schedule, ordering, publish state) plus a per-locale tab set for
 * the human-readable brief. A live compiled-prompt preview per locale mirrors
 * what the adopting user will see in the builder. The same shape is produced by
 * the JSON-import path, so an imported draft opens straight into this form.
 */

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useTranslations } from '@/i18n'
import { createDataSourcesClient, type DataSourceFromAPI } from '@/adapters/api/data-sources-client'
import { compilePreview } from '@/features/workflows/lib/compile-preview'
import {
  PRESET_CRON,
  SCHEDULE_PRESETS,
  presetForCron,
  supportedTimezones,
  type SchedulePreset,
} from '@/features/workflows/lib/schedule'
import type {
  CreatePlatformTemplateInput,
  LocalizedTemplateContent,
  PlatformTemplate,
  TemplateLocale,
  TemplateProvenance,
} from '@/adapters/api/platform-workflow-templates-client'

const KNOWLEDGE_LAYER_ID = 'knowledge_layer'
const PROVENANCES: TemplateProvenance[] = ['law', 'project', 'office', 'auto']
const LOCALES: TemplateLocale[] = ['de', 'en']

/** Editable string state for one locale (questions edited as one-per-line). */
interface LocaleForm {
  name: string
  description: string
  category: string
  objective: string
  context: string
  questionsText: string
  outputFormat: string
}

const emptyLocale = (): LocaleForm => ({
  name: '',
  description: '',
  category: '',
  objective: '',
  context: '',
  questionsText: '',
  outputFormat: '',
})

function contentToForm(content: LocalizedTemplateContent): LocaleForm {
  const blocks = content.definition.blocks
  return {
    name: content.name,
    description: content.description,
    category: content.category,
    objective: blocks.objective ?? '',
    context: blocks.context ?? '',
    questionsText: (blocks.questions ?? []).join('\n'),
    outputFormat: blocks.outputFormat ?? '',
  }
}

function formToContent(form: LocaleForm): LocalizedTemplateContent {
  const questions = form.questionsText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    category: form.category.trim(),
    definition: {
      version: 1,
      blocks: {
        objective: form.objective.trim(),
        context: form.context.trim() || undefined,
        questions: questions.length > 0 ? questions : undefined,
        outputFormat: form.outputFormat.trim() || undefined,
      },
    },
  }
}

export interface TemplateFormSeed {
  provenance: TemplateProvenance
  dataSources: string[] | null
  scheduleCron: string | null
  scheduleTimezone: string
  sortOrder: number
  published: boolean
  content: Record<TemplateLocale, LocalizedTemplateContent>
}

interface WorkflowTemplateFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Present when editing an existing template (id → PATCH); null when creating. */
  template: PlatformTemplate | null
  /** A pre-filled draft (e.g. from JSON import) when creating; ignored on edit. */
  seed: TemplateFormSeed | null
  onSubmit: (input: CreatePlatformTemplateInput, id: string | null) => Promise<void>
}

export function WorkflowTemplateForm({
  open,
  onOpenChange,
  template,
  seed,
  onSubmit,
}: WorkflowTemplateFormProps): JSX.Element {
  const t = useTranslations('platform')
  const isEdit = template !== null

  const initial = template ?? seed

  const [provenance, setProvenance] = useState<TemplateProvenance>('auto')
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set())
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [preset, setPreset] = useState<SchedulePreset>('daily')
  const [cron, setCron] = useState<string>(PRESET_CRON.daily)
  const [timezone, setTimezone] = useState<string>('Europe/Vienna')
  const [sortOrder, setSortOrder] = useState<number>(0)
  const [published, setPublished] = useState(false)
  const [de, setDe] = useState<LocaleForm>(emptyLocale)
  const [en, setEn] = useState<LocaleForm>(emptyLocale)
  const [activeLocale, setActiveLocale] = useState<TemplateLocale>('de')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // (Re)seed the form whenever the dialog opens for a new subject.
  useEffect(() => {
    if (!open) return
    setProvenance(initial?.provenance ?? 'auto')
    setSelectedSources(new Set(initial?.dataSources ?? []))
    const seededCron = initial?.scheduleCron ?? null
    setScheduleEnabled(Boolean(seededCron))
    setPreset(presetForCron(seededCron))
    setCron(seededCron ?? PRESET_CRON.daily)
    setTimezone(initial?.scheduleTimezone ?? 'Europe/Vienna')
    setSortOrder(initial?.sortOrder ?? 0)
    setPublished(initial?.published ?? false)
    setDe(initial ? contentToForm(initial.content.de) : emptyLocale())
    setEn(initial ? contentToForm(initial.content.en) : emptyLocale())
    setActiveLocale('de')
    setError(null)
    // Only re-run when the dialog opens or the subject identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template?.id, seed])

  // --- Additional data sources (knowledge layer is always-on, so excluded). ---
  const [sources, setSources] = useState<DataSourceFromAPI[] | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    createDataSourcesClient()
      .getDataSources(controller.signal)
      .then((response) => setSources(response.data_sources))
      .catch(() => {
        /* Non-fatal: the author can still save without extra sources. */
      })
    return () => controller.abort()
  }, [])

  const additionalSources = useMemo(
    () => sources?.filter((source) => source.id !== KNOWLEDGE_LAYER_ID) ?? null,
    [sources],
  )
  const timezones = useMemo(() => supportedTimezones(), [])

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
    if (next !== 'custom') setCron(PRESET_CRON[next])
  }

  const activeForm = activeLocale === 'de' ? de : en
  const setActiveForm = activeLocale === 'de' ? setDe : setEn
  const previewText = useMemo(
    () => compilePreview(formToContent(activeForm).definition),
    [activeForm],
  )

  const handleSubmit = async () => {
    // Both locales must carry a name and an objective — the gallery renders in
    // either locale and the compiled brief needs an objective.
    for (const [loc, form] of [
      ['de', de],
      ['en', en],
    ] as const) {
      if (!form.name.trim() || !form.objective.trim()) {
        setActiveLocale(loc)
        setError(t('workflowTemplates.form.requiredError'))
        return
      }
      if (!form.description.trim() || !form.category.trim()) {
        setActiveLocale(loc)
        setError(t('workflowTemplates.form.requiredError'))
        return
      }
    }

    const input: CreatePlatformTemplateInput = {
      provenance,
      dataSources: Array.from(selectedSources),
      scheduleCron: scheduleEnabled ? (preset === 'custom' ? cron.trim() : PRESET_CRON[preset]) : null,
      scheduleTimezone: timezone,
      sortOrder,
      published,
      content: { de: formToContent(de), en: formToContent(en) },
    }

    setSaving(true)
    setError(null)
    try {
      await onSubmit(input, template?.id ?? null)
      onOpenChange(false)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t('workflowTemplates.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const localeField = (
    key: keyof LocaleForm,
    labelKey: string,
    opts: { textarea?: boolean; rows?: number; hintKey?: string } = {},
  ) => (
    <div className="flex flex-col gap-1.5">
      <Label className="text-sm font-medium">{t(`workflowTemplates.form.${labelKey}`)}</Label>
      {opts.textarea ? (
        <Textarea
          value={activeForm[key]}
          rows={opts.rows ?? 3}
          onChange={(event) => setActiveForm({ ...activeForm, [key]: event.target.value })}
        />
      ) : (
        <Input
          value={activeForm[key]}
          onChange={(event) => setActiveForm({ ...activeForm, [key]: event.target.value })}
        />
      )}
      {opts.hintKey && (
        <p className="text-xs text-muted-foreground">{t(`workflowTemplates.form.${opts.hintKey}`)}</p>
      )}
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('workflowTemplates.form.editTitle') : t('workflowTemplates.form.createTitle')}
          </DialogTitle>
          <DialogDescription>{t('workflowTemplates.form.subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {/* Shared (non-localized) settings. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label className="text-sm font-medium">{t('workflowTemplates.form.provenanceLabel')}</Label>
              <Select value={provenance} onValueChange={(value) => setProvenance(value as TemplateProvenance)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVENANCES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`workflowTemplates.provenance.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tpl-sort" className="text-sm font-medium">
                {t('workflowTemplates.form.sortOrderLabel')}
              </Label>
              <Input
                id="tpl-sort"
                type="number"
                min={0}
                value={sortOrder}
                onChange={(event) => setSortOrder(Math.max(0, Number(event.target.value) || 0))}
              />
              <p className="text-xs text-muted-foreground">{t('workflowTemplates.form.sortOrderHint')}</p>
            </div>
          </div>

          {/* Additional data sources. */}
          <div className="flex flex-col gap-2">
            <Label className="text-sm font-medium">{t('workflowTemplates.form.dataSourcesLabel')}</Label>
            <p className="text-xs text-muted-foreground">{t('workflowTemplates.form.dataSourcesHint')}</p>
            {additionalSources === null ? (
              <p className="text-sm text-muted-foreground">{t('workflowTemplates.form.sourcesLoading')}</p>
            ) : additionalSources.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('workflowTemplates.form.sourcesAll')}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {additionalSources.map((source) => (
                  <label key={source.id} className="flex items-start gap-2.5">
                    <Checkbox
                      checked={selectedSources.has(source.id)}
                      onCheckedChange={(value) => toggleSource(source.id, value === true)}
                    />
                    <span className="flex flex-col">
                      <span className="text-sm font-medium text-foreground">{source.name}</span>
                      {source.description && (
                        <span className="text-xs text-muted-foreground">{source.description}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Suggested schedule. */}
          <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="tpl-schedule" className="text-sm font-medium">
                  {t('workflowTemplates.form.scheduleLabel')}
                </Label>
                <p className="text-xs text-muted-foreground">{t('workflowTemplates.form.scheduleHint')}</p>
              </div>
              <Switch id="tpl-schedule" checked={scheduleEnabled} onCheckedChange={setScheduleEnabled} />
            </div>
            {scheduleEnabled && (
              <div className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label className="text-sm font-medium">{t('workflowTemplates.form.presetLabel')}</Label>
                  <Select value={preset} onValueChange={(value) => changePreset(value as SchedulePreset)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SCHEDULE_PRESETS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {t(`workflowTemplates.form.presets.${option}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-sm font-medium">{t('workflowTemplates.form.timezoneLabel')}</Label>
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
                {preset === 'custom' && (
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <Label htmlFor="tpl-cron" className="text-sm font-medium">
                      {t('workflowTemplates.form.cronLabel')}
                    </Label>
                    <Input
                      id="tpl-cron"
                      value={cron}
                      spellCheck={false}
                      autoComplete="off"
                      className="font-mono"
                      placeholder="0 6 * * 1"
                      onChange={(event) => setCron(event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">{t('workflowTemplates.form.cronHint')}</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Per-locale content. */}
          <Tabs value={activeLocale} onValueChange={(value) => setActiveLocale(value as TemplateLocale)}>
            <TabsList>
              {LOCALES.map((loc) => (
                <TabsTrigger key={loc} value={loc}>
                  {t(`workflowTemplates.form.locale.${loc}`)}
                </TabsTrigger>
              ))}
            </TabsList>
            {LOCALES.map((loc) => (
              <TabsContent key={loc} value={loc} className="flex flex-col gap-4 pt-2">
                {localeField('name', 'nameLabel')}
                {localeField('description', 'descriptionLabel', { textarea: true, rows: 2 })}
                {localeField('category', 'categoryLabel', { hintKey: 'categoryHint' })}
                {localeField('objective', 'objectiveLabel', { textarea: true, rows: 3 })}
                {localeField('context', 'contextLabel', { textarea: true, rows: 3 })}
                {localeField('questionsText', 'questionsLabel', {
                  textarea: true,
                  rows: 4,
                  hintKey: 'questionsHint',
                })}
                {localeField('outputFormat', 'outputFormatLabel', { textarea: true, rows: 2 })}

                {/* Live compiled-prompt preview for this locale. */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-sm font-medium">{t('workflowTemplates.form.previewLabel')}</Label>
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                    {previewText || t('workflowTemplates.form.previewEmpty')}
                  </pre>
                </div>
              </TabsContent>
            ))}
          </Tabs>

          {/* Publish state. */}
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="tpl-publish" className="text-sm font-medium">
                {t('workflowTemplates.form.publishLabel')}
              </Label>
              <p className="text-xs text-muted-foreground">{t('workflowTemplates.form.publishHint')}</p>
            </div>
            <Switch id="tpl-publish" checked={published} onCheckedChange={setPublished} />
          </div>

          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('workflowTemplates.form.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving && <Spinner className="size-3.5" />}
            {saving ? t('workflowTemplates.form.saving') : t('workflowTemplates.form.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
