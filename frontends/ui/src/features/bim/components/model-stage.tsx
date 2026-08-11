'use client'

/**
 * The model, full screen, inside the Files page.
 *
 * ## Why there is no model page any more
 *
 * There was one, and it was a data browser with a viewport bolted to the side:
 * five tabs of tables, a 420-pixel-tall picture of the building, and a
 * permanent properties column that was empty until you clicked something. It
 * answered questions nobody had arrived with. A model is a FILE — it is
 * uploaded in Dateien, it lives in Dateien, and the natural way to look at one
 * is to open it there, the way you open a PDF.
 *
 * So: opening a model from the file grid puts the building on screen and
 * nothing else. Every deep link that used to address `/model` still works and
 * still carries the same query string — it just lands here.
 *
 * ## What is on screen, and why so little
 *
 * The canvas is the surface. Four things float on top of it:
 *
 * - a rail on the left with the project's models and this building's levels —
 *   the only two questions a reader has before they have clicked anything;
 * - a dock at the bottom with six controls, because that is what is left after
 *   removing everything that was there to describe the model rather than to
 *   look at it;
 * - a card on the right, only once something is selected;
 * - one button to the analytical surfaces, which are real and occasionally
 *   decisive and belong behind a door rather than in front of one.
 *
 * Every one of those is composed from `./viewer` atoms. Nothing in this file
 * styles a floating panel itself, which is what keeps the chrome coherent —
 * the version this replaces had four of them in three different materials.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  Boxes,
  Check,
  Eye,
  Home,
  Link2,
  MonitorX,
  PanelLeft,
  Scissors,
  SlidersHorizontal,
  Video,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { BimViewerElement } from '../lib/model-index'
import {
  buildModelQuery,
  parseModelView,
  withModelView,
  type BimModelTab,
  type BimModelView,
} from '../lib/model-link'
import {
  formatLevelElevation,
  levelElevation,
  pickStageModel,
  stageLevels,
  stageModelLabel,
} from '../lib/stage-model'
import { BIM_CAMERA_VIEWS, type BimCameraView } from '../lib/viewer-camera'
import {
  useBimElementDetail,
  useBimElements,
  useBimModelSource,
  useProjectBimModels,
} from '../hooks/use-bim-model'
import { useModelViewport } from '../hooks/use-model-viewport'
import { IfcViewerCanvasLazy, ModelViewportProgress } from './ifc-model-viewer'
import { ModelInspector } from './model-inspector'
import { ModelAdvancedSheet } from './model-advanced-sheet'
import {
  ViewerDock,
  ViewerDockSeparator,
  ViewerIconButton,
  ViewerIconButtonBase,
  ViewerLegend,
  ViewerNotice,
  ViewerRail,
  ViewerRailItem,
  ViewerRailSection,
  ViewerSlider,
  ViewerSurface,
} from './viewer'

/** One shared empty array, so "no elements yet" has a stable identity. */
const NO_ELEMENTS: readonly BimViewerElement[] = []

export interface ModelStageProps {
  projectId: string
  /** Closes the stage — the caller drops `?model=` from the URL. */
  onClose: () => void
}

