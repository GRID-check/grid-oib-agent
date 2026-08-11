'use client'

/**
 * Everything the model page used to be, behind one button.
 *
 * ## Why it still exists
 *
 * The Prüfbuch runs the OIB rule catalogue over the building and exports BCF;
 * the Raumbuch is a room schedule an architect would otherwise assemble by
 * hand; the revision timeline answers "what did this change break". None of
 * that is decoration and deleting it would be deleting the product.
 *
 * ## Why it is not the front door
 *
 * Because none of it is what someone opening a model came to do. They came to
 * look at a building. Five tabs of tables occupying half the screen before a
 * single click is what made the old page read as a debugging console — the
 * work was there, it was just standing in front of the thing it was about.
 *
 * ## Why a drawer and not a modal
 *
 * A modal over a modal would hide the building, and the building is what every
 * one of these panels is talking about. As a drawer INSIDE the stage, a health
 * finding highlights walls the reader can see while they read the finding, and
 * a room in the Raumbuch selects itself in the viewport beside it. That
 * two-way link is the whole reason to keep these panels in the viewer rather
 * than on a page of their own.
 */

import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { BimViewerElement } from '../lib/model-index'
import type { BimModelTab } from '../lib/model-link'
import { findRevisionSeries, groupModelRevisions } from '../lib/revisions'
import {
  useBimCompliance,
  useBimComplianceDiff,
  useBimProfileSuggestions,
  useBimRoomSchedule,
  useBimTakeoff,
  useProjectRuleFacts,
  type BimModelHeaderView,
} from '../hooks/use-bim-model'
import { ViewerSurface } from './viewer'
import {
  IfcElementTable,
  IfcModelHealthPanel,
  IfcModelOverview,
  IfcSpatialTree,
} from './ifc-model-explorer'
import { IfcCompliancePanel } from './ifc-compliance-panel'
import { IfcComplianceDiff } from './ifc-compliance-diff'
import { IfcModelCompare } from './ifc-model-compare'
import { IfcProfileSuggestions, IfcQuantityTakeoff, IfcRoomSchedule } from './ifc-model-tables'
import { IfcRevisionTimeline } from './ifc-revision-timeline'

/**
 * Distinguishes two requests for the same comparison.
 *
 * A counter rather than a timestamp so the value is deterministic under test
 * and cannot collide when two clicks land in the same millisecond.
 */
let compareRequests = 0
const compareToken = (): number => (compareRequests += 1)

export interface ModelAdvancedSheetProps {
  open: boolean
  onClose: () => void
  projectId: string
  model: BimModelHeaderView
  models: readonly BimModelHeaderView[]
  elements: readonly BimViewerElement[]
  tab: BimModelTab
  onTabChange: (tab: BimModelTab) => void
  storey: string | null
  onSelectStorey: (storey: string | null) => void
  selectedGlobalId: string | null
  onSelectElement: (element: BimViewerElement | null) => void
  /** Turn a finding into a VIEW: highlight the offending elements and x-ray. */
  onShowElements: (globalIds: string[]) => void
  onOpenModel: (filename: string) => void
}

