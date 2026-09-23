/**
 * The product tours: their stops, where each one runs, and the rules for
 * which stops a reader gets.
 *
 * Two tours, one per scope, because a new person meets the product in two
 * steps and each step has its own screen to explain:
 *
 * - `welcome` runs on the projects home.
 * - `project` runs inside a project — the moment Files, Ask Piloti and the
 *   Archiv stop being names and start being places with something to do in them.
 *
 * Two kinds of new person reach them, by different roads:
 *
 * - The CREATOR is handed over: onboarding lands on `?tour=welcome`, the first
 *   intake save on `?tour=project`. Those are events, so no record is needed.
 * - The JOINER — invited into the organization, or added to a project someone
 *   else set up — passes through neither. WorkOS accepts the invitation and the
 *   sign-in callback lands on the projects home like any other sign-in, and a
 *   project role assignment notifies nobody. There is no event to hang a tour
 *   on, so the server decides instead (`lib/onboarding/tour-eligibility.ts`):
 *   a tour starts by itself for someone who has never written in this
 *   organization and has not seen it, and seeing it is recorded in their user
 *   preferences ({@link TOUR_SEEN_KEYS}).
 *
 * The creator and the joiner get the same stops with different first words:
 * "your organization is ready" is true for one of them only
 * ({@link TourStop.arrivalId}), and so is "invite colleagues and manage roles"
 * ({@link TourStop.memberId}).
 *
 * Pure data and pure functions: which element a stop points at is named here
 * as a `data-tour` anchor, and the component that owns the element carries the
 * attribute. See {@link placeStops} for what happens when a stop's feature is
 * off, or its anchor is not on screen.
 */

export type TourId = 'welcome' | 'project'

/** Query parameter that starts a tour on arrival; its value is the {@link TourId}. */
export const TOUR_QUERY_PARAM = 'tour'

/** Where the welcome tour runs: the org scope's one real surface. */
export const TOUR_HOME = '/app/projects'

/** A URL with a tour queued for arrival. */
export function tourStartUrl(path: string, tour: TourId): string {
  return `${path}?${TOUR_QUERY_PARAM}=${tour}`
}

/** Where onboarding sends a new organization's first admin. */
export const TOUR_START_URL = tourStartUrl(TOUR_HOME, 'welcome')

/**
 * Where the intake wizard sends a project it has just set up for the first
 * time. Straight to chat rather than the project root: the root is a server
 * redirect to chat, and a redirect drops the query string the tour rides on.
 */
export function projectTourUrl(projectId: string): string {
  return tourStartUrl(`/app/projects/${projectId}/chat`, 'project')
}

/** `data-tour` values. The element that renders each one owns the attribute. */
export const TOUR_ANCHORS = {
  createProject: 'create-project',
  archiv: 'archiv',
  inbox: 'inbox',
  account: 'account-menu',
  sectionChat: 'section-chat',
  sectionFiles: 'section-files',
  sectionArchiv: 'section-archiv',
  sectionSettings: 'section-settings',
} as const

export type TourAnchor = (typeof TOUR_ANCHORS)[keyof typeof TOUR_ANCHORS]

/** The rail's anchor for a project section, by its `project-sections.ts` key. */
export function sectionAnchor(sectionKey: string): string {
  return `section-${sectionKey}`
}

/**
 * How a card sits against its anchor. `below` for the header's controls, which
 * all live in the page's top band; `beside` for the project rail, whose items
 * stack down the left edge and leave the room to their right.
 */
export type TourPlacement = 'below' | 'beside'

export type TourSide = 'bottom-left' | 'bottom-right' | 'right'

/** What the reader can reach and do — decides which stops exist and their copy. */
export interface TourFlags {
  canAccessArchiv: boolean
  canAccessInbox: boolean
  canManageOrganization: boolean
}

/** Who is being toured, and how they got here. */
export interface TourReader extends TourFlags {
  /**
   * Started by its hand-over (`?tour=`): the reader just created the
   * organization, or just set up this project. Otherwise they arrived — a
   * joiner, or someone replaying the tour from the account menu.
   */
  handover: boolean
}

export interface TourStop {
  /** i18n key under `onboarding.tour.stops`. */
  id: string
  /** Omitted for a stop that is a centred card with no spotlight. */
  anchor?: TourAnchor
  placement?: TourPlacement
  /** The flag the stop's place is behind; dropped when it is off. */
  gate?: 'canAccessArchiv' | 'canAccessInbox'
  /** Copy for a reader who arrived rather than being handed over. */
  arrivalId?: string
  /** Copy for a reader who cannot manage the organization. */
  memberId?: string
}

