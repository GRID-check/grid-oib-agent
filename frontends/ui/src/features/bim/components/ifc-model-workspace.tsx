'use client'

/**
 * The project's Model page: pick a model, see it, filter it, inspect it.
 *
 * Layout is deliberately explorer-left / viewport-right rather than the
 * viewer-first arrangement a 3D tool would choose. The data is what answers
 * questions and it is what is always available; the picture is the fastest way
 * to find the element you then ask about. Selection is bidirectional — clicking
 * a row highlights it in the viewport, clicking geometry selects the row — so
 * neither half is a dead end.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Boxes, Link2, MessageSquarePlus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { supportsWebGpu, type BimViewerElement } from '../lib/model-index'
import {
  buildModelQuery,
  parseModelView,
  withModelView,
  type BimModelTab,
  type BimModelView,
} from '../lib/model-link'
import { elementQuestionHref } from '../lib/element-question'
import { findRevisionSeries, groupModelRevisions } from '../lib/revisions'
import {
  pickDefaultModel,
  useBimElementDetail,
  useBimElements,
  useBimModelSource,
  useBimCompliance,
  useBimComplianceDiff,
  useBimProfileSuggestions,
  useBimRoomSchedule,
  useBimTakeoff,
  useProjectBimModels,
  useProjectRuleFacts,
  type BimModelHeaderView,
} from '../hooks/use-bim-model'
import {
  IfcElementTable,
  IfcModelHealthPanel,
  IfcModelOverview,
  IfcPropertyPanel,
  IfcSpatialTree,
} from './ifc-model-explorer'
import { IfcModelCompare } from './ifc-model-compare'
import { IfcCompliancePanel } from './ifc-compliance-panel'
import { IfcComplianceDiff } from './ifc-compliance-diff'
import {
  IfcProfileSuggestions,
  IfcQuantityTakeoff,
  IfcRoomSchedule,
} from './ifc-model-tables'
import { IfcRevisionTimeline } from './ifc-revision-timeline'
import { IfcModelViewer } from './ifc-model-viewer'

export interface IfcModelWorkspaceProps {
  projectId: string
}

/**
 * Distinguishes two requests for the same comparison.
 *
 * A counter rather than a timestamp so the value is deterministic under test
 * and cannot collide when two clicks land in the same millisecond.
 */
let compareRequests = 0
const compareToken = (): number => (compareRequests += 1)

function StatusBadge({ status }: { status: BimModelHeaderView['status'] }): JSX.Element {
  const t = useTranslations('bim')
  const variant =
    status === 'ready' ? 'success' : status === 'failed' ? 'destructive' : 'info'
  return <Badge variant={variant}>{t(`status.${status}`)}</Badge>
}

