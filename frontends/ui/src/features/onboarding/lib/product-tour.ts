/**
 * The product tour's stops, and the rules for which of them a reader gets.
 *
 * Pure data and pure functions: which element a stop points at is named here
 * as a `data-tour` anchor, and the component that owns the element carries the
 * attribute. A stop whose anchor is not on screen is dropped rather than shown
 * pointing at nothing — the Archiv and the Postfach are flag-gated, so an
 * organization without them gets a shorter tour instead of a broken one.
 */

/** The one tour the app runs. Also the `?tour=` value that starts it. */
export const PRODUCT_TOUR = 'welcome'

/** Query parameter that starts the tour on arrival at the projects home. */
export const TOUR_QUERY_PARAM = 'tour'

/** Where the tour runs: the org scope's one real surface. */
export const TOUR_HOME = '/app/projects'

/** The URL that lands on `home` and starts the tour there. */
export function tourStartUrl(home: string): string {
  return `${home}?${TOUR_QUERY_PARAM}=${PRODUCT_TOUR}`
}

/** Where onboarding sends a new organization's first admin. */
export const TOUR_START_URL = tourStartUrl(TOUR_HOME)

/** `data-tour` values. The element that renders each one owns the attribute. */
export const TOUR_ANCHORS = {
  createProject: 'create-project',
  archiv: 'archiv',
  inbox: 'inbox',
  account: 'account-menu',
} as const

export type TourAnchor = (typeof TOUR_ANCHORS)[keyof typeof TOUR_ANCHORS]

export type TourStopId = 'welcome' | 'createProject' | 'archiv' | 'inbox' | 'account' | 'shortcuts'

/** Every anchor sits in the page's top band, so the card always goes below it. */
export type TourSide = 'bottom-left' | 'bottom-right'

export interface TourStop {
  /** Also the i18n key under `onboarding.tour.stops`. */
  id: TourStopId
  /** Omitted for a stop that is a centred card with no spotlight. */
  anchor?: TourAnchor
}

/** A stop placed against the page as it is rendered right now. */
export interface PlacedTourStop extends TourStop {
  side?: TourSide
}

/**
 * In reading order: what the place is, the one thing to do first, the two
 * org-wide doorways, where the organization is managed, and how to move fast.
 */
export const TOUR_STOPS: readonly TourStop[] = [
  { id: 'welcome' },
  { id: 'createProject', anchor: TOUR_ANCHORS.createProject },
  { id: 'archiv', anchor: TOUR_ANCHORS.archiv },
  { id: 'inbox', anchor: TOUR_ANCHORS.inbox },
  { id: 'account', anchor: TOUR_ANCHORS.account },
  { id: 'shortcuts' },
]

export function tourAnchorSelector(anchor: TourAnchor): string {
  return `[data-tour="${anchor}"]`
}

/** Horizontal extent of an anchor, in viewport pixels. */
export interface AnchorBox {
  left: number
  right: number
}

/**
 * Which way the card hangs below its anchor. `bottom-right` aligns the card's
 * right edge with the anchor's and extends left; `bottom-left` the reverse.
 *
 * Decided here because NextStep does not: its cut-off check flips top/bottom
 * and left/right but never the alignment, so a right-aligned card under the
 * "New project" button ran off the left edge of a phone, where that button
 * sits on the left rather than the right. An anchor in the right half of the
 * viewport hangs its card leftwards, one in the left half rightwards.
 */
export function cardSide(anchor: AnchorBox, viewportWidth: number): TourSide {
  return anchor.left + anchor.right > viewportWidth ? 'bottom-right' : 'bottom-left'
}

/**
 * The stops this reader gets, placed: centred ones always, anchored ones only
 * when their anchor is on screen (`locate` returns null otherwise).
 */
export function placeStops(
  stops: readonly TourStop[],
  locate: (selector: string) => AnchorBox | null,
  viewportWidth: number,
): PlacedTourStop[] {
  return stops.flatMap((stop): PlacedTourStop[] => {
    if (!stop.anchor) return [stop]
    const box = locate(tourAnchorSelector(stop.anchor))
    return box ? [{ ...stop, side: cardSide(box, viewportWidth) }] : []
  })
}

/** Whether a URL's search string asks for the tour. */
export function requestsTour(search: string): boolean {
  return new URLSearchParams(search).get(TOUR_QUERY_PARAM) === PRODUCT_TOUR
}
