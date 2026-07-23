'use client'

/**
 * Platform workflow templates manager (ADR-0027) — the platform-owner surface
 * for authoring the workflow templates published into every organization's
 * Workflows gallery. It mirrors the Base-knowledge card's shape: a short
 * explainer, a create action, a drag-and-drop JSON import, and a list of
 * existing templates (drafts + published) each with a publish toggle, export,
 * edit, and delete.
 *
 * Authoring happens in <WorkflowTemplateForm> (a DE/EN form); this component
 * owns the list, the network calls, and JSON import/export.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { toast } from 'sonner'
import {
  AlertCircle,
  Clock,
  Download,
  FileJson,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useLocale, useTranslations } from '@/i18n'
import { presetForCron } from '@/features/workflows/lib/schedule'
import {
  createPlatformTemplate,
  deletePlatformTemplate,
  listPlatformTemplates,
  updatePlatformTemplate,
  type CreatePlatformTemplateInput,
  type PlatformTemplate,
  type TemplateLocale,
} from '@/adapters/api/platform-workflow-templates-client'
import {
  WorkflowTemplateForm,
  type TemplateFormSeed,
} from './workflow-template-form'

const EXPORT_KIND = 'grid.workflow-template'
const EXPORT_VERSION = 1

/** Build the downloadable JSON for a template (draft on re-import; no PII/ids). */
function toExportJson(template: PlatformTemplate): string {
  return JSON.stringify(
    {
      kind: EXPORT_KIND,
      version: EXPORT_VERSION,
      provenance: template.provenance,
      dataSources: template.dataSources,
      agentType: template.agentType,
      scheduleCron: template.scheduleCron,
      scheduleTimezone: template.scheduleTimezone,
      sortOrder: template.sortOrder,
      content: template.content,
    },
    null,
    2,
  )
}

/** Defensive parse of an uploaded JSON file into a create-form seed. */
function parseImport(raw: unknown): TemplateFormSeed {
  if (!raw || typeof raw !== 'object') throw new Error('not-object')
  const obj = raw as Record<string, unknown>
  const content = obj.content
  if (!content || typeof content !== 'object') throw new Error('no-content')
  const c = content as Record<string, unknown>
  // Require at least one locale that looks like content; the form validates the rest.
  if (!c.de && !c.en) throw new Error('no-locale')
  const provenance = ['law', 'project', 'office', 'auto'].includes(String(obj.provenance))
    ? (obj.provenance as TemplateFormSeed['provenance'])
    : 'auto'
  return {
    provenance,
    dataSources: Array.isArray(obj.dataSources) ? (obj.dataSources as string[]) : null,
    scheduleCron: typeof obj.scheduleCron === 'string' ? obj.scheduleCron : null,
    scheduleTimezone: typeof obj.scheduleTimezone === 'string' ? obj.scheduleTimezone : 'Europe/Vienna',
    sortOrder: typeof obj.sortOrder === 'number' ? obj.sortOrder : 0,
    published: false,
    content: c as TemplateFormSeed['content'],
  }
}

function localizedName(template: PlatformTemplate, locale: string): string {
  const loc: TemplateLocale = locale === 'de' ? 'de' : 'en'
  return template.content[loc]?.name ?? template.content.en?.name ?? template.content.de?.name ?? '—'
}