/** A stop placed against the page as it is rendered right now. */
export interface PlacedTourStop extends TourStop {
  /** Undefined means centred: no anchor, or an anchor that is not visible. */
  side?: TourSide
}

/**
 * In reading order: what the place is, the one thing to do first, the two
 * org-wide doorways, where the organization is managed, and how to move fast.
 */
const WELCOME_STOPS: readonly TourStop[] = [
  { id: 'welcome', arrivalId: 'welcomeJoined' },
  { id: 'createProject', anchor: TOUR_ANCHORS.createProject, placement: 'below', arrivalId: 'createProjectJoined' },
  { id: 'archiv', anchor: TOUR_ANCHORS.archiv, placement: 'below', gate: 'canAccessArchiv' },
  { id: 'inbox', anchor: TOUR_ANCHORS.inbox, placement: 'below', gate: 'canAccessInbox' },
  { id: 'account', anchor: TOUR_ANCHORS.account, placement: 'below', memberId: 'accountMember' },
  { id: 'shortcuts' },
]

/**
 * Inside a project: the conversation, the project's own documents, the office's
 * shared ones, then Files and the Archiv set side by side — because the
 * difference between them (this building vs. every building) is the thing
 * people get wrong — how the three show up in an answer, and where the project
 * is managed.
 */
const PROJECT_STOPS: readonly TourStop[] = [
  { id: 'projectWelcome', arrivalId: 'projectWelcomeJoined' },
  { id: 'projectChat', anchor: TOUR_ANCHORS.sectionChat, placement: 'beside' },
  { id: 'projectFiles', anchor: TOUR_ANCHORS.sectionFiles, placement: 'beside' },
  { id: 'projectArchiv', anchor: TOUR_ANCHORS.sectionArchiv, placement: 'beside', gate: 'canAccessArchiv' },
  // Centred on purpose: the comparison is the longest card in either tour, and
  // pinned beside an Archiv link near the bottom of the rail it ran off a
  // 680px-tall window.
  { id: 'filesOrArchiv', gate: 'canAccessArchiv' },
  { id: 'projectSources' },
  { id: 'projectSettings', anchor: TOUR_ANCHORS.sectionSettings, placement: 'beside' },
]

export const TOURS: Record<TourId, readonly TourStop[]> = {
  welcome: WELCOME_STOPS,
  project: PROJECT_STOPS,
}

/**
 * What arrival waits for before starting a tour. The welcome tour's first
 * anchor is in the projects page, which streams in behind a loading state; the
 * project tour's anchors are in the rail, which is shell chrome and already
 * standing when the page arrives — and on a phone is a closed drawer that will
 * never render them — so it waits for nothing.
 */
export const ARRIVAL_ANCHOR: Record<TourId, TourAnchor | null> = {
  welcome: TOUR_ANCHORS.createProject,
  project: null,
}

/** Which tour belongs on this page, if any. */
export function tourForPath(pathname: string): TourId | null {
  if (pathname === TOUR_HOME) return 'welcome'
  if (/^\/app\/projects\/[^/]+(\/|$)/.test(pathname)) return 'project'
  return null
}

/**
 * Whether this page is the intake wizard, where no tour starts by itself: a
 * creator lands there straight from "New project", mid-task, and the tour of
 * the project rail would bury the form they came to fill in. The wizard's own
 * first save hands over to the tour when it is done.
 */
export function isSetupPage(pathname: string): boolean {
  return /^\/app\/projects\/[^/]+\/intake(\/|$)/.test(pathname)
}

/**
 * Where "seen this tour" is kept, in the reader's user preferences — an ISO
 * timestamp, written when the tour starts. Starting rather than finishing: a
 * tour closed by a reload halfway through was still seen, and greeting the
 * reader again from the top is the worse failure. Per person rather than per
 * browser, so a second device does not greet them again.
 */
export const TOUR_SEEN_KEYS = {
  welcome: 'tourWelcomeSeenAt',
  project: 'tourProjectSeenAt',
} as const satisfies Record<TourId, string>

/** Which tours may start by themselves for this reader. */
export type TourEligibility = Record<TourId, boolean>

