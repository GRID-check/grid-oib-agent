'use client'

/**
 * The product tours: short, skippable walks for someone new — the org scope
 * right after they create their organization (`welcome`), and the inside of a
 * project right after they set up their first one (`project`). Which stops each
 * has, and why, is in `../lib/product-tour.ts`.
 *
 * Positioning, the spotlight and the overlay are bought, not built: NextStep
 * (`nextstepjs`, the maintained fork of Onborda) animates with the `motion`
 * package this app already ships and takes a custom card, so the tour is drawn
 * with our own {@link TourCard} instead of a restyled library default. What
 * this file owns is the product half: copy, when a tour starts, and what it
 * reports.
 *
 * WHEN IT RUNS. Three ways in, one start:
 *
 * - HAND-OVER: onboarding lands on `?tour=welcome`, the intake wizard's first
 *   save on `?tour=project` — the creator's road.
 * - FIRST VISIT: the server marks a tour `eligible` for someone new here who
 *   has not seen it — the joiner's road, since an invitation or a project role
 *   assignment passes through no URL of ours. Never on the intake wizard
 *   ({@link isSetupPage}).
 * - REPLAY: the account menu starts whichever tour belongs to the page it is
 *   opened on ({@link useStartProductTour}).
 *
 * Every start records the tour as seen in the reader's preferences, so a tour
 * starts by itself at most once per person.
 *
 * LAYOUT. NextStep wraps its children in two block `div`s. The shell is
 * `h-dvh` with its own scroll container, so wrapping it whole is harmless; the
 * one thing that must not happen is mounting NextStep as a flex SIBLING of the
 * chrome, where its `width: 100%` wrapper would take a share of the row.
 */

import * as React from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { NextStep, NextStepProvider, useNextStep, type CardComponentProps } from 'nextstepjs'
import { useReducedMotion } from 'motion/react'

import { motionDeliberate, motionInstant } from '@/components/motion'
import { TourCard } from '@/components/ui/tour-card'
import { ShortcutKeys } from '@/components/shell/shortcut-keys'
import { MOD } from '@/components/shell/shortcuts'
import { useTranslations } from '@/i18n'
import { capturePosthog } from '@/lib/analytics/posthog'
import { patchUserPreferences } from '@/lib/user-preferences/client'
import {
  ARRIVAL_ANCHOR,
  NO_TOURS,
  TOURS,
  TOUR_HOME,
  TOUR_SEEN_KEYS,
  isSetupPage,
  placeStops,
  requestedTour,
  tourAnchorSelector,
  tourForPath,
  withoutTourRequest,
  type AnchorBox,
  type PlacedTourStop,
  type TourEligibility,
  type TourFlags,
  type TourId,
} from '../lib/product-tour'
import type { JSX } from 'react'

/** How long arrival waits for the page to render the tour's first anchor. */
const ARRIVAL_TIMEOUT_MS = 5000
const ARRIVAL_POLL_MS = 100
/** A beat for the page to settle before a tour that waits for nothing. */
const ARRIVAL_SETTLE_MS = 400

const StartTourContext = React.createContext<(() => void) | null>(null)

export interface ProductTourProps extends TourFlags {
  children: React.ReactNode
  /** Which tours start by themselves for this reader (server-decided). */
  eligible?: TourEligibility
  /**
   * Which tour belongs on a pathname. The product derives it from the route
   * (`tourForPath`); the `/dev/product-tour` preview pins one so the real tour
   * can run against fixtures on a `/dev` path.
   */
  tourAt?: (pathname: string) => TourId | null
}

export function ProductTour({ children, ...options }: ProductTourProps): JSX.Element {
  return (
    <NextStepProvider>
      <ProductTourRunner {...options}>{children}</ProductTourRunner>
    </NextStepProvider>
  )
}

/**
 * Starts the tour that belongs to the current page, in place; from a page with
 * no tour, goes to the projects home and starts the welcome tour there. A
 * no-op outside {@link ProductTour}, so a menu rendered in a dev preview
 * without the shell does not crash.
 */
export function useStartProductTour(): () => void {
  return React.useContext(StartTourContext) ?? noop
}

function noop(): void {}