export function IfcModelWorkspace({ projectId }: IfcModelWorkspaceProps): JSX.Element {
  const t = useTranslations('bim')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { data: models, isLoading } = useProjectBimModels(projectId)

  /**
   * The whole view lives in the URL: which model, which storey, which element,
   * which highlights, x-ray on or off. That is what makes a model view a thing
   * you can send someone — an agent answer, a card, a health finding and a
   * colleague's message all arrive as the same kind of link.
   */
  const view = useMemo<BimModelView>(() => parseModelView(searchParams?.toString() ?? ''), [searchParams])

  const setView = useCallback(
    (patch: Partial<BimModelView>) => {
      const next = withModelView(view, patch)
      // `replace`, not `push`: clicking through twenty elements should not make
      // the back button walk back through twenty of them.
      router.replace(`${pathname}${buildModelQuery(next)}`, { scroll: false })
    },
    [pathname, router, view]
  )

  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const storey = view.storey ?? null
  const selectedGlobalId = view.element ?? null
  const tab = view.tab ?? 'overview'

  const model = useMemo(() => {
    if (!models) return null
    if (view.model) {
      const needle = view.model.toLowerCase()
      const named =
        models.find((candidate) => candidate.filename.toLowerCase() === needle) ??
        models.find((candidate) => candidate.filename.toLowerCase().includes(needle))
      if (named) return named
    }
    return pickDefaultModel(models)
  }, [models, view.model])

  const modelId = model?.status === 'ready' ? model.id : null
  const { data: elements } = useBimElements(modelId)
  const detail = useBimElementDetail(modelId, selectedGlobalId)

  /**
   * The revision series this model belongs to, read from the file names of the
   * models already loaded — no extra request, and no lineage column anyone
   * would have to maintain.
   */
  const series = useMemo(
    () => findRevisionSeries(groupModelRevisions(models ?? []), model?.id ?? null),
    [models, model?.id]
  )
  const [compareRequest, setCompareRequest] = useState<{
    baseModelId: string
    at: number
  } | null>(null)

  // The heavy tables are fetched only once their tab is open: a Raumbuch over a
  // 200k-element model is a real query, and most visits to this page are to
  // look at the building.
  const [takeoffQuantity, setTakeoffQuantity] = useState<string>('NetSideArea')
  const [takeoffByMaterial, setTakeoffByMaterial] = useState(false)
  const quantitiesOpen = tab === 'quantities'
  const schedule = useBimRoomSchedule(quantitiesOpen ? modelId : null)
  const takeoff = useBimTakeoff(
    quantitiesOpen ? modelId : null,
    takeoffQuantity,
    takeoffByMaterial
  )
  const profile = useBimProfileSuggestions(tab === 'overview' ? modelId : null)

  // The rule catalogue reads the project brief. A fact the brief does not
  // carry arrives as null and the rules that need it stand down, visibly.
  const ruleFacts = useProjectRuleFacts(projectId)
  const compliance = useBimCompliance(projectId, tab === 'compliance' ? modelId : null, ruleFacts)

  // The revision immediately before the one on screen — the only base a
  // "what did this change break" question has a natural answer for.
  const previousRevision = useMemo(() => {
    if (!series || !model) return null
    const index = series.revisions.findIndex((entry) => entry.model.id === model.id)
    return index > 0 ? series.revisions[index - 1].model : null
  }, [series, model])
  const complianceDiff = useBimComplianceDiff(modelId, previousRevision?.id ?? null, ruleFacts)

  /**
   * The BCF download, as a URL rather than a fetch.
   *
   * Carries the same facts the panel ran the catalogue with, so the archive
   * cannot be built against a different Gebäudeklasse than the verdicts the
   * architect just read.
   */
  const bcfHref = useMemo(() => {
    if (!modelId) return null
    const query = new URLSearchParams({ modelId })
    if (ruleFacts.gebaeudeklasse !== null) query.set('gebaeudeklasse', String(ruleFacts.gebaeudeklasse))
    if (ruleFacts.hauptnutzung !== null) query.set('hauptnutzung', ruleFacts.hauptnutzung)
    return `/api/projects/${projectId}/bim/checks/export?${query.toString()}`
  }, [modelId, projectId, ruleFacts.gebaeudeklasse, ruleFacts.hauptnutzung])
  // Only mint the presigned source URL when a viewport can actually use it.
  const webGpu = useMemo(() => supportsWebGpu(), [])
  const sourceUrl = useBimModelSource(modelId, webGpu)

  const handleSelect = useCallback(
    (element: BimViewerElement | null) => setView({ element: element?.globalId }),
    [setView]
  )

  const highlights = useMemo(
    () =>
      (view.highlights ?? []).map((group) => ({
        globalIds: group.globalIds,
        label: t(`health.severity.${group.status === 'fail' ? 'error' : group.status === 'warning' ? 'warning' : 'info'}`),
        status: group.status,
      })),
    [view.highlights, t]
  )

  /**
   * "Apply what the model says to the project brief."
   *
   * Deliberately a question in the chat rather than a write from this page: the
   * facts are inferences from an export, `geschosse_oberirdisch` decides a
   * Gebäudeklasse, and the confirm-the-patch card is where a change to the brief
   * belongs (ADR-0030).
   */
  const profileQuestionHref = useMemo(() => {
    const question = model
      ? `Übernimm die aus dem Modell ${model.filename} ableitbaren Projektangaben in die Projektdaten.`
      : 'Übernimm die aus dem Modell ableitbaren Projektangaben in die Projektdaten.'
    return `/app/projects/${projectId}/chat?${new URLSearchParams({ ask: question }).toString()}`
  }, [model, projectId])

  const copyLink = useCallback(() => {
    if (typeof window === 'undefined') return
    void navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true))
  }, [])

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner />
      </div>
    )
  }

  if (!models || models.length === 0) {
    return (
      <div className="space-y-4 p-6">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
          <Boxes className="size-8 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">{t('empty.title')}</p>
          <p className="max-w-prose text-sm text-muted-foreground">{t('empty.description')}</p>
          <Button asChild size="sm">
            <Link href={`/app/projects/${projectId}/files`}>{t('empty.action')}</Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        action={
          <Button type="button" size="sm" variant="secondary" onClick={copyLink}>
            <Link2 className="size-3.5" aria-hidden="true" />
            {copied ? t('link.copied') : t('link.copy')}
          </Button>
        }
      />

      {models.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {models.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() =>
                setView({
                  model: candidate.filename,
                  storey: undefined,
                  element: undefined,
                  highlights: undefined,
                })
              }
              aria-pressed={candidate.id === model?.id}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
                candidate.id === model?.id ? 'border-primary bg-muted' : 'hover:bg-muted/60'
              }`}
            >
              <span className="truncate">{candidate.filename}</span>
              <StatusBadge status={candidate.status} />
            </button>
          ))}
        </div>
      )}

      {model && model.status !== 'ready' && (
        <p className="rounded-lg border bg-muted/40 p-4 text-sm">
          <StatusBadge status={model.status} />{' '}
          <span className="ml-2">{model.errorMessage ?? t(`status.${model.status}`)}</span>
        </p>
      )}

      {model?.status === 'ready' && model.summary && (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <Tabs
            value={tab}
            onValueChange={(next) => setView({ tab: next as BimModelTab })}
            className="flex min-h-0 flex-col"
          >
            <TabsList>
              <TabsTrigger value="overview">{t('tabs.overview')}</TabsTrigger>
              <TabsTrigger value="compliance">{t('tabs.compliance')}</TabsTrigger>
              <TabsTrigger value="structure">{t('tabs.structure')}</TabsTrigger>
              <TabsTrigger value="quantities">{t('tabs.quantities')}</TabsTrigger>
              <TabsTrigger value="revisions">{t('tabs.revisions')}</TabsTrigger>
            </TabsList>

            <TabsContent
              value="overview"
              className="mt-3 flex min-h-0 flex-col gap-5 overflow-auto pr-1"
            >
              <IfcModelOverview summary={model.summary} filename={model.filename} />
              {model.summary.health && (
                <IfcModelHealthPanel
                  health={model.summary.health}
                  // A finding becomes a VIEW: the offending elements are
                  // highlighted, the first is selected, and the URL now points at
                  // exactly that — so "here is the problem" is a link.
                  onShowElements={(globalIds) =>
                    setView({
                      element: globalIds[0],
                      highlights: [{ status: 'fail', globalIds }],
                      xray: true,
                    })
                  }
                />
              )}
              <IfcProfileSuggestions
                suggestions={profile.data}
                isLoading={profile.isLoading}
                error={profile.error}
                askHref={profileQuestionHref}
              />
            </TabsContent>

            <TabsContent
              value="compliance"
              className="mt-3 flex min-h-0 flex-col gap-5 overflow-auto pr-1"
            >
              <IfcCompliancePanel
                rules={compliance.data?.rules ?? null}
                summary={compliance.data?.summary ?? null}
                shoppingList={compliance.data?.shoppingList ?? null}
                isLoading={compliance.isLoading}
                error={compliance.error}
                projectId={projectId}
                modelFilename={model.filename}
                missingFacts={ruleFacts.missing}
                askHref={profileQuestionHref}
                onConfirm={compliance.confirm}
                onWithdraw={compliance.withdraw}
                bcfHref={bcfHref}
              />
            </TabsContent>

            <TabsContent
              value="structure"
              className="mt-3 flex min-h-0 flex-col gap-5 overflow-auto pr-1"
            >
              <IfcSpatialTree
                summary={model.summary}
                selectedStorey={storey}
                onSelectStorey={(next) => setView({ storey: next ?? undefined, element: undefined })}
              />
              <IfcElementTable
                elements={elements ?? []}
                storeyFilter={storey}
                selectedGlobalId={selectedGlobalId}
                onSelect={handleSelect}
              />
            </TabsContent>

            <TabsContent
              value="quantities"
              className="mt-3 flex min-h-0 flex-col gap-5 overflow-auto pr-1"
            >
              <IfcRoomSchedule
                schedule={schedule.data}
                isLoading={schedule.isLoading}
                error={schedule.error}
                filename={model.filename}
                selectedGlobalId={selectedGlobalId}
                onSelect={(globalId) => setView({ element: globalId })}
              />
              <IfcQuantityTakeoff
                rows={takeoff.data}
                isLoading={takeoff.isLoading}
                error={takeoff.error}
                quantity={takeoffQuantity}
                onQuantityChange={setTakeoffQuantity}
                byMaterial={takeoffByMaterial}
                onByMaterialChange={setTakeoffByMaterial}
              />
            </TabsContent>

            <TabsContent
              value="revisions"
              className="mt-3 flex min-h-0 flex-col gap-5 overflow-auto pr-1"
            >
              <IfcRevisionTimeline
                series={series}
                currentModelId={model.id}
                onOpen={(next) =>
                  setView({ model: next.filename, element: undefined, highlights: undefined })
                }
                // Comparing a step means looking at the newer side of it, so the
                // page switches to that revision and then asks the compare panel
                // to run against its predecessor.
                onCompareWithPrevious={(revision, previous) => {
                  setView({
                    model: revision.model.filename,
                    element: undefined,
                    highlights: undefined,
                    tab: 'revisions',
                  })
                  setCompareRequest({ baseModelId: previous.id, at: compareToken() })
                }}
              />
              <IfcComplianceDiff
                baseModel={previousRevision}
                changes={complianceDiff.data}
                isLoading={complianceDiff.isLoading}
                error={complianceDiff.error}
                onRun={complianceDiff.run}
              />
              <IfcModelCompare
                modelId={model.id}
                candidates={models.filter(
                  (candidate) => candidate.id !== model.id && candidate.status === 'ready'
                )}
                requested={compareRequest}
              />
            </TabsContent>
          </Tabs>

          <div className="flex min-h-0 flex-col gap-4">
            <IfcModelViewer
              sourceUrl={sourceUrl}
              elements={elements ?? []}
              highlights={highlights}
              isolatedStorey={storey}
              selectedGlobalId={selectedGlobalId}
              onSelect={handleSelect}
              xray={view.xray ?? false}
              onXrayChange={(next) => setView({ xray: next })}
              className="h-[420px] min-h-64"
            />
            <section
              aria-labelledby="bim-properties-heading"
              className="min-h-0 flex-1 overflow-auto rounded-lg border p-3"
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 id="bim-properties-heading" className="text-sm font-semibold">
                  {t('properties.title')}
                </h2>
                {/*
                  The element on screen becomes a question, carrying its
                  GlobalId so the assistant queries the same element rather than
                  the one it guesses from a description.
                */}
                {detail.data && (
                  <Button asChild size="sm" variant="secondary">
                    <Link
                      href={elementQuestionHref(
                        projectId,
                        {
                          globalId: detail.data.globalId,
                          ifcType: detail.data.ifcType,
                          name: detail.data.name,
                          storeyName: detail.data.storeyName,
                        },
                        { modelFilename: model.filename }
                      )}
                    >
                      <MessageSquarePlus className="size-3.5" aria-hidden="true" />
                      {t('properties.ask')}
                    </Link>
                  </Button>
                )}
              </div>
              <IfcPropertyPanel
                element={detail.data}
                isLoading={detail.isLoading}
                error={detail.error}
              />
            </section>
          </div>
        </div>
      )}
    </div>
  )
}