export function ModelStage({ projectId, onClose }: ModelStageProps): JSX.Element {
  const t = useTranslations('bim')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  /**
   * The whole view lives in the URL: which model, which level, which element,
   * which highlights, x-ray on or off, where the cut is. That is what makes a
   * model view a thing you can send someone — an agent answer, a card, a
   * health finding and a colleague's message all arrive as the same kind of
   * link, and they arrive at Dateien now rather than at a page of tables.
   */
  const view = useMemo<BimModelView>(
    () => parseModelView(searchParams?.toString() ?? ''),
    [searchParams]
  )

  const setView = useCallback(
    (patch: Partial<BimModelView>) => {
      const next = withModelView(view, patch)
      // `replace`, not `push`: clicking through twenty elements should not make
      // the back button walk back through twenty of them.
      router.replace(`${pathname}${buildModelQuery(next)}`, { scroll: false })
    },
    [pathname, router, view]
  )

  const { data: models, isLoading, error } = useProjectBimModels(projectId)
  const model = useMemo(() => pickStageModel(models ?? [], view.model), [models, view.model])
  const modelId = model?.status === 'ready' ? model.id : null

  const storey = view.storey ?? null
  const selectedGlobalId = view.element ?? null

  const { data: elements } = useBimElements(modelId)
  // `elements ?? []` inline would mint a new array on every render, changing
  // the canvas's props identity for a value that did not change.
  const elementList = elements ?? NO_ELEMENTS
  const detail = useBimElementDetail(modelId, selectedGlobalId)
  // Only mint the presigned source URL when a viewport can actually use it.
  const sourceUrl = useBimModelSource(modelId, true)

  const levels = useMemo(() => stageLevels(model?.summary), [model?.summary])

  const highlights = useMemo(
    () =>
      (view.highlights ?? []).map((group) => ({
        globalIds: group.globalIds,
        label: t(
          `health.severity.${group.status === 'fail' ? 'error' : group.status === 'warning' ? 'warning' : 'info'}`
        ),
        status: group.status,
      })),
    [view.highlights, t]
  )

  /**
   * Select an element, and make sure the view can actually show it.
   *
   * A level filter isolates one floor; selecting a wall on another one left
   * the URL saying `element=…` while nothing on screen showed it — not in the
   * viewport, which was isolated to the filtered level, and not in any list.
   * The selection existed and was invisible, which reads as a broken link
   * rather than as a filter.
   *
   * So the selection wins: picking an element moves the level filter to the
   * level that element is on. Both travel in the URL together, so the link a
   * reader shares reproduces what the sender was looking at.
   */
  const handleSelect = useCallback(
    (element: BimViewerElement | null) => {
      if (!element) {
        setView({ element: undefined })
        return
      }
      const elementStorey = element.storeyName ?? null
      setView({
        element: element.globalId,
        ...(elementStorey !== null && elementStorey !== storey ? { storey: elementStorey } : {}),
      })
    },
    [setView, storey]
  )

  const viewport = useModelViewport({
    sourceUrl,
    elements: elementList,
    highlights,
    isolatedStorey: storey,
    selectedGlobalId,
    onSelect: handleSelect,
    xray: view.xray ?? false,
    camera: view.camera,
    onCameraChange: (camera) => setView({ camera }),
    compact: false,
  })

  /**
  * Open on a desktop, shut on a phone, and whatever the reader last chose
  * after that.
  *
  * `null` means "not decided yet", which is what lets the default follow the
  * device without overriding a deliberate toggle on the next resize. A rail
  * that is 14 rem wide covers most of a phone, and the first thing someone
  * opening a model on one wants is the model.
  */
  const isMobile = useIsMobile()
  const [railChoice, setRailChoice] = useState<boolean | null>(null)
  const railOpen = railChoice ?? !isMobile
  const [advancedOpen, setAdvancedOpen] = useState(view.tab !== undefined)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const copyLink = useCallback(() => {
    if (typeof window === 'undefined') return
    void navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true))
  }, [])

  const section = viewport.section
  const cutDefault = viewport.defaultCut(levelElevation(model?.summary, storey))

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        // Full screen on a phone, a large floating window on a desktop. The
        // inset is what makes it read as something that OPENED over Dateien
        // rather than as a navigation — you can still see the page it came
        // from at the edges, which is the difference between a popup and a
        // page, and it is why closing does not feel like going back.
        //
        // `sm:max-w-*` MUST be spelled out: DialogContent's base class ends in
        // `sm:max-w-lg` and a bare `max-w-*` loses to it at exactly the
        // breakpoint where it matters.
        className={cn(
          'flex h-[100dvh] max-h-[100dvh] w-full max-w-full flex-col gap-0 overflow-hidden rounded-none border p-0',
          'sm:h-[calc(100dvh-3rem)] sm:max-h-[calc(100dvh-3rem)] sm:w-[calc(100vw-3rem)] sm:max-w-[calc(100vw-3rem)] sm:rounded-3xl'
        )}
        showCloseButton={false}
        // Radix focuses the first focusable child on open, which here would be
        // a rail row — so opening a model to LOOK at it would arm a level
        // filter under a focus ring. Focus the panel instead: Escape still
        // closes and Tab still walks the controls in order.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(event.currentTarget as HTMLElement | null)?.focus()
        }}
        // Escape peels one layer at a time — drawer, then selection, then the
        // stage itself. Without this the outermost dialog wins and one keypress
        // closes the whole model out from under someone who only wanted to
        // dismiss a panel, which is the classic way a layered surface loses
        // people's work.
        onEscapeKeyDown={(event) => {
          if (advancedOpen) {
            event.preventDefault()
            setAdvancedOpen(false)
          } else if (selectedGlobalId) {
            event.preventDefault()
            setView({ element: undefined })
          }
        }}
      >
        <DialogTitle className="sr-only">
          {model ? t('stage.dialogLabel', { name: model.filename }) : t('title')}
        </DialogTitle>

        <div className="bg-muted/40 relative min-h-0 flex-1">
          <StageCanvas
            isLoading={isLoading}
            error={error}
            hasModels={(models?.length ?? 0) > 0}
            model={model}
            viewport={viewport}
          />

          {/* Rail — models and levels. */}
          {railOpen && (
            <div className="absolute top-3 left-3 z-20 flex max-h-[calc(100%-1.5rem)] sm:top-4 sm:left-4">
              <ViewerRail>
                {/*
                  A list of one is not a list. Most projects carry a single
                  model, and a "Modelle" heading over one row is a section that
                  exists to be looked past — the rail is half as tall without
                  it, and the reader loses nothing, because the model's name is
                  already the dialog's title.
                */}
                {(models ?? []).length > 1 && (
                <ViewerRailSection label={t('stage.models')}>
                  {(models ?? []).map((candidate) => (
                    <ViewerRailItem
                      key={candidate.id}
                      label={stageModelLabel(candidate.filename)}
                      icon={<Boxes aria-hidden="true" />}
                      meta={candidate.status === 'ready' ? undefined : t(`status.${candidate.status}`)}
                      selected={candidate.id === model?.id}
                      // A model that is still being read has no geometry to
                      // show. Selecting it would replace the building with a
                      // progress bar and no way back to the one on screen.
                      disabled={candidate.status !== 'ready'}
                      onClick={() =>
                        setView({
                          model: candidate.filename,
                          storey: undefined,
                          element: undefined,
                          highlights: undefined,
                        })
                      }
                    />
                  ))}
                </ViewerRailSection>
                )}

                {levels.length > 0 && (
                  <ViewerRailSection label={t('stage.levels')}>
                    <ViewerRailItem
                      label={t('stage.allLevels')}
                      selected={storey === null}
                      onClick={() => setView({ storey: undefined })}
                    />
                    {levels.map((level) => (
                      <ViewerRailItem
                        key={level.name}
                        label={level.name}
                        meta={
                          level.elevation === null
                            ? undefined
                            : t('stage.elevation', { value: formatLevelElevation(level.elevation) })
                        }
                        // The elevation is context, not identity: it must not
                        // become part of the row's spoken name.
                        ariaLabel={level.name}
                        selected={storey === level.name}
                        onClick={() =>
                          setView({
                            storey: storey === level.name ? undefined : level.name,
                            element: undefined,
                          })
                        }
                      />
                    ))}
                  </ViewerRailSection>
                )}
              </ViewerRail>
            </div>
          )}

          {/*
            The way out, and the way to share what is on screen. Above
            everything — the analytical drawer is z-30 and starts at the same
            corner, so at a lower layer this pill would be buried under it and
            the only way to close the model would be Escape.
          */}
          <div className="absolute top-3 right-3 z-40 sm:top-4 sm:right-4">
            <ViewerSurface className="flex items-center gap-1 p-1">
              <ViewerIconButton
                label={copied ? t('link.copied') : t('link.copy')}
                icon={copied ? Check : Link2}
                onClick={copyLink}
                side="bottom"
              />
              <ViewerIconButton
                label={t('stage.close')}
                icon={X}
                onClick={onClose}
                side="bottom"
                data-testid="stage-close"
              />
            </ViewerSurface>
          </div>

          {/* Selection — and nothing at all until there is one. */}
          {selectedGlobalId && (
            <div
              className={cn(
                'absolute top-3 right-3 z-20 flex max-h-[calc(100%-1.5rem)] pt-12 sm:top-4 sm:right-4',
                // Steps aside for the advanced drawer rather than hiding under
                // it: clicking a wall while the Prüfbuch is open is exactly
                // when you want both.
                advancedOpen && 'sm:right-[28rem]'
              )}
            >
              <ModelInspector
                element={detail.data}
                isLoading={detail.isLoading}
                error={detail.error}
                projectId={projectId}
                modelFilename={model?.filename ?? null}
                onClose={() => setView({ element: undefined })}
              />
            </div>
          )}

          {/* What the colours mean, when something coloured them. */}
          <ViewerLegend
            className="absolute bottom-20 left-3 z-20 sm:bottom-24 sm:left-4"
            entries={viewport.highlights.map((highlight) => ({
              status: highlight.status,
              label: highlight.label,
              count: highlight.expressIds.length,
            }))}
          />

          <ViewerDock
            lead={
              <ViewerIconButton
                label={t('stage.home')}
                icon={Home}
                onClick={viewport.fit}
                disabled={viewport.status.phase !== 'ready'}
              />
            }
            above={
              section &&
              viewport.bounds && (
                <ViewerSlider
                  label={t('viewer.section.height')}
                  min={viewport.bounds.minMetres}
                  max={viewport.bounds.maxMetres}
                  value={section.atMetres}
                  display={t('viewer.section.metres', { value: section.atMetres.toFixed(2) })}
                  onChange={(atMetres) => viewport.setSection({ ...section, atMetres })}
                  action={
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      aria-pressed={section.flipped}
                      onClick={() => viewport.setSection({ ...section, flipped: !section.flipped })}
                    >
                      {t(section.flipped ? 'viewer.section.up' : 'viewer.section.down')}
                    </Button>
                  }
                />
              )
            }
            trail={
              <>
                <ViewerIconButton
                  label={railOpen ? t('stage.rail.hide') : t('stage.rail.show')}
                  icon={PanelLeft}
                  active={railOpen}
                  onClick={() => setRailChoice(!railOpen)}
                />
                <ViewerIconButton
                  label={t('stage.advanced')}
                  icon={SlidersHorizontal}
                  active={advancedOpen}
                  onClick={() => setAdvancedOpen((open) => !open)}
                  disabled={!modelId}
                />
              </>
            }
          >
            <StageViewMenu
              view={viewport.camera.view}
              orthographic={viewport.camera.orthographic}
              onViewChange={viewport.setView}
              onOrthographicChange={viewport.setOrthographic}
              disabled={viewport.status.phase !== 'ready'}
            />
            <ViewerDockSeparator />
            <ViewerIconButton
              label={t('viewer.section.toggle')}
              icon={Scissors}
              active={section !== null}
              disabled={viewport.status.phase !== 'ready'}
              onClick={() =>
                viewport.setSection(section ? null : { atMetres: cutDefault, flipped: false })
              }
            />
            <ViewerIconButton
              label={t('viewer.xray')}
              icon={Eye}
              active={view.xray ?? false}
              disabled={viewport.status.phase !== 'ready'}
              onClick={() => setView({ xray: !(view.xray ?? false) })}
            />
          </ViewerDock>

          {/*
            The analytical surfaces — Prüfbuch, Raumbuch, Mengen, Revisionen.
            Real work, and none of it is what someone opening a model came to
            do, so it lives behind one button and arrives as a drawer over the
            building rather than as five tabs in front of it.
          */}
          {modelId && model && (
            <ModelAdvancedSheet
              open={advancedOpen}
              onClose={() => setAdvancedOpen(false)}
              projectId={projectId}
              model={model}
              models={models ?? []}
              elements={elementList}
              tab={view.tab ?? 'overview'}
              onTabChange={(tab: BimModelTab) => setView({ tab })}
              storey={storey}
              onSelectStorey={(next) => setView({ storey: next ?? undefined, element: undefined })}
              selectedGlobalId={selectedGlobalId}
              onSelectElement={handleSelect}
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
              onOpenModel={(filename) =>
                setView({ model: filename, element: undefined, highlights: undefined })
              }
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The canvas, or the honest sentence that replaces it.
 *
 * Five different situations end without a building on screen, and they are
 * five different facts: the list has not arrived, the list failed, the project
 * has no model, the model is still being read, and this browser cannot render.
 * Collapsing any two of them tells the reader something untrue about their own
 * upload, which is why each gets its own branch and its own words.
 */
function StageCanvas({
  isLoading,
  error,
  hasModels,
  model,
  viewport,
}: {
  isLoading: boolean
  error: string | null
  hasModels: boolean
  model: { status: string; errorMessage: string | null } | null
  viewport: ReturnType<typeof useModelViewport>
}): JSX.Element {
  const t = useTranslations('bim')

  if (isLoading) {
    return <ModelViewportProgress phase="downloading" percent={null} />
  }
  if (error) {
    return (
      <ViewerNotice
        icon={Boxes}
        title={t('loadFailed.title')}
        description={t('loadFailed.description')}
      />
    )
  }
  if (!hasModels || !model) {
    return (
      <ViewerNotice icon={Boxes} title={t('empty.title')} description={t('empty.description')} />
    )
  }
  if (model.status !== 'ready') {
    return (
      <ViewerNotice
        icon={Boxes}
        title={t(`status.${model.status}`)}
        description={model.errorMessage ?? t('stage.notReady')}
      />
    )
  }
  if (!viewport.webGpu) {
    return (
      <ViewerNotice
        icon={MonitorX}
        title={t('viewer.unsupported.title')}
        description={t('viewer.unsupported.description')}
      />
    )
  }
  if (viewport.status.phase === 'error') {
    return (
      <ViewerNotice
        icon={MonitorX}
        title={t('viewer.unavailable.title')}
        description={t('viewer.unavailable.description')}
        detail={
          viewport.status.message
            ? t('viewer.unavailable.reason', { message: viewport.status.message })
            : undefined
        }
      />
    )
  }
  if (!viewport.canvasProps) {
    return <ModelViewportProgress phase="downloading" percent={null} />
  }

  return (
    <>
      <IfcViewerCanvasLazy {...viewport.canvasProps} className="size-full" />
      <ModelViewportProgress phase={viewport.status.phase} percent={viewport.status.percent} />
    </>
  )
}

/**
 * Which way the building is facing.
 *
 * A menu rather than six buttons in the bar. The old toolbar spent six of its
 * nine slots on view names, which put the two controls anyone uses — the cut
 * and the see-through — at the end of a row of words. Folding the directions
 * into one control is what made room for the bar to be readable.
 *
 * The projection toggle lives in here too, at the bottom, because it only ever
 * matters in the sentence "…and draw it parallel so it measures" — which is a
 * thought you have while choosing a view, not on its own.
 */
function StageViewMenu({
  view,
  orthographic,
  onViewChange,
  onOrthographicChange,
  disabled,
}: {
  view: BimCameraView
  orthographic: boolean
  onViewChange: (view: BimCameraView) => void
  onOrthographicChange: (orthographic: boolean) => void
  disabled: boolean
}): JSX.Element {
  const t = useTranslations('bim')

  return (
    <Popover>
      {/*
        The trigger is the BUTTON, not a wrapper around it. A `<span>` in
        between takes Radix's props — including the ones that make Enter open
        the menu — and leaves the focused button inert, which is a control that
        works with a mouse and not with a keyboard.
      */}
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <ViewerIconButtonBase label={t('stage.views')} icon={Video} disabled={disabled} />
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>
          {t('stage.views')}
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="top" sideOffset={10} align="start" className="w-44 p-1.5">
        <div className="grid gap-0.5" role="group" aria-label={t('stage.views')}>
          {BIM_CAMERA_VIEWS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={view === candidate}
              onClick={() => onViewChange(candidate)}
              className={cn(
                'focus-visible:ring-ring/60 flex items-center justify-between rounded-lg px-2 py-1.5 text-left text-[13px] outline-none focus-visible:ring-2',
                view === candidate
                  ? 'bg-accent text-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              )}
            >
              {t(`viewer.view.${candidate}`)}
              {view === candidate && <Check className="size-3.5" aria-hidden="true" />}
            </button>
          ))}
        </div>
        <div className="border-border mt-1.5 border-t pt-1.5">
          <button
            type="button"
            aria-pressed={orthographic}
            onClick={() => onOrthographicChange(!orthographic)}
            className="focus-visible:ring-ring/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[13px] outline-none focus-visible:ring-2"
          >
            {t('viewer.projection.parallel')}
            {orthographic && <Check className="size-3.5" aria-hidden="true" />}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
