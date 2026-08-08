'use client'

/**
 * Platform workflow templates manager (ADR-0027) — the platform-owner surface
 * for authoring the templates published into every organization's Workflows
 * gallery.
 *
 * Built on the shared admin primitives: SectionCard chrome (one loading / error
 * / empty treatment), a DataToolbar carrying search and the published/draft
 * filter, and a Table whose columns are the things an owner actually compares
 * across templates — category, provenance tint, data sources, cadence and
 * publish state. The bespoke card rows this replaced could show all of that
 * only by stacking badges, and could not be scanned column-wise at all.
 *
 * Two things stay deliberately out of the page's resting state: authoring
 * happens in a Sheet (<WorkflowTemplateForm>), and the JSON-import dropzone
 * lives behind an "Import JSON" action rather than sitting above the list on
 * every visit.
 *
 * This component owns the list, the network calls and JSON import/export.
 */

import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import { toast } from 'sonner'
import {
  Download,
  FileJson,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataToolbar } from '@/components/ui/data-toolbar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Pagination } from '@/components/ui/pagination'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { useLocale, useTranslations } from '@/i18n'
import { presetForCron } from '@/features/workflows/lib/schedule'
import { SectionCard } from './section-card'
import {
  createPlatformTemplate,
  deletePlatformTemplate,
  listPlatformTemplates,
  updatePlatformTemplate,
  type CreatePlatformTemplateInput,
  type LocalizedTemplateContent,
  type PlatformTemplate,
  type TemplateLocale,
} from '@/adapters/api/platform-workflow-templates-client'
import { WorkflowTemplateForm, type TemplateFormSeed } from './workflow-template-form'

const EXPORT_KIND = 'grid.workflow-template'
const EXPORT_VERSION = 1
const PAGE_SIZE = 10
/** How many data-source chips a row shows before collapsing the rest into "+N". */
const SOURCE_CHIP_LIMIT = 2

type PublishFilter = 'all' | 'published' | 'draft'

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

/**
 * The viewer's locale, falling back to the other one. Typed as partial because
 * the API's both-locales guarantee is a server-side invariant, not something a
 * hand-edited import or an older row can be trusted to honour.
 */
function localizedContent(
  template: PlatformTemplate,
  locale: string,
): LocalizedTemplateContent | undefined {
  const loc: TemplateLocale = locale === 'de' ? 'de' : 'en'
  const byLocale = template.content as Partial<Record<TemplateLocale, LocalizedTemplateContent>>
  return byLocale[loc] ?? byLocale.en ?? byLocale.de
}

function localizedName(template: PlatformTemplate, locale: string): string {
  return localizedContent(template, locale)?.name ?? '—'
}