function ProductTourRunner({
  children,
  canAccessArchiv,
  canAccessInbox,
  canManageOrganization,
  eligible = NO_TOURS,
  tourAt = tourForPath,
}: ProductTourProps): JSX.Element {
  const pathname = usePathname() ?? ''
  const router = useRouter()
  const reduceMotion = useReducedMotion()
  const { startNextStep } = useNextStep()
  const t = useTranslations('onboarding.tour')
  const [active, setActive] = React.useState<{ tour: TourId; stops: PlacedTourStop[] } | null>(null)
  // Tours started in this tab. `eligible` came from the server when the frame
  // was first rendered, and the frame does not re-render on navigation, so it
  // goes stale the moment a tour starts; this is what keeps a first-visit
  // tour from starting again on the next page of the same scope.
  const startedRef = React.useRef(new Set<TourId>())
  // A replay asked for on a page with no tour of its own: carried across the
  // navigation to the projects home in a ref, because the frame stays mounted.
  // Not as `?tour=welcome` — that is the creator's hand-over URL, and it would
  // greet a joiner who replays with "your organization is ready".
  const pendingReplayRef = React.useRef<TourId | null>(null)
  const here = tourAt(pathname)

  // Both state updates land in one render, so NextStep sees the new steps on
  // the same pass that opens the tour.
  const startHere = React.useCallback(
    (tour: TourId, handover: boolean) => {
      const reader = { canAccessArchiv, canAccessInbox, canManageOrganization, handover }
      const stops = placeStops(TOURS[tour], reader, locateAnchor, {
        width: window.innerWidth,
        height: window.innerHeight,
      })
      setActive({ tour, stops })
      startNextStep(tour)
      if (!startedRef.current.has(tour)) {
        startedRef.current.add(tour)
        void patchUserPreferences({ [TOUR_SEEN_KEYS[tour]]: new Date().toISOString() })
      }
    },
    [canAccessArchiv, canAccessInbox, canManageOrganization, startNextStep],
  )

  const start = React.useCallback(() => {
    if (here) {
      startHere(here, false)
      return
    }
    pendingReplayRef.current = 'welcome'
    router.push(TOUR_HOME)
  }, [here, router, startHere])

  // Hand-over via `?tour=`, or a first visit the server marked eligible. Drop
  // the parameter so a reload does not replay the tour, then wait for the page
  // to render what the tour points at first.
  const autoStart = here !== null && eligible[here] && !isSetupPage(pathname)
  React.useEffect(() => {
    const replay = pendingReplayRef.current
    if (replay && replay === here) {
      pendingReplayRef.current = null
      return waitForArrival(replay, () => startHere(replay, false))
    }
    const requested = requestedTour(window.location.search)
    const handover = requested !== null && requested === here
    if (requested) router.replace(withoutTourRequest(pathname, window.location.search), { scroll: false })
    const tour = handover ? requested : autoStart ? here : null
    if (!tour || (!handover && startedRef.current.has(tour))) return
    return waitForArrival(tour, () => startHere(tour, handover))
  }, [autoStart, here, pathname, router, startHere])

  const tours = React.useMemo(
    () =>
      active
        ? [
            {
              tour: active.tour,
              steps: active.stops.map((stop) => ({
                title: t(`stops.${stop.id}.title`),
                content: <StopBody stop={stop} />,
                selector: stop.side && stop.anchor ? tourAnchorSelector(stop.anchor) : undefined,
                side: stop.side,
                pointerPadding: 12,
                pointerRadius: 12,
              })),
            },
          ]
        : [],
    [active, t],
  )

  const stopCount = active?.stops.length ?? 0

  return (
    <StartTourContext.Provider value={start}>
      <NextStep
        steps={tours}
        cardComponent={ProductTourCard}
        displayArrow={false}
        shadowRgb="0, 0, 0"
        shadowOpacity="0.32"
        cardTransition={reduceMotion ? motionInstant : motionDeliberate}
        // The document never scrolls — the shell's `<main>` does — so the
        // library's end-of-tour `window.scrollTo` would be a no-op at best.
        scrollToTop={false}
        disableConsoleLogs
        onComplete={(tour) => capturePosthog('product_tour_completed', { tour, stops: stopCount })}
        onSkip={(step, tour) =>
          capturePosthog('product_tour_skipped', {
            tour,
            step,
            stop: active?.stops[step]?.id,
            stops: stopCount,
          })
        }
      >
        {children}
      </NextStep>
    </StartTourContext.Provider>
  )
}

