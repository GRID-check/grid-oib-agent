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
 * - a dock at the bottom holding only what someone LOOKS at a building with —
 *   where the camera stands, where it cuts, what to measure, what to take out
 *   of the way, and how to keep the result. Everything that was there to
 *   describe the model rather than to look at it is gone;
 * - a card on the right, only once something is selected;
 * - one button to the analytical surfaces, which are real and occasionally
 *   decisive and belong behind a door rather than in front of one.
 *
 * Every one of those is composed from `./viewer` atoms. Nothing in this file
 * styles a floating panel itself, which is what keeps the chrome coherent —
 * the version this replaces had four of them in three different materials.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  Boxes,
  Camera,
  Check,
  Eye,
  Home,
  Layers,
  Link2,
  MonitorX,
  PanelLeft,
  RotateCcw,
  Ruler,
  Scissors,
  SlidersHorizontal,
  TriangleAlert,
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
import { storeyKey, supportsWebGpu, type BimViewerElement } from '../lib/model-index'
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
  stageModelMatched,
} from '../lib/stage-model'
import { BIM_CAMERA_VIEWS, type BimCameraView } from '../lib/viewer-camera'
import { measurementText } from '../lib/measure-overlay'
import { screenshotFilename } from '../lib/viewer-performance'
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

/**
 * Hide and isolate, bound to whatever is selected right now.
 *
 * Both are omitted rather than disabled when nothing is selected: the card
 * they live on only exists when there IS a selection, so a disabled pair would
 * be a state the reader can never reach — except in the one frame between
 * hiding the selected element and the selection clearing itself, which is
 * exactly when a live button would act on a component that is already gone.
 */