export const NO_TOURS: TourEligibility = { welcome: false, project: false }

/**
 * The rule the server applies: a tour starts by itself for someone new here
 * — nothing written in this organization yet — who has not already seen it.
 *
 * "New here" is the test, not "seen it", because the seen record did not
 * exist before this shipped: every existing member lacks it, and without the
 * first condition all of them would be welcomed to a product they use daily.
 */
export function tourEligibility(prefs: Record<string, unknown>, hasWritten: boolean): TourEligibility {
  if (hasWritten) return NO_TOURS
  return {
    welcome: !prefs[TOUR_SEEN_KEYS.welcome],
    project: !prefs[TOUR_SEEN_KEYS.project],
  }
}

export function tourAnchorSelector(anchor: TourAnchor): string {
  return `[data-tour="${anchor}"]`
}

/** An anchor's box in viewport pixels. */
export interface AnchorBox {
  left: number
  right: number
  top: number
  bottom: number
}

export interface Viewport {
  width: number
  height: number
}

/**
 * Which way the card hangs off its anchor.
 *
 * Decided here because NextStep does not: its cut-off check flips top/bottom
 * and left/right but never the alignment, so a right-aligned card under the
 * "New project" button ran off the left edge of a phone, where that button
 * sits on the left. Below an anchor, the card hangs away from the nearer
 * edge.
 *
 * Beside a rail item it is always plain `right`, centred on the item. The
 * `right-top` / `right-bottom` alignments look like the better fit and are
 * not: NextStep's cut-off check reads their `-top` / `-bottom` as "above" /
 * "below" and flips them whenever the item is near that edge of the screen —
 * which, for a rail whose first item is near the top and whose Settings is
 * pinned to the bottom, inverted every choice and pushed the card off screen.
 * `right` is never flipped vertically, and a card centred on any rail item
 * fits.
 */
export function cardSide(box: AnchorBox, viewport: Viewport, placement: TourPlacement): TourSide {
  if (placement === 'beside') return 'right'
  return box.left + box.right > viewport.width ? 'bottom-right' : 'bottom-left'
}

/**
 * The stops this reader gets, placed against the page as it is now.
 *
 * Two different absences, handled differently. A stop whose FLAG is off names
 * a place this organization does not have (the Archiv and the Postfach are
 * flag-gated), so it is dropped rather than explaining somewhere the reader
 * cannot go. A stop whose ANCHOR is not on screen names a place that exists but
 * is out of view — on a phone the project rail is a drawer that renders
 * nothing while closed — so it stays, as a centred card: the explanation is the
 * value, the spotlight only a convenience.
 *
 * `locate` returns null for an anchor that is absent or has no box. The flags
 * decide existence, never the DOM, because the DOM cannot tell "off" from
 * "in a closed drawer".
 *
 * A placed stop's `id` is the copy to show: the arrival or member variant
 * where one applies to this reader.
 */
export function placeStops(
  stops: readonly TourStop[],
  reader: TourReader,
  locate: (selector: string) => AnchorBox | null,
  viewport: Viewport,
): PlacedTourStop[] {
  return stops.flatMap((stop): PlacedTourStop[] => {
    if (stop.gate && !reader[stop.gate]) return []
    const id = copyFor(stop, reader)
    if (!stop.anchor) return [{ id }]
    const box = locate(tourAnchorSelector(stop.anchor))
    if (!box) return [{ id }]
    return [{ id, anchor: stop.anchor, side: cardSide(box, viewport, stop.placement ?? 'below') }]
  })
}

function copyFor(stop: TourStop, reader: TourReader): string {
  if (stop.arrivalId && !reader.handover) return stop.arrivalId
  if (stop.memberId && !reader.canManageOrganization) return stop.memberId
  return stop.id
}

/**
 * The URL with the tour request taken out and everything else kept — so a
 * reload does not replay the tour, and no other parameter the page was given
 * is lost on the way.
 */
export function withoutTourRequest(pathname: string, search: string): string {
  const params = new URLSearchParams(search)
  params.delete(TOUR_QUERY_PARAM)
  const rest = params.toString()
  return rest ? `${pathname}?${rest}` : pathname
}

/** The tour a URL's search string asks for, if any. */
export function requestedTour(search: string): TourId | null {
  const value = new URLSearchParams(search).get(TOUR_QUERY_PARAM)
  return value === 'welcome' || value === 'project' ? value : null
}