export function ModelAdvancedSheet({
  open,
  onClose,
  projectId,
  model,
  models,
  elements,
  tab,
  onTabChange,
  storey,
  onSelectStorey,
  selectedGlobalId,
  onSelectElement,
  onShowElements,
  onOpenModel,
}: ModelAdvancedSheetProps): JSX.Element | null {
  const t = useTranslations('bim')
  const modelId = model.status === 'ready' ? model.id : null

  // Each heavy table is fetched only once its tab is open: a Raumbuch over a
  // 200k-element model is a real query, and almost nobody opens this drawer.
  const [takeoffQuantity, setTakeoffQuantity] = useState<string>('NetSideArea')
  const [takeoffByMaterial, setTakeoffByMaterial] = useState(false)
  /**
   * A tab that has BEEN opened keeps its data.
   *
   * The gate used to be "is this tab open right now", so leaving Mengen and
   * coming back re-ran the room schedule and the take-off — two full element
   * reads — for data the browser had held a second earlier. The comment on
   * these calls says they are "fetched only once its tab is open"; with the
   * gate on the live tab, "once" meant once per visit.
   *
   * Sticky rather than eager: nothing is fetched for a tab nobody opens, which
   * is the whole point of gating, and nothing is re-fetched for one they
   * return to.
   */
  const [visited, setVisited] = useState<ReadonlySet<BimModelTab>>(() => new Set())
  useEffect(() => {
    if (!open) return
    setVisited((seen) => (seen.has(tab) ? seen : new Set(seen).add(tab)))
  }, [open, tab])
  const opened = (candidate: BimModelTab): boolean => open && visited.has(candidate)

  const quantitiesOpen = opened('quantities')
  const schedule = useBimRoomSchedule(quantitiesOpen ? modelId : null)
  const takeoff = useBimTakeoff(
    quantitiesOpen ? modelId : null,
    takeoffQuantity,
    takeoffByMaterial
  )
  const profile = useBimProfileSuggestions(opened('overview') ? modelId : null)

  // The rule catalogue reads the project brief. A fact the brief does not
  // carry arrives as null and the rules that need it stand down, visibly.
  const ruleFacts = useProjectRuleFacts(projectId)
  const compliance = useBimCompliance(
    projectId,
    opened('compliance') ? modelId : null,
    ruleFacts
  )

  /**
   * The revision series this model belongs to, read from the file names of the
   * models already loaded — no extra request, and no lineage column anyone
   * would have to maintain.
   */
  const series = useMemo(
    () => findRevisionSeries(groupModelRevisions([...models]), model.id),
    [models, model.id]
  )

  // The revision immediately before the one on screen — the only base a
  // "what did this change break" question has a natural answer for.
  const previousRevision = useMemo(() => {
    if (!series) return null
    const index = series.revisions.findIndex((entry) => entry.model.id === model.id)
    return index > 0 ? series.revisions[index - 1].model : null
  }, [series, model.id])
  const complianceDiff = useBimComplianceDiff(modelId, previousRevision?.id ?? null, ruleFacts)

  const [compareRequest, setCompareRequest] = useState<{ baseModelId: string; at: number } | null>(
    null
  )

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
    if (ruleFacts.gebaeudeklasse !== null) {
      query.set('gebaeudeklasse', String(ruleFacts.gebaeudeklasse))
    }
    if (ruleFacts.hauptnutzung !== null) query.set('hauptnutzung', ruleFacts.hauptnutzung)
    return `/api/projects/${projectId}/bim/checks/export?${query.toString()}`
  }, [modelId, projectId, ruleFacts.gebaeudeklasse, ruleFacts.hauptnutzung])

  /**
   * "Apply what the model says to the project brief."
   *
   * Deliberately a question in the chat rather than a write from this panel:
   * the facts are inferences from an export, `geschosse_oberirdisch` decides a
   * Gebäudeklasse, and the confirm-the-patch card is where a change to the
   * brief belongs (ADR-0030).
   */
  const profileQuestionHref = useMemo(() => {
    const question = `Übernimm die aus dem Modell ${model.filename} ableitbaren Projektangaben in die Projektdaten.`
    return `/app/projects/${projectId}/chat?${new URLSearchParams({ ask: question }).toString()}`
  }, [model.filename, projectId])

  if (!open) return null

  return (
    <ViewerSurface
      role="complementary"
      aria-label={t('stage.advanced')}
      className={cn(
        // Starts BELOW the close pill rather than at the corner: covering the
        // way out of the stage would leave Escape as the only exit.
        'absolute top-16 right-3 bottom-3 z-30 flex w-[min(26rem,calc(100%-1.5rem))] flex-col overflow-hidden sm:top-[4.5rem] sm:right-4 sm:bottom-4',
        'animate-in fade-in-0 slide-in-from-right-4 duration-200 motion-reduce:animate-none'
      )}
    >
      <div className="border-border flex items-center justify-between gap-2 border-b p-3">
        <h2 className="text-sm font-semibold">{t('stage.advanced')}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="-mr-1 size-7 rounded-lg"
          onClick={onClose}
          aria-label={t('stage.selection.close')}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {/*
        `forceMount` with a `hidden` inactive state, rather than Radix's
        default unmount.

        An inactive tab used to be destroyed, and every panel here holds state
        worth more than the render it costs: the comparison result — which read
        two full element sets at `limit: 20_000` — the element table's search
        text and type filter, the Raumbuch's expansion, and every panel's
        scroll offset. Leaving Revisionen and coming back silently discarded
        all of it and reset the base model to the first candidate.

        It also refired the gated queries. The comment on those says they are
        "fetched only once its tab is open"; with an unmounting tab, "once"
        meant once per visit.
      */}
      <Tabs
        value={tab}
        onValueChange={(next) => onTabChange(next as BimModelTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="mx-3 mt-2 shrink-0 justify-start overflow-x-auto">
          <TabsTrigger value="overview">{t('tabs.overview')}</TabsTrigger>
          <TabsTrigger value="compliance">{t('tabs.compliance')}</TabsTrigger>
          <TabsTrigger value="structure">{t('tabs.structure')}</TabsTrigger>
          <TabsTrigger value="quantities">{t('tabs.quantities')}</TabsTrigger>
          <TabsTrigger value="revisions">{t('tabs.revisions')}</TabsTrigger>
        </TabsList>

        <TabsContent
          value="overview"
          forceMount
          className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3 data-[state=inactive]:hidden"
        >
          {model.summary && <IfcModelOverview summary={model.summary} filename={model.filename} />}
          {model.summary?.health && (
            <IfcModelHealthPanel health={model.summary.health} onShowElements={onShowElements} />
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
          forceMount
          className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3 data-[state=inactive]:hidden"
        >
          <IfcCompliancePanel
            rules={compliance.data?.rules ?? null}
            summary={compliance.data?.summary ?? null}
            shoppingList={compliance.data?.shoppingList ?? null}
            isLoading={compliance.isLoading}
            error={compliance.error}
            truncated={compliance.data?.truncated ?? false}
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
          forceMount
          className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3 data-[state=inactive]:hidden"
        >
          {model.summary && (
            <IfcSpatialTree
              summary={model.summary}
              selectedStorey={storey}
              onSelectStorey={onSelectStorey}
            />
          )}
          <IfcElementTable
            elements={elements}
            storeyFilter={storey}
            selectedGlobalId={selectedGlobalId}
            onSelect={onSelectElement}
          />
        </TabsContent>

        <TabsContent
          value="quantities"
          forceMount
          className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3 data-[state=inactive]:hidden"
        >
          <IfcRoomSchedule
            schedule={schedule.data?.schedule ?? null}
            truncated={schedule.data?.truncated ?? false}
            isLoading={schedule.isLoading}
            error={schedule.error}
            filename={model.filename}
            selectedGlobalId={selectedGlobalId}
            onSelect={(globalId) =>
              onSelectElement(elements.find((e) => e.globalId === globalId) ?? null)
            }
          />
          <IfcQuantityTakeoff
            rows={takeoff.data?.rows ?? null}
            truncated={takeoff.data?.truncated ?? false}
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
          forceMount
          className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3 data-[state=inactive]:hidden"
        >
          <IfcRevisionTimeline
            series={series}
            currentModelId={model.id}
            onOpen={(next) => onOpenModel(next.filename)}
            // Comparing a step means looking at the newer side of it, so the
            // stage switches to that revision and then asks the compare panel
            // to run against its predecessor.
            onCompareWithPrevious={(revision, previous) => {
              onOpenModel(revision.model.filename)
              setCompareRequest({ baseModelId: previous.id, at: compareToken() })
            }}
          />
          <IfcComplianceDiff
            baseModel={previousRevision}
            changes={complianceDiff.data?.changes ?? null}
            truncated={complianceDiff.data?.truncated ?? false}
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
    </ViewerSurface>
  )
}