function visibilityActions(
  viewport: ReturnType<typeof useModelViewport>,
  clearSelection: () => void,
  focusViewport: () => void
): { onHide?: () => void; onIsolate?: () => void } {
  const expressId = viewport.selectedExpressId
  if (expressId === null) return {}
  return {
    // Hiding CLEARS the selection. The card is mounted on the URL's
    // `element=`, not on the renderer id, so without this the reader hid a
    // wall and kept a card describing it — the highlight gone, the pivot
    // reset, the Hide button itself silently removed from the card that was
    // still open, and no way back except "show everything".
    onHide: () => {
      viewport.visibility.hide(expressId)
      clearSelection()
      // Hide destroys the card the button lives in. Without this the reader's
      // focus ring is thrown to the top of a full-screen dialog holding
      // fifteen controls, with nothing said about what happened — the control
      // vanishing IS the only feedback, and it takes their place with it.
      focusViewport()
    },
    onIsolate: () => viewport.visibility.isolate([expressId]),
  }
}

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

  const { data: models, isLoading, error, reload: reloadModels } = useProjectBimModels(projectId)
  const model = useMemo(() => pickStageModel(models ?? [], view.model), [models, view.model])
  /**
   * The link named a model this project does not have.
   *
   * `pickStageModel` falls back to the newest ready one, which is the right
   * thing to DO and the wrong thing to do silently: the answer said "3 Wände
   * im Erdgeschoss von Haus-A", the viewer opened Haus-B, the storey filter
   * matched nothing, the legend read "(0)", and the model's name appears
   * nowhere on screen when the project has only one model.
   */
  const openedAnother = models !== null && !stageModelMatched(model, view.model)
  const modelId = model?.status === 'ready' ? model.id : null

  const storey = view.storey ?? null
  const selectedGlobalId = view.element ?? null

  const { data: elements, isLoading: elementsLoading } = useBimElements(modelId)
  // `elements ?? []` inline would mint a new array on every render, changing
  // the canvas's props identity for a value that did not change.
  const elementList = elements ?? NO_ELEMENTS
  const detail = useBimElementDetail(modelId, selectedGlobalId)
  // Only mint the presigned source URL when a viewport can actually use it.
  // `supportsWebGpu()`, not `true`: the comment above has always said the URL
  // is only minted when a viewport can use it, and a browser without WebGPU
  // was still signing an object-storage credential nothing would ever read.
  const source = useBimModelSource(modelId, supportsWebGpu())

  const levels = useMemo(() => stageLevels(model?.summary), [model?.summary])

  // Read inside the download handler, which is deliberately identity-stable so
  // that renaming nothing re-mounts the viewport's capture effect.
  const modelFilenameRef = useRef(model?.filename ?? null)
  modelFilenameRef.current = model?.filename ?? null

  /**
   * A captured view lands in the reader's downloads.
   *
   * Not in the clipboard: a PNG on the clipboard is a thing you can paste into
   * exactly one kind of application, and the reason someone captures a model
   * view is to put it in a Befund, an email or a BCF topic — all of which want
   * a file. A failed capture says so rather than silently doing nothing; the
   * usual cause is a GPU that refused the readback, which is not something the
   * reader can be expected to infer from an inert button.
   */
  const [captureFailed, setCaptureFailed] = useState(false)
  const handleCapture = useCallback(
    (dataUrl: string | null) => {
      if (!dataUrl) {
        setCaptureFailed(true)
        return
      }
      setCaptureFailed(false)
      const link = document.createElement('a')
      link.href = dataUrl
      link.download = screenshotFilename(modelFilenameRef.current, new Date())
      link.click()
    },
    []
  )

  useEffect(() => {
    if (!captureFailed) return
    const timer = setTimeout(() => setCaptureFailed(false), 4000)
    return () => clearTimeout(timer)
  }, [captureFailed])


  /**
   * Where focus goes when a viewer control removes itself.
   *
   * Four controls in this dialog delete themselves on activation — Hide (the
   * card unmounts), the card's close button, "Alles anzeigen" (nothing is
   * hidden any more) and the measurement "Löschen" (the pill goes with the
   * list). Radix's focus scope catches the removal and re-focuses the dialog
   * CONTAINER, which is not a crash but is a lost place: the reader is put at
   * the top of a full-screen surface with fifteen controls and no indication
   * of where they were.
   *
   * The canvas is the answer for all four. It is `tabIndex={0}`, it is what
   * every one of those controls acts ON, and Tab from it reaches the dock —
   * so "back to the building" is both the semantic and the practical landing
   * spot. When the canvas is not mounted (loading, or a failure notice in its
   * place) the dialog panel itself is focusable and is the nearest thing left.
   */
  const stageRef = useRef<HTMLDivElement>(null)
  /** The dock button that owns the drawer — where focus returns when it shuts. */
  const advancedToggleRef = useRef<HTMLButtonElement>(null)
  const focusViewport = useCallback(() => {
    const root = stageRef.current
    if (!root) return
    const canvas = root.querySelector('canvas')
    if (canvas) canvas.focus()
    else root.focus()
  }, [])

  const highlights = useMemo(
    () =>
      (view.highlights ?? []).map((group) => ({
        globalIds: group.globalIds,
        // The answer's own words when the link carried them. The severity
        // word is the fallback, and it used to be the only option — so
        // "Fluchtweg > 40 m (12)" and "Türbreite < 80 cm (4)" both became
        // "Fehler", two identical legend rows with the meaning stripped out.
        label:
          group.label ??
          t(
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
    sourceUrl: source.data,
    elements: elementList,
    highlights,
    isolatedStorey: storey,
    selectedGlobalId,
    onSelect: handleSelect,
    xray: view.xray ?? false,
    camera: view.camera,
    onCameraChange: (camera) => setView({ camera }),
    compact: false,
    onCapture: handleCapture,
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
  /**
   * The drawer is open exactly when the link says which tab.
   *
   * It used to be local state seeded from the URL once, at mount, and never
   * written back — so three things disagreed. Closing the drawer left `tab=`
   * behind, and "Ansicht verlinken" then handed the recipient a drawer the
   * sender had shut. Selecting Überblick DELETED the parameter (it was encoded
   * as "the default"), so the link lost the drawer entirely. And arriving at
   * `?tab=compliance` while the stage was already mounted left it closed.
   *
   * Deriving it makes the drawer behave like every other control in this file:
   * its state is the link, and the link is the state.
   *
   * Gated on `modelId`, because the drawer only renders when there is a model.
   * A compliance card linking into a model that is still being read otherwise
   * produced a pressed AND disabled toolbar button with no panel anywhere —
   * and an Escape that appeared to do nothing, because it took the
   * close-the-drawer branch for a drawer that was not there.
   */
  const linkedOpen = view.tab !== undefined && modelId !== null
  /**
   * An echo, so the drawer opens on the click rather than on the round trip.
   *
   * The URL is the durable record — that is what makes the state shareable and
   * what lets an incoming link, or the back button, open the drawer on the
   * right tab. But `router.replace` re-runs the server tree, so deriving the
   * drawer purely from the URL would leave a couple of hundred milliseconds
   * between pressing the button and anything happening. That is the same
   * mistake the cut slider was making, one event instead of sixty a second,
   * and it is exactly the lag that makes an interface feel cheap.
   *
   * So: local state answers immediately, the URL is written alongside, and
   * the effect re-syncs whenever the link changes under it.
   */
  const [advancedOpen, setAdvancedOpenEcho] = useState(linkedOpen)
  useEffect(() => setAdvancedOpenEcho(linkedOpen), [linkedOpen])
  const setAdvancedOpen = useCallback(
    (open: boolean) => {
      setAdvancedOpenEcho(open)
      setView({ tab: open ? (view.tab ?? 'overview') : undefined })
    },
    [setView, view.tab]
  )
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  /**
   * Copying can fail, and the button next to it already knows that.
   *
   * `navigator.clipboard` is absent in any non-secure context and
   * `writeText` rejects on a denied permission or, in Safari, outside a user
   * gesture chain. The optional chain swallowed the first and the missing
   * `catch` turned the second into an unhandled rejection — the button simply
   * never changed. Its neighbour, the capture button, has an explicit failure
   * state for precisely this reason, so the two disagreed about whether
   * failure is worth mentioning.
   */
  const [copyFailed, setCopyFailed] = useState(false)
  const copyLink = useCallback(() => {
    if (typeof window === 'undefined') return
    const clipboard = navigator.clipboard
    if (!clipboard) {
      setCopyFailed(true)
      return
    }
    clipboard
      .writeText(window.location.href)
      .then(() => {
        setCopyFailed(false)
        setCopied(true)
      })
      .catch(() => setCopyFailed(true))
  }, [])

  useEffect(() => {
    if (!copyFailed) return
    const timer = setTimeout(() => setCopyFailed(false), 4000)
    return () => clearTimeout(timer)
  }, [copyFailed])

  /** Injected into the overlay's readout so it stays a pure function. */
  const measureLabels = useMemo(
    () => ({ horizontal: t('viewer.measure.horizontal'), vertical: t('viewer.measure.vertical') }),
    [t]
  )

  /** Whether the rail has anything in it — see the toggle in the dock. */
  const railHasContent = (models ?? []).length > 1 || levels.length > 0

  /**
   * Highlighted ids the loaded model does not contain.
   *
   * Zero while the element rows are still in flight, which is not a detail:
   * geometry and the row list arrive on separate requests, and an id can only
   * be resolved against the rows. Counting them before they land made EVERY
   * highlight link flash "12 elements from this link are not in this model"
   * for as long as the walk took, and then withdraw it — the reader is told
   * the answer they were sent is wrong, about a model that has every one of
   * those elements. Same mistake `expressIdsForStorey` already fixed for
   * isolation: an empty list is "not yet", not "not there".
   */
  const unresolvedHighlights = elementsLoading
    ? 0
    : viewport.highlights.reduce((sum, group) => sum + group.unresolved.length, 0)

  /**
   * Highlighted elements the LINK could not carry.
   *
   * A card resolves a filter-matched group against the whole model — that is
   * the point of the `match` grammar, so "all 420 external walls light up" —
   * and a URL is capped at 60 ids. The card's legend said 420 and the stage's
   * said 60, with nothing between them to explain the difference.
   */
  const cappedHighlights = (view.highlights ?? []).reduce(
    (sum, group) => sum + Math.max(0, (group.total ?? 0) - group.globalIds.length),
    0
  )

  /**
   * The one sentence that says the view is not quite the view that was sent.
   *
   * Computed here rather than inline in the notice below because it has to be
   * said twice: once on screen, and once into the live region. A reader who
   * follows an agent's link into the WRONG BUILDING is the single thing this
   * block exists to prevent, and until now it was prevented only for people
   * who can see a small pill at the top of a full-screen 3D view.
   */
  const stageWarning = useMemo(() => {
    if (openedAnother) {
      return t('stage.otherModel', { wanted: view.model ?? '', opened: model?.filename ?? '' })
    }
    if (unresolvedHighlights > 0) return t('card.unresolved', { count: unresolvedHighlights })
    if (cappedHighlights > 0) {
      const groups = view.highlights ?? []
      return t('stage.highlightCapped', {
        shown: groups.reduce((sum, group) => sum + group.globalIds.length, 0),
        total: groups.reduce((sum, group) => sum + (group.total ?? group.globalIds.length), 0),
      })
    }
    return null
  }, [openedAnother, unresolvedHighlights, cappedHighlights, view.model, view.highlights, model?.filename, t])

  /**
   * The dimension just taken, and only that one.
   *
   * The readout used to be a `role="status"` that was CREATED already holding
   * its text, which no screen reader announces — so the first measurement was
   * always silent — and that then held every measurement joined together, so
   * the fourth one re-read all four. This node is always mounted and always
   * holds exactly the newest, which is the one thing that just happened.
   */
  const newestMeasurement = viewport.measure.measurements.at(-1)

  /**
   * What the viewport would tell someone who cannot see it.
   *
   * Ordered by urgency, most urgent first: a failure outranks a confirmation,
   * a confirmation outranks progress. Empty while nothing has happened, so
   * the region does not announce on mount.
   */
  const stageAnnouncement = useMemo(() => {
    if (error) return t('loadFailed.title')
    if (source.error) return t('viewer.unavailable.title')
    if (viewport.status.phase === 'error') return t('viewer.unavailable.title')
    if (captureFailed) return t('viewer.capture.failed')
    if (copyFailed) return t('link.failed')
    if (copied) return t('link.copied')
    if (viewport.status.phase === 'parsing') return t('stage.building')
    if (viewport.status.phase === 'downloading') return t('stage.loading')
    // Above "the building is here", because "the building is here, but it is
    // not the one the link named" is the more important half of that sentence.
    if (stageWarning) return stageWarning
    if (viewport.status.phase === 'ready') return t('stage.ready')
    return ''
  }, [
    error,
    source.error,
    viewport.status.phase,
    captureFailed,
    copyFailed,
    copied,
    stageWarning,
    t,
  ])

  /**
   * Nothing to keep solid, so nothing to see through.
   *
   * X-ray ghosts everything that is NOT highlighted or selected; with neither
   * present it would fade the whole building to ten percent and the reader
   * would have turned the model off.
   */
  const xrayNeedsTarget =
    viewport.highlights.length === 0 && viewport.selectedExpressId === null

  const section = viewport.section
  const cutDefault = viewport.defaultCut(levelElevation(model?.summary, storey))

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        ref={stageRef}
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
          // Measuring peels first. The canvas only swallows Escape when a
          // first point is already down, and only while it has focus — from
          // any dock button, the rail or the inspector, Escape fell straight
          // through to the dialog and closed the model. Measurements are
          // deliberately not in the URL, so that discarded every one of them.
          if (viewport.measure.active) {
            event.preventDefault()
            viewport.measure.setActive(false)
          } else if (advancedOpen) {
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
          {/*
            The one thing the viewport says out loud.

            Nothing in this feature was a live region — verified by grep — so
            a forty-second load, its arrival, a renderer that died, a copied
            link and a capture that failed were all silent. A screen-reader
            user could not tell a slow load from a failed one, and the two
            transient confirmations were carried ONLY by a swapped icon and a
            changed button name, neither of which any AT announces.

            One node rather than several, `polite` rather than `assertive`:
            these are reports, not interruptions, and a viewport that
            interrupts on every phase change is worse than one that is quiet.
          */}
          <p className="sr-only" role="status" aria-live="polite">
            {stageAnnouncement}
          </p>
          {/*
            The dimension just taken, on its own channel.
            A measurement is not a status change — it is the RESULT of the
            reader's action, and it must not have to queue behind "Modell
            geladen" or be lost when a copy confirmation overwrites the region
            a moment later. Always mounted and empty until there is one, for
            the same reason as the region above: a live region inserted with
            text already in it is not announced at all.
          */}
          <p className="sr-only" role="status" aria-live="polite">
            {newestMeasurement ? measurementText(newestMeasurement, measureLabels) : ''}
          </p>
          <StageCanvas
            isLoading={isLoading}
            error={error}
            onRetry={reloadModels}
            hasModels={(models?.length ?? 0) > 0}
            model={model}
            source={source}
            viewport={viewport}
          />

          {/* Rail — models and levels. */}
          {railOpen && railHasContent && (
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
                        selected={storeyKey(storey) === storeyKey(level.name)}
                        // The selection stays. `handleSelect` already keeps
                        // the filter and the selected element on the same
                        // level, so nothing here can become invisible — and
                        // "All levels" one row above did not drop it either,
                        // so the list behaved differently row by row.
                        onClick={() =>
                          setView({
                            storey:
                              storeyKey(storey) === storeyKey(level.name) ? undefined : level.name,
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
              {/*
                The name does not change on SUCCESS. It used to, and the live
                region says the same words at the same moment — an accessible
                name changing on the focused element is announced too, so
                "Link kopiert" arrived twice. The check icon is the visual
                confirmation and the region is the spoken one.

                A FAILURE still swaps the name. It is the rarer event and the
                one a reader has to be able to discover on hover, so the
                redundancy is worth what it costs there.
              */}
              <ViewerIconButton
                label={copyFailed ? t('link.failed') : t('link.copy')}
                icon={copyFailed ? MonitorX : copied ? Check : Link2}
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
                onClose={() => {
                  setView({ element: undefined })
                  // Closing the card unmounts the button that closed it.
                  // Back to the building, which is where the selection came
                  // from — see `focusViewport`.
                  focusViewport()
                }}
                {...visibilityActions(viewport, () => setView({ element: undefined }), focusViewport)}
              />
            </div>
          )}

          {/*
            Two things the reader has to know about a link they followed, and
            neither was said anywhere. `unresolved` is documented in
            `model-index.ts` as "not a diagnostic detail — it is shown", and
            it was shown only by the chat card: click through to the full
            screen and the warning disappeared while the legend quietly
            counted fewer elements than the answer named.
          */}
          {stageWarning && (
            <div className="absolute top-16 left-1/2 z-20 -translate-x-1/2 sm:top-20">
              <ViewerSurface className="flex items-start gap-2 px-3 py-2 text-xs">
                <TriangleAlert className="text-warning mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span className="max-w-[28rem]">{stageWarning}</span>
              </ViewerSurface>
            </div>
          )}

          {/* What the colours mean, when something coloured them. */}
          <ViewerLegend
            className="absolute bottom-20 left-3 z-20 sm:bottom-24 sm:left-4"
            // Nothing until the rows land, for the same reason the warning
            // above waits: a count is resolved against the element list, so
            // rendering one early states "Aussenwände (0)" beside an answer
            // that said 420. A legend that arrives a moment late is a legend;
            // one that arrives wrong is a contradiction the reader has to
            // resolve themselves.
            entries={
              elementsLoading
                ? []
                : viewport.highlights.map((highlight) => ({
                    status: highlight.status,
                    label: highlight.label,
                    count: highlight.expressIds.length,
                  }))
            }
          />

          <ViewerDock
            // The drawer is `z-30` and right-anchored full height; the dock is
            // `z-20` and centred. On a 1024 px viewport the drawer sat on top
            // of x-ray, the rail toggle and the button that OPENED it — press
            // the visibly-pressed button again and nothing happened, because
            // the drawer was intercepting the click. On a phone it covered
            // every viewer control. The inspector was taught to step aside;
            // the dock never was.
            className={cn(advancedOpen && 'sm:pr-[27rem]')}
            lead={
              <ViewerIconButton
                label={t('stage.home')}
                icon={Home}
                onClick={viewport.fit}
                disabled={viewport.status.phase !== 'ready'}
              />
            }
            above={
              <>
                {/*
                  What to click next, and a way out of the measurements once
                  they have been read. A measure tool with no running commentary
                  is a crosshair the reader has to experiment with — and one
                  with no way to clear leaves the building covered in someone
                  else's arithmetic.
                */}
                {/*
                  Rendered while the tool is on OR while anything is measured.
                  Turning the tool off keeps the measurements on screen by
                  design — and used to take away the only control that could
                  clear them, leaving the building covered in someone else's
                  arithmetic with no way out.
                */}
                {(viewport.measure.active || viewport.measure.measurements.length > 0) && (
                  <ViewerSurface className="pointer-events-auto flex items-center gap-2 px-3 py-1.5">
                    {viewport.measure.active && (
                      <span className="text-muted-foreground text-xs">
                        {t(
                          viewport.measure.pending
                            ? 'viewer.measure.second'
                            : 'viewer.measure.first'
                        )}
                      </span>
                    )}
                    {viewport.measure.measurements.length > 0 && (
                      <>
                        {/*
                          The numbers themselves, for a reader who cannot see
                          the drawing over the model. The overlay is marked
                          decorative precisely because this exists: without it
                          every dimension the tool produced was available
                          nowhere but as pixels.
                        */}
                        {/*
                          Not a live region — the one at the top of the dialog
                          announces the newest measurement. This is the full
                          list, browsable, for a reader going back over what
                          they took. It used to be the `role="status"`, which
                          made it announce every dimension again each time a
                          new one was added, and never announce the first.
                        */}
                        <span className="sr-only">
                          {viewport.measure.measurements
                            .map((measurement) => measurementText(measurement, measureLabels))
                            .join('; ')}
                        </span>
                        <span className="text-muted-foreground text-xs tabular-nums">
                          {viewport.measure.measurements.length === 1
                            ? t('viewer.measure.countOne')
                            : t('viewer.measure.count', {
                                count: viewport.measure.measurements.length,
                              })}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => {
                            viewport.measure.clear()
                            // The pill this button sits in goes with the list
                            // when the tool is already off.
                            focusViewport()
                          }}
                        >
                          {t('viewer.measure.clear')}
                        </Button>
                      </>
                    )}
                  </ViewerSurface>
                )}
                {section && viewport.bounds && (
                <ViewerSlider
                  label={t('viewer.section.height')}
                  min={viewport.bounds.minMetres}
                  max={viewport.bounds.maxMetres}
                  value={section.atMetres}
                  display={t('viewer.section.metres', { value: section.atMetres.toFixed(2) })}
                  // Per step: move the plane, now. Per gesture: write the
                  // link. Both were the second one, which is why the slider
                  // could not be dragged at all — see `viewer-slider.tsx`.
                  onChange={viewport.previewCut}
                  onCommit={(atMetres) => viewport.setSection({ ...section, atMetres })}
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
                )}
              </>
            }
            trail={
              <>
                {/*
                  The way back. It appears only once something is out of the
                  way, because a viewport nobody has edited has nothing to
                  restore — and a permanently-visible "show everything" is a
                  control that is wrong about the state it describes most of
                  the time.
                */}
                {viewport.visibility.edited && (
                  <ViewerIconButton
                    label={t('stage.showEverything')}
                    icon={Layers}
                    onClick={() => {
                      viewport.visibility.showEverything()
                      // This button exists only while something is hidden, so
                      // pressing it deletes it. Its disappearance is also the
                      // only confirmation that anything happened — losing the
                      // reader's place on top of that leaves them with no
                      // signal at all.
                      focusViewport()
                    }}
                  />
                )}
                {/*
                  The rail holds the model list and the level list, and both
                  can be absent — one model, and an export whose storeys have
                  no names. It then rendered as a 13 rem empty blurred pill
                  over the building, with a dock toggle reporting `active` for
                  it. A toggle for nothing is not a toggle.
                */}
                <ViewerIconButton
                  label={railOpen ? t('stage.rail.hide') : t('stage.rail.show')}
                  icon={PanelLeft}
                  active={railOpen && railHasContent}
                  disabled={!railHasContent}
                  onClick={() => setRailChoice(!railOpen)}
                />
                <ViewerIconButton
                  ref={advancedToggleRef}
                  label={t('stage.advanced')}
                  icon={SlidersHorizontal}
                  active={advancedOpen}
                  onClick={() => setAdvancedOpen(!advancedOpen)}
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
              label={captureFailed ? t('viewer.capture.failed') : t('viewer.capture.action')}
              icon={captureFailed ? MonitorX : Camera}
              disabled={viewport.status.phase !== 'ready'}
              onClick={viewport.capture}
            />
            <ViewerIconButton
              label={t('viewer.measure.toggle')}
              icon={Ruler}
              active={viewport.measure.active}
              disabled={viewport.status.phase !== 'ready'}
              onClick={() => viewport.measure.setActive(!viewport.measure.active)}
            />
            {/*
              See-through ghosts everything that is NOT highlighted or
              selected, so with neither there is nothing to keep solid and the
              renderer is correctly told to ghost nothing. Pressing it wrote
              `xray=1`, filled the button and set `aria-pressed` — and the
              building did not change. A control that cannot act must not
              offer to; this is the second time this particular button has
              been pressed-and-inert, for a different reason each time.
            */}
            <ViewerIconButton
              // The name says WHY when it cannot act. A disabled control gets
              // no tooltip — Radix's trigger never fires on a disabled button
              // — so the reason documented in the comment above reached
              // nobody: the reader was left with an inert eye and no way to
              // discover that selecting a wall would turn it on.
              label={xrayNeedsTarget ? t('viewer.xrayNeedsTarget') : t('viewer.xray')}
              icon={Eye}
              active={view.xray ?? false}
              disabled={viewport.status.phase !== 'ready' || xrayNeedsTarget}
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
              onClose={() => {
                setAdvancedOpen(false)
                // Back to the button that opened it. The drawer's X unmounts
                // itself, so without this closing a panel put the reader at
                // the top of the dialog instead of back on the toolbar.
                advancedToggleRef.current?.focus()
              }}
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

/** The one way forward every viewer failure now offers. */
function StageRetry({ onClick }: { onClick: () => void }): JSX.Element {
  const t = useTranslations('bim')
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <RotateCcw className="size-3.5" aria-hidden="true" />
      {t('loadFailed.action')}
    </Button>
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
  onRetry,
  hasModels,
  model,
  source,
  viewport,
}: {
  isLoading: boolean
  error: string | null
  onRetry: () => void
  hasModels: boolean
  model: { status: string; errorMessage: string | null } | null
  source: { data: string | null; error: string | null; reload: () => void }
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
        // Every error state in this viewer used to be terminal: the notices
        // took no action, `reload` on the hook had no caller, and the string
        // for this button had sat unused in both dictionaries since it was
        // written. Closing and reopening the stage was the only escape, and
        // nothing on screen suggested it.
        action={<StageRetry onClick={onRetry} />}
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
        // Re-signing mints a NEW url, and a new url is what resets the stored
        // status and remounts the canvas — the recovery path existed and had
        // nothing to trigger it. A device loss (a driver reset, a laptop
        // waking) is the common way to land here, and it is entirely
        // recoverable.
        action={<StageRetry onClick={source.reload} />}
      />
    )
  }
  // A presigned URL that could not be minted — an expired session, a
  // withdrawn feature flag, a dropped connection. Its own branch, because the
  // fallthrough below renders an indeterminate progress bar, and a progress
  // bar that will never finish is the least honest thing this surface can do.
  if (source.error) {
    return (
      <ViewerNotice
        icon={MonitorX}
        title={t('viewer.unavailable.title')}
        description={t('viewer.unavailable.description')}
        action={<StageRetry onClick={source.reload} />}
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
  /**
   * Controlled so choosing a view CLOSES the menu.
   *
   * It did not, so picking "Grundriss" left an 11 rem popover sitting over the
   * lower-left of the building the reader had just re-oriented to look at —
   * and the one thing they wanted to see was behind it.
   */
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/*
        The trigger is the BUTTON, not a wrapper around it. A `<span>` in
        between takes Radix's props — including the ones that make Enter open
        the menu — and leaves the focused button inert, which is a control that
        works with a mouse and not with a keyboard.
      */}
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            {/*
              The name of the active view, on the trigger. Section, Measure and
              See-through all light up when they are on; this one looked
              identical whether the reader was on the north elevation in
              parallel projection or in the free perspective default, so the
              only way to find out was to open the menu and read it. The
              `adornment` prop exists for exactly this and had no caller.
            */}
            <ViewerIconButtonBase
              label={t('stage.views')}
              icon={Video}
              disabled={disabled}
              active={view !== 'iso'}
              adornment={
                view === 'iso' ? undefined : (
                  <span className="text-[11px] font-medium">{t(`viewer.view.${view}`)}</span>
                )
              }
            />
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
              onClick={() => {
                onViewChange(candidate)
                setOpen(false)
              }}
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