export function WorkflowTemplates(): JSX.Element {
  const t = useTranslations('platform.workflowsSection')
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
  const [importOpen, setImportOpen] = useState(false)
  const [isDragActive, setIsDragActive] = useState(false)
  const [query, setQuery] = useState('')
  const [publishFilter, setPublishFilter] = useState<PublishFilter>('all')
  const [offset, setOffset] = useState(0)

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

  const handleImportFile = useCallback(
    (file: File) => {
      file
        .text()
        .then((text) => {
          const parsed = parseImport(JSON.parse(text))
          setEditing(null)
          setSeed(parsed)
          setImportOpen(false)
          setFormOpen(true)
          toast.success(t('importLoaded'))
        })
        .catch(() => toast.error(t('importInvalid')))
    },
    [t],
  )

  const handleSubmit = useCallback(
    async (input: CreatePlatformTemplateInput, id: string | null) => {
      if (id) {
        const updated = await updatePlatformTemplate(id, input)
        setTemplates((prev) => (prev ? prev.map((row) => (row.id === id ? updated : row)) : prev))
        toast.success(t('updateSuccess'))
      } else {
        const created = await createPlatformTemplate(input)
        setTemplates((prev) => (prev ? [...prev, created] : [created]))
        toast.success(t('createSuccess'))
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
          toast.success(t(next ? 'publishSuccess' : 'unpublishSuccess'))
        })
        .catch(() => {
          setTemplates((prev) =>
            prev ? prev.map((row) => (row.id === template.id ? { ...row, published: !next } : row)) : prev,
          )
          toast.error(t('publishFailed'))
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
        toast.success(t('deleteSuccess'))
      })
      .catch(() => toast.error(t('deleteFailed')))
      .finally(() => {
        setIsDeleting(false)
        setPendingDelete(null)
      })
  }, [pendingDelete, t])

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    setIsDragActive(false)
    const file = event.dataTransfer.files?.[0]
    if (file) handleImportFile(file)
  }

  const cadence = (template: PlatformTemplate): string => {
    if (!template.scheduleCron) return t('manualCadence')
    const preset = presetForCron(template.scheduleCron)
    if (preset === 'custom') return template.scheduleCron
    return tw(`schedule.presets.${preset}`)
  }

  const isLoading = templates === null && !hasError
  const sorted = useMemo(
    () => (templates ? [...templates].sort((a, b) => a.sortOrder - b.sortOrder) : []),
    [templates],
  )

  // Search covers the fields the table actually shows in the viewer's language,
  // so a hit is always something they can see in the row.
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return sorted.filter((template) => {
      if (publishFilter === 'published' && !template.published) return false
      if (publishFilter === 'draft' && template.published) return false
      if (!needle) return true
      const content = localizedContent(template, locale)
      return [content?.name, content?.description, content?.category]
        .filter((value): value is string => typeof value === 'string')
        .some((value) => value.toLowerCase().includes(needle))
    })
  }, [sorted, query, publishFilter, locale])

  // Keep the offset inside the (possibly shrunken) result set — filtering while
  // on page three must not strand the user on a blank page.
  const safeOffset = offset >= filtered.length ? 0 : offset
  const page = filtered.slice(safeOffset, safeOffset + PAGE_SIZE)
  const isFiltered = query.trim() !== '' || publishFilter !== 'all'

  const clearFilters = () => {
    setQuery('')
    setPublishFilter('all')
    setOffset(0)
  }

  const dataSourceCell = (template: PlatformTemplate): JSX.Element => {
    const ids = template.dataSources ?? []
    if (ids.length === 0) {
      return <span className="text-xs text-muted-foreground">{t('baseKnowledgeOnly')}</span>
    }
    const shown = ids.slice(0, SOURCE_CHIP_LIMIT)
    const rest = ids.length - shown.length
    return (
      <div className="flex flex-wrap items-center gap-1">
        {shown.map((id) => (
          <Badge key={id} variant="outline" className="font-normal">
            {id}
          </Badge>
        ))}
        {rest > 0 ? (
          <span className="text-xs text-muted-foreground">{t('moreSources', { count: rest })}</span>
        ) : null}
      </div>
    )
  }

  return (
    <>
      <SectionCard
        title={t('title')}
        description={t('explainer')}
        testId="platform-workflow-templates"
        loading={isLoading}
        skeletonRows={5}
        error={hasError}
        errorMessage={t('loadError')}
        onRetry={() => void load()}
        empty={!isLoading && !hasError && sorted.length === 0}
        emptyIcon={WorkflowIcon}
        emptyTitle={t('emptyTitle')}
        emptyDescription={t('emptyDescription')}
        action={
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <FileJson className="size-3.5" aria-hidden />
              {t('import')}
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-3.5" aria-hidden />
              {t('new')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <DataToolbar
            searchValue={query}
            onSearchChange={(value) => {
              setQuery(value)
              setOffset(0)
            }}
            searchPlaceholder={t('search')}
            searchLabel={t('searchLabel')}
            clearLabel={t('searchClear')}
            filters={
              <Select
                value={publishFilter}
                onValueChange={(value) => {
                  setPublishFilter(value as PublishFilter)
                  setOffset(0)
                }}
              >
                <SelectTrigger size="sm" className="w-44" aria-label={t('filterLabel')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('filterAll')}</SelectItem>
                  <SelectItem value="published">{t('filterPublished')}</SelectItem>
                  <SelectItem value="draft">{t('filterDraft')}</SelectItem>
                </SelectContent>
              </Select>
            }
          />

          {page.length === 0 ? (
            <EmptyState
              variant="bare"
              icon={WorkflowIcon}
              title={t('noMatchTitle')}
              description={t('noMatchDescription')}
              action={
                isFiltered ? (
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    {t('clearFilters')}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="rounded-lg border" data-testid="platform-template-list">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('columns.name')}</TableHead>
                    <TableHead>{t('columns.category')}</TableHead>
                    <TableHead>{t('columns.provenance')}</TableHead>
                    <TableHead>{t('columns.dataSources')}</TableHead>
                    <TableHead>{t('columns.cadence')}</TableHead>
                    <TableHead>{t('columns.published')}</TableHead>
                    <TableHead>
                      <span className="sr-only">{t('columns.actions')}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.map((template) => {
                    const content = localizedContent(template, locale)
                    const name = content?.name ?? '—'
                    return (
                      <TableRow key={template.id}>
                        <TableCell className="max-w-[18rem]">
                          <button
                            type="button"
                            aria-label={t('editAria', { name })}
                            className="text-left hover:underline focus-visible:outline-none focus-visible:ring-2 pointer-coarse:min-h-11 focus-visible:ring-ring/60"
                            onClick={() => openEdit(template)}
                          >
                            <span className="block truncate text-sm font-medium">{name}</span>
                            {content?.description ? (
                              <span className="block truncate text-xs text-muted-foreground">
                                {content.description}
                              </span>
                            ) : null}
                          </button>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {content?.category || t('noCategory')}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{t(`provenance.${template.provenance}`)}</Badge>
                        </TableCell>
                        <TableCell>{dataSourceCell(template)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{cadence(template)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={template.published}
                              disabled={busyId === template.id}
                              onCheckedChange={(next) => handleTogglePublish(template, next)}
                              aria-label={t(template.published ? 'unpublishAria' : 'publishAria', { name })}
                            />
                            <Badge variant={template.published ? 'success' : 'secondary'}>
                              {template.published ? t('published') : t('draft')}
                            </Badge>
                          </div>
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                aria-label={t('rowActions', { name })}
                              >
                                <MoreHorizontal className="size-4" aria-hidden />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => openEdit(template)}>
                                <Pencil className="size-4" aria-hidden />
                                {t('edit')}
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => handleExport(template)}>
                                <Download className="size-4" aria-hidden />
                                {t('export')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => setPendingDelete(template)}
                              >
                                <Trash2 className="size-4" aria-hidden />
                                {t('delete')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          <Pagination
            offset={safeOffset}
            pageSize={PAGE_SIZE}
            total={filtered.length}
            onOffsetChange={setOffset}
            rangeLabel={(from, to, total) => t('range', { from, to, total })}
            previousLabel={t('previous')}
            nextLabel={t('next')}
          />
        </div>
      </SectionCard>

      <WorkflowTemplateForm
        open={formOpen}
        onOpenChange={setFormOpen}
        template={editing}
        seed={seed}
        onSubmit={handleSubmit}
      />

      {/* JSON import — reached from the header action, not resident on the page. */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('importTitle')}</DialogTitle>
            <DialogDescription>{t('importDescription')}</DialogDescription>
          </DialogHeader>
          <label
            onDragOver={(event) => {
              event.preventDefault()
              setIsDragActive(true)
            }}
            // Dragging over the icon or the labels inside the zone fires
            // dragleave on the label itself; only a pointer that has actually
            // left the zone should clear the highlight.
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
              setIsDragActive(false)
            }}
            onDrop={onDrop}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors focus-within:ring-2 focus-within:ring-ring/60',
              isDragActive
                ? 'border-primary bg-accent'
                : 'border-border hover:border-primary/60 hover:bg-accent/40',
            )}
            data-testid="template-import-dropzone"
          >
            <FileJson className="size-5 text-muted-foreground" aria-hidden />
            <span className="text-sm font-medium text-foreground">
              {isDragActive ? t('dropActive') : t('dropTitle')}
            </span>
            <span className="text-xs text-muted-foreground">{t('dropHint')}</span>
            {/* Visually hidden rather than `hidden`: a real, focusable, labelled
                input keeps the dropzone keyboard-reachable without the
                click-forwarding dance the old dropzone needed. */}
            <input
              type="file"
              accept=".json,application/json"
              className="sr-only"
              aria-label={t('dropTitle')}
              data-testid="template-import-input"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) handleImportFile(file)
              }}
            />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              {t('importCancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && !isDeleting && setPendingDelete(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('deleteTitle', { name: pendingDelete ? localizedName(pendingDelete, locale) : '' })}
            </DialogTitle>
            <DialogDescription>{t('deleteDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)} disabled={isDeleting}>
              {t('deleteCancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? <Spinner className="size-3.5" /> : <Trash2 className="size-3.5" aria-hidden />}
              {t('deleteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