export function WorkflowTemplates(): JSX.Element {
  const t = useTranslations('platform')
  const tw = useTranslations('workflows')
  const { locale } = useLocale()

  const [templates, setTemplates] = useState<PlatformTemplate[] | null>(null)
  const [hasError, setHasError] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<PlatformTemplate | null>(null)
  const [seed, setSeed] = useState<TemplateFormSeed | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PlatformTemplate | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [isDragActive, setIsDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    setHasError(false)
    return listPlatformTemplates()
      .then(setTemplates)
      .catch(() => {
        setTemplates(null)
        setHasError(true)
      })
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setEditing(null)
    setSeed(null)
    setFormOpen(true)
  }

  const openEdit = (template: PlatformTemplate) => {
    setEditing(template)
    setSeed(null)
    setFormOpen(true)
  }

  const handleImportFile = useCallback((file: File) => {
    file
      .text()
      .then((text) => {
        const parsed = parseImport(JSON.parse(text))
        setEditing(null)
        setSeed(parsed)
        setFormOpen(true)
        toast.success(t('workflowTemplates.importLoaded'))
      })
      .catch(() => toast.error(t('workflowTemplates.importInvalid')))
  }, [t])

  const handleSubmit = useCallback(
    async (input: CreatePlatformTemplateInput, id: string | null) => {
      if (id) {
        const updated = await updatePlatformTemplate(id, input)
        setTemplates((prev) => (prev ? prev.map((row) => (row.id === id ? updated : row)) : prev))
        toast.success(t('workflowTemplates.updateSuccess'))
      } else {
        const created = await createPlatformTemplate(input)
        setTemplates((prev) => (prev ? [...prev, created] : [created]))
        toast.success(t('workflowTemplates.createSuccess'))
      }
      void load()
    },
    [load, t],
  )

  const handleTogglePublish = useCallback(
    (template: PlatformTemplate, next: boolean) => {
      setBusyId(template.id)
      // Optimistic flip; revert on failure.
      setTemplates((prev) =>
        prev ? prev.map((row) => (row.id === template.id ? { ...row, published: next } : row)) : prev,
      )
      updatePlatformTemplate(template.id, { published: next })
        .then((updated) => {
          setTemplates((prev) => (prev ? prev.map((row) => (row.id === template.id ? updated : row)) : prev))
          toast.success(t(next ? 'workflowTemplates.publishSuccess' : 'workflowTemplates.unpublishSuccess'))
        })
        .catch(() => {
          setTemplates((prev) =>
            prev
              ? prev.map((row) => (row.id === template.id ? { ...row, published: !next } : row))
              : prev,
          )
          toast.error(t('workflowTemplates.publishFailed'))
        })
        .finally(() => setBusyId(null))
    },
    [t],
  )

  const handleExport = (template: PlatformTemplate) => {
    const blob = new Blob([toExportJson(template)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `workflow-template-${template.id}.json`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  const handleDelete = useCallback(() => {
    if (!pendingDelete) return
    const id = pendingDelete.id
    setIsDeleting(true)
    deletePlatformTemplate(id)
      .then(() => {
        setTemplates((prev) => (prev ? prev.filter((row) => row.id !== id) : prev))
        toast.success(t('workflowTemplates.deleteSuccess'))
      })
      .catch(() => toast.error(t('workflowTemplates.deleteFailed')))
      .finally(() => {
        setIsDeleting(false)
        setPendingDelete(null)
      })
  }, [pendingDelete, t])

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragActive(false)
    const file = event.dataTransfer.files?.[0]
    if (file) handleImportFile(file)
  }

  const cadence = (template: PlatformTemplate): string => {
    if (!template.scheduleCron) return t('workflowTemplates.manualCadence')
    const preset = presetForCron(template.scheduleCron)
    if (preset === 'custom') return template.scheduleCron
    return tw(`schedule.presets.${preset}`)
  }

  const isLoading = templates === null && !hasError
  const sorted = useMemo(
    () => (templates ? [...templates].sort((a, b) => a.sortOrder - b.sortOrder) : []),
    [templates],
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <WorkflowIcon className="size-4 text-muted-foreground" aria-hidden />
          {t('workflowTemplates.title')}
        </CardTitle>
        <CardDescription>{t('workflowTemplates.explainer')}</CardDescription>
        <CardAction>
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-3.5" aria-hidden />
            {t('workflowTemplates.new')}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* JSON import dropzone. */}
        <div
          role="button"
          tabIndex={0}
          aria-label={t('workflowTemplates.dropTitle')}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              fileInputRef.current?.click()
            }
          }}
          onDragOver={(event) => {
            event.preventDefault()
            setIsDragActive(true)
          }}
          onDragLeave={() => setIsDragActive(false)}
          onDrop={onDrop}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
            isDragActive ? 'border-primary bg-accent' : 'border-border hover:border-primary/60 hover:bg-accent/40',
          )}
          data-testid="template-import-dropzone"
        >
          <FileJson className="size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium text-foreground">
            {isDragActive ? t('workflowTemplates.dropActive') : t('workflowTemplates.dropTitle')}
          </p>
          <p className="text-xs text-muted-foreground">{t('workflowTemplates.dropHint')}</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            data-testid="template-import-input"
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) handleImportFile(file)
            }}
          />
        </div>

        {isLoading && <Skeleton className="h-40 w-full rounded-xl" data-testid="templates-loading" />}

        {hasError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" aria-hidden />
            <AlertTitle>{t('workflowTemplates.loadError')}</AlertTitle>
            <AlertDescription>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RotateCcw className="size-3.5" aria-hidden />
                {t('workflowTemplates.retry')}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {!isLoading && !hasError && sorted.length === 0 && (
          <EmptyState variant="bare" icon={WorkflowIcon} title={t('workflowTemplates.empty')} />
        )}

        {!isLoading && !hasError && sorted.length > 0 && (
          <div
            className="divide-y divide-border overflow-hidden rounded-lg border border-border"
            data-testid="platform-template-list"
          >
            {sorted.map((template) => (
              <div
                key={template.id}
                className="flex flex-col gap-2.5 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <p className="truncate text-sm font-medium text-foreground">
                    {localizedName(template, locale)}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={template.published ? 'success' : 'secondary'}>
                      {template.published
                        ? t('workflowTemplates.published')
                        : t('workflowTemplates.draft')}
                    </Badge>
                    <Badge variant="outline">{t(`workflowTemplates.provenance.${template.provenance}`)}</Badge>
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="size-3" aria-hidden />
                      {cadence(template)}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 sm:pl-3">
                  <span className="flex items-center gap-1.5 pr-1">
                    <Switch
                      checked={template.published}
                      disabled={busyId === template.id}
                      onCheckedChange={(next) => handleTogglePublish(template, next)}
                      aria-label={t(
                        template.published
                          ? 'workflowTemplates.unpublishAria'
                          : 'workflowTemplates.publishAria',
                        { name: localizedName(template, locale) },
                      )}
                    />
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label={t('workflowTemplates.export')}
                    onClick={() => handleExport(template)}
                  >
                    <Download className="size-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label={t('workflowTemplates.edit')}
                    onClick={() => openEdit(template)}
                  >
                    <Pencil className="size-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label={t('workflowTemplates.delete')}
                    onClick={() => setPendingDelete(template)}
                  >
                    <Trash2 className="size-4 text-destructive" aria-hidden />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <WorkflowTemplateForm
        open={formOpen}
        onOpenChange={setFormOpen}
        template={editing}
        seed={seed}
        onSubmit={handleSubmit}
      />

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && !isDeleting && setPendingDelete(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('workflowTemplates.deleteTitle', {
                name: pendingDelete ? localizedName(pendingDelete, locale) : '',
              })}
            </DialogTitle>
            <DialogDescription>{t('workflowTemplates.deleteDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)} disabled={isDeleting}>
              {t('workflowTemplates.deleteCancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? <Spinner className="size-3.5" /> : <Trash2 className="size-3.5" aria-hidden />}
              {t('workflowTemplates.deleteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