/**
 * Run `start` once the page has rendered what the tour points at first — or
 * after a short settle for a tour whose anchors are already standing, or after
 * a timeout, so a slow page delays the tour rather than losing it. Returns the
 * cleanup for the effect that called it.
 */
function waitForArrival(tour: TourId, start: () => void): () => void {
  const anchor = ARRIVAL_ANCHOR[tour]
  const startedAt = Date.now()
  const timer = window.setInterval(() => {
    const elapsed = Date.now() - startedAt
    const ready = anchor ? locateAnchor(tourAnchorSelector(anchor)) !== null : elapsed >= ARRIVAL_SETTLE_MS
    if (!ready && elapsed < ARRIVAL_TIMEOUT_MS) return
    window.clearInterval(timer)
    start()
  }, ARRIVAL_POLL_MS)
  return () => window.clearInterval(timer)
}

/** An anchor's box, or null when it is absent or not laid out (a closed drawer). */
function locateAnchor(selector: string): AnchorBox | null {
  const element = document.querySelector(selector)
  if (!element) return null
  const { left, right, top, bottom } = element.getBoundingClientRect()
  return right > left && bottom > top ? { left, right, top, bottom } : null
}

function ProductTourCard({
  step,
  currentStep,
  totalSteps,
  nextStep,
  prevStep,
  skipTour,
}: CardComponentProps): JSX.Element {
  const t = useTranslations('onboarding.tour')
  return (
    <TourCard
      title={step.title}
      step={currentStep}
      total={totalSteps}
      labels={{
        next: t('next'),
        back: t('back'),
        done: t('done'),
        close: t('close'),
        progress: t('progress', { current: currentStep + 1, total: totalSteps }),
      }}
      onNext={nextStep}
      onBack={prevStep}
      onClose={() => skipTour?.()}
    >
      {step.content}
    </TourCard>
  )
}

/**
 * A stop's body. Most are one paragraph; the shortcuts stop shows real keycaps,
 * and the Files-or-Archiv stop sets the two side by side, because "which one
 * does this document go in" is the question it exists to answer.
 */
function StopBody({ stop }: { stop: PlacedTourStop }): JSX.Element {
  const t = useTranslations('onboarding.tour')
  if (stop.id === 'shortcuts') {
    return (
      <div className="space-y-3">
        <p>{t('stops.shortcuts.body')}</p>
        <dl className="space-y-2">
          <TourDetailRow term={t('stops.shortcuts.palette')}>
            <ShortcutKeys segments={[{ kind: 'chord', caps: [MOD, 'K'] }]} />
          </TourDetailRow>
          <TourDetailRow term={t('stops.shortcuts.cheatsheet')}>
            <ShortcutKeys segments={[{ kind: 'chord', caps: ['?'] }]} />
          </TourDetailRow>
        </dl>
      </div>
    )
  }
  if (stop.id === 'filesOrArchiv') {
    return (
      <div className="space-y-3">
        <p>{t('stops.filesOrArchiv.body')}</p>
        <dl className="space-y-2.5">
          <TourDetailRow term={t('stops.filesOrArchiv.filesTerm')} stacked>
            {t('stops.filesOrArchiv.filesDetail')}
          </TourDetailRow>
          <TourDetailRow term={t('stops.filesOrArchiv.archivTerm')} stacked>
            {t('stops.filesOrArchiv.archivDetail')}
          </TourDetailRow>
        </dl>
      </div>
    )
  }
  return <p>{t(`stops.${stop.id}.body`)}</p>
}

/** One term and its detail inside a stop: side by side, or stacked for prose. */
function TourDetailRow({
  term,
  stacked = false,
  children,
}: {
  term: string
  stacked?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className={stacked ? 'space-y-0.5' : 'flex items-center justify-between gap-3'}>
      <dt className="text-foreground font-medium">{term}</dt>
      <dd>{children}</dd>
    </div>
  )
}
