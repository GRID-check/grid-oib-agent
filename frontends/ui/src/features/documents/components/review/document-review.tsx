'use client'

import { useCallback, useEffect, useRef, useState, type JSX, type RefObject } from 'react'
import Link from 'next/link'
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  Link2,
  MessageSquarePlus,
  MessagesSquare,
  MousePointer2,
  RotateCcw,
  Sparkles,
  Speech,
  SquareDashed,
  X,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useMediaQuery } from '@/hooks/use-media-query'
import { Button } from '@/components/ui/button'
import { PersonAvatar } from '@/components/ui/avatar-stack'
import { identityInk } from '@/components/ui/avatar-identity'
import { FloatingNote, FloatingToolbar, ToolbarIconButton } from '@/components/ui/floating-toolbar'
import { Kbd } from '@/components/ui/kbd'
import { MiddleTruncate } from '@/components/ui/middle-truncate'
import { PilotiGlyph } from '@/components/ui/piloti-glyph'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PdfDocumentView } from '@/features/knowledge/components/pdf-document-view'
import { liveLine } from '@/features/chat/lib/turn-events'
import { useTranslations } from '@/i18n'
import type { AnnotationView } from '@/lib/annotations/types'
import { documentFileUrl } from '@/lib/documents/urls'
import { cn } from '@/lib/utils'
import { stepsOf, type CanvasAsk } from '../../hooks/use-canvas-ask'
import type { DocumentReview as ReviewState, ReviewTool } from '../../hooks/use-document-review'
import { sameValue } from '@/lib/utils/same-value'
import {
  useRoomPeers,
  useRoomSelector,
  type DocumentRoom,
  type RoomPeerState,
} from '../../hooks/use-document-room'
import { CursorChat } from './cursor-chat'
import { keepTrigger, restoreFocus } from './focus-return'
import { PilotiAnswerCard } from './piloti-answer-card'
import { isPilotiPeer, ReviewPageLayer } from './review-page-layer'
import { ReviewPanel, type OpenMark } from './review-panel'
import { ReviewAnnouncer } from './review-announcer'
import { ReviewExportMenu } from './review-export-menu'
import { DraftCard, ThreadCard, type CardPlacement } from './thread-card'

/** A tool on the palette: the review's own, or the cursor chat, which sets nothing. */
type PaletteTool = ReviewTool | 'chat'

const TOOLS: Array<{ tool: PaletteTool; key: string; icon: LucideIcon }> = [
  { tool: 'select', key: 'V', icon: MousePointer2 },
  { tool: 'point', key: 'C', icon: MessageSquarePlus },
  { tool: 'region', key: 'R', icon: SquareDashed },
  { tool: 'ask', key: 'P', icon: Sparkles },
  // A head speaking, not a bubble: the comment tool already is one, and this one keeps nothing.
  { tool: 'chat', key: '/', icon: Speech },
]

/** Where this browser keeps that it has seen the tools explained: the first review opens with them spelled out. */
export const TOOLS_INTRO_KEY = 'piloti.review.toolsIntroSeen'

/** Whether the tools were explained here before. Storage that cannot be read counts as seen: no intro on every open. */
export function toolsIntroSeen(): boolean {
  try {
    return window.localStorage.getItem(TOOLS_INTRO_KEY) === '1'
  } catch {
    return true
  }
}

function rememberToolsIntro(): void {
  try {
    window.localStorage.setItem(TOOLS_INTRO_KEY, '1')
  } catch {
    // A private window: the intro shows again next time, which is harmless.
  }
}

/** A phone, or a phone on its side: a card beside a mark has no room, so it comes up from the bottom edge. */
const DOCKED_CARDS = '(max-width: 639px), (pointer: coarse) and (max-height: 500px)'

/**
 * Where a proposal stands in the walk through Piloti's proposals: its place
 * among the proposals on this Fassung, in the order J and „Durchgehen" take
 * them. Null for anything that is not one of them.
 */
export function walkPosition(
  annotations: readonly Pick<AnnotationView, 'id' | 'status' | 'onCurrentFassung'>[],
  id: string | null
): { index: number; total: number } | null {
  const walk = annotations.filter((annotation) => annotation.status === 'proposed' && annotation.onCurrentFassung)
  const index = walk.findIndex((annotation) => annotation.id === id)
  return index === -1 ? null : { index: index + 1, total: walk.length }
}

/**
 * The tools, as one row of buttons for a pill. `icons`: glyphs with the name
 * and key in a tooltip, in the viewer's own pill. `intro`: the first review a
 * browser opens, every tool spelled out with its key, and a way to fold it.
 * `touch`: a label under every glyph, since a finger has no tooltip and no keys.
 */
function ReviewTools({
  review,
  chatOpen,
  onChat,
  variant,
  onFold,
  onAim,
}: {
  review: ReviewState
  chatOpen: boolean
  onChat: () => void
  variant: 'icons' | 'intro' | 'touch'
  onFold?: () => void
  /** A mark tool was taken up from the keyboard: the crosshair sets the place. */
  onAim?: () => void
}): JSX.Element {
  const t = useTranslations('files')
  const offered = TOOLS.filter(({ tool }) => tool === 'chat' || toolOffered(tool, review))
  return (
    <div role="group" aria-label={t('review.toolsLabel')} data-testid="review-tools" data-variant={variant} className="flex items-center gap-0.5">
      {offered.map(({ tool, key, icon: Icon }) => {
        const pressed = tool === 'chat' ? chatOpen : review.tool === tool
        const name = tool === 'chat' ? t('review.chatOpen') : t(`review.tools.${tool}`)
        const button = (
          <ToolbarIconButton
            data-testid={`review-tool-${tool}`}
            aria-pressed={pressed}
            aria-keyshortcuts={key}
            aria-label={name}
            onClick={(event) => {
              if (tool === 'chat') return onChat()
              review.setTool(tool)
              // `detail` is 0 for a click the keyboard made (Enter, Space).
              if (tool !== 'select' && event.detail === 0) onAim?.()
            }}
            className={cn(
              // The tool in hand is filled in ink: what the pointer will do is never a guess.
              'aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:hover:text-background',
              // Spelled out where the stage is wide enough for the whole pill; under ~1000px of it the
              // tools fold to their glyphs, still named for a screen reader (the viewer's container).
              variant === 'intro' && 'w-auto gap-1.5 px-2 text-xs font-medium @max-5xl:w-7 @max-5xl:px-0',
              variant === 'touch' && 'h-12 w-14 flex-col gap-0.5 pointer-coarse:size-auto pointer-coarse:h-12 pointer-coarse:w-14'
            )}
          >
            <Icon aria-hidden />
            {variant === 'intro' && (
              <>
                {/* The short name: the pill also carries the viewer's own controls. */}
                <span className="@max-5xl:sr-only">{t(`review.toolsShort.${tool}`)}</span>
                <Kbd className="h-4 min-w-4 px-1 text-[10px] @max-5xl:hidden">{key}</Kbd>
              </>
            )}
            {variant === 'touch' && <span className="text-[10px] leading-3 font-medium">{t(`review.toolsShort.${tool}`)}</span>}
          </ToolbarIconButton>
        )
        // A finger has no hover: its labels are under the glyphs. Spelled out, the
        // tools keep the tooltip too, for when a narrow stage folds them to glyphs.
        if (variant === 'touch') return <span key={tool} className="contents">{button}</span>
        return (
          <Tooltip key={tool}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent side="top">
              {name} <Kbd className="ml-1">{key}</Kbd>
            </TooltipContent>
          </Tooltip>
        )
      })}
      {variant === 'intro' && onFold && (
        <ToolbarIconButton
          aria-label={t('review.toolsIntroFold')}
          title={t('review.toolsIntroFold')}
          data-testid="review-tools-fold"
          className="@max-5xl:hidden"
          onClick={onFold}
        >
          <X aria-hidden />
        </ToolbarIconButton>
      )}
    </div>
  )
}

/** Which tools a reader has: marks need the right to set them; Piloti needs a project to ask in. */
const toolOffered = (tool: ReviewTool, review: ReviewState): boolean =>
  tool === 'select' || (tool === 'ask' ? review.piloti.available : review.canAnnotate)

/** Whether a key press belongs to a field the reader is typing in. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))

/** The people in the room, one face per person however many tabs they have open. Piloti is not one of them. */
export function people(peers: readonly RoomPeerState[]): RoomPeerState[] {
  const byUser = new Map<string, RoomPeerState>()
  for (const state of peers) {
    if (!isPilotiPeer(state) && !byUser.has(state.peer.userId)) byUser.set(state.peer.userId, state)
  }
  return [...byUser.values()]
}

/**
 * Who is in the room, as the header tells it: the people, one per person, and
 * the page each is on; and Piloti, what it is doing and for whom. Equal by
 * value from one pointer frame to the next, so the faces, the header and the
 * file preview that read it re-render when somebody comes, goes or turns a
 * page, not when a pointer moves.
 */
export interface RoomCompany {
  people: Array<{ peerId: string; userId: string; name: string; page: number | null }>
  piloti: { forName: string | null; working: boolean; label: string | null } | null
}

export function roomCompanyOf(peers: readonly RoomPeerState[]): RoomCompany {
  const piloti = peers.find(isPilotiPeer) ?? null
  return {
    people: people(peers).map((state) => ({
      peerId: state.peer.peerId,
      userId: state.peer.userId,
      name: state.peer.name,
      page: pageOf(state),
    })),
    piloti: piloti
      ? { forName: piloti.peer.forName ?? null, working: Boolean(piloti.activity), label: piloti.activity?.label ?? null }
      : null,
  }
}

/** The room's company, re-rendering only when it changed: see {@link RoomCompany}. */
export const useRoomCompany = (room: Pick<DocumentRoom, 'peers'>): RoomCompany =>
  useRoomSelector(room, roomCompanyOf, sameValue)

/**
 * Who else is here, as faces in their colour. A face is also the way to follow
 * them: the view goes where theirs goes until the reader moves on their own.
 * Without `onFollow` (the file preview's header) the faces only tell, and the
 * caller says in words who they are.
 */
export function Presence({
  review,
  following = null,
  onFollow,
}: {
  review: ReviewState
  following?: string | null
  onFollow?: (peerId: string | null) => void
}): JSX.Element | null {
  const t = useTranslations('files')
  const tPresence = useTranslations('presence')
  const { people: others, piloti } = useRoomCompany(review.room)
  // Piloti in the room as itself: a peer the server publishes while it works on
  // the document, naming whose request it works on (ADR-0105). The full name
  // here, where there is room; the cursor tag carries the first name.
  const forName = piloti?.forName
  const onBehalf = forName ? tPresence('piloti.onBehalfOf', { name: forName }) : null
  if (others.length === 0 && !piloti) return null
  if (!onFollow) {
    return (
      <span aria-hidden className="flex items-center -space-x-1" data-testid="review-presence">
        {piloti && (
          <span className="ring-background rounded-full ring-2">
            <PilotiGlyph size="md" working={piloti.working} label={onBehalf ?? 'Piloti'} />
          </span>
        )}
        {others.map((person) => (
          <PersonAvatar
            key={person.userId}
            size="sm"
            className="ring-background size-7 text-[10px] ring-2"
            person={{ userId: person.userId, name: person.name, profilePictureUrl: null }}
          />
        ))}
      </span>
    )
  }
  return (
    <div className="flex items-center -space-x-1" data-testid="review-presence">
      {piloti && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span data-testid="review-presence-piloti" className="ring-background rounded-full ring-2">
              <PilotiGlyph size="md" working={piloti.working} label={onBehalf ?? 'Piloti'} />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {onBehalf ? (
              <>
                <span className="block">{onBehalf}</span>
                {piloti.label && <span className="block">{piloti.label}</span>}
              </>
            ) : (
              piloti.label || t('review.pilotiWorking')
            )}
          </TooltipContent>
        </Tooltip>
      )}
      {others.map((person) => {
        const on = following === person.peerId
        return (
          <Tooltip key={person.userId}>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid="review-peer"
                aria-pressed={on}
                aria-label={on ? t('review.unfollow', { name: person.name }) : t('review.follow', { name: person.name })}
                onClick={() => onFollow(on ? null : person.peerId)}
                className="relative rounded-full outline-none focus-visible:ring-2"
              >
                <PersonAvatar
                  size="sm"
                  className="ring-background size-7 text-[10px] ring-2"
                  person={{ userId: person.userId, name: person.name, profilePictureUrl: null }}
                />
                <span
                  aria-hidden
                  className={cn('absolute -inset-[3px] rounded-full border-2', on ? 'opacity-100' : 'opacity-0')}
                  style={{ borderColor: identityInk(person.userId) }}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <span className="block">
                {on ? t('review.unfollow', { name: person.name }) : t('review.follow', { name: person.name })}
              </span>
              {person.page && <span className="block">{t('review.onPage', { name: person.name, page: person.page })}</span>}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

/** The page a person is on: where their pointer is, else where they are scrolled to. */
const pageOf = (state: RoomPeerState): number | null => state.cursor?.page ?? state.viewport?.page ?? null

/** Where a colleague is from this reader's view: in it, or past its top or bottom edge. */
export type PeerSide = 'here' | 'above' | 'below'

/**
 * Where a colleague's point is from the reader's view. Measured where the
 * page is laid out (`pageRect`, the view's `top`/`bottom`, all in the
 * window): their point is on screen or past an edge, so a colleague on the
 * next page whose pointer is in plain sight gets no chip. A page that is not
 * laid out is told by its number against the reader's page.
 */
export function peerSide(
  at: { page: number; y: number },
  viewPage: number,
  pageRect: { top: number; height: number } | null,
  view: { top: number; bottom: number } | null
): PeerSide {
  if (pageRect && view && pageRect.height > 0) {
    const y = pageRect.top + at.y * pageRect.height
    return y < view.top ? 'above' : y > view.bottom ? 'below' : 'here'
  }
  return at.page < viewPage ? 'above' : at.page > viewPage ? 'below' : 'here'
}

/** Re-render on every scroll inside `ref`, once a frame at most: what is on screen moved. */
function useScrollTick(ref: RefObject<HTMLElement | null>): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    let frame: number | null = null
    const onScroll = () => {
      if (frame === null)
        frame = requestAnimationFrame(() => {
          frame = null
          setTick((tick) => tick + 1)
        })
    }
    node.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      node.removeEventListener('scroll', onScroll, { capture: true })
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [ref])
}

/**
 * The people out of this reader's view, at the edge of the sheet that leads
 * to them, the way a design tool keeps a colleague's pointer at the edge of
 * the canvas when it is off-screen. A chip jumps there; following stays the
 * face's. `edge` is the one edge this instance draws.
 */
function Elsewhere({
  review,
  page,
  edge,
  canvas,
  onJump,
}: {
  review: ReviewState
  page: number
  edge: 'above' | 'below'
  /** The canvas the pages are laid out in, to tell what is on screen. */
  canvas: RefObject<HTMLElement | null>
  onJump: (state: RoomPeerState) => void
}): JSX.Element | null {
  const t = useTranslations('files')
  useScrollTick(canvas)
  const node = canvas.current
  const view = node?.getBoundingClientRect() ?? null
  // Its own subscription: where people are moves with every pointer, and only these chips redraw for it.
  const peers = useRoomPeers(review.room)
  const here = people(peers).flatMap((state) => {
    const at = pageOf(state)
    if (at === null) return []
    const y = state.cursor?.page === at ? state.cursor.y : (state.viewport?.y ?? 0.5)
    const layer = node?.querySelector<HTMLElement>(`[data-testid="review-layer-${at}"]`)
    const side = peerSide({ page: at, y }, page, layer?.getBoundingClientRect() ?? null, view)
    return side === edge ? [{ state, at }] : []
  })
  if (here.length === 0) return null
  const Arrow = edge === 'above' ? ArrowUp : ArrowDown
  return (
    <div
      className={cn(
        'pointer-events-none flex flex-wrap justify-center gap-1.5',
        edge === 'below' && 'absolute bottom-16 left-1/2 z-30 -translate-x-1/2 pointer-coarse:bottom-36'
      )}
      data-testid={`review-elsewhere-${edge}`}
    >
      {here.map(({ state, at }) => (
        <button
          key={state.peer.userId}
          type="button"
          data-testid="review-elsewhere"
          aria-label={t('review.elsewhereJump', { name: state.peer.name, page: at })}
          title={t('review.elsewhereJump', { name: state.peer.name, page: at })}
          onClick={() => onJump(state)}
          className="pointer-events-auto inline-flex items-center gap-1 rounded-full py-0.5 pr-2 pl-1.5 text-[11px] leading-4 font-medium text-white shadow-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          style={{ backgroundColor: identityInk(state.peer.userId) }}
        >
          <Arrow className="size-3" aria-hidden />
          {t('review.elsewhere', { name: state.peer.name.split(/\s+/)[0] ?? state.peer.name, page: at })}
        </button>
      ))}
    </div>
  )
}

/** The whole-document review asked of Piloti: the latest one, while it is in the header. */
const documentReviewOf = (asks: readonly CanvasAsk[]): CanvasAsk | null =>
  asks.findLast((ask) => ask.region === null && !ask.replyInThread) ?? null

/**
 * „Piloti prüfen lassen" in place: Piloti goes through the document while it
 * stays open, its findings landing as proposals through the room, its pointer
 * on the pages. The header says what it is doing, compactly, and where the
 * conversation is.
 */
function PilotiReview({ review, onWalk }: { review: ReviewState; onWalk: () => void }): JSX.Element {
  const t = useTranslations('files')
  const tChat = useTranslations('chat')
  const { piloti } = review
  const run = documentReviewOf(piloti.asks)
  if (!run) {
    const button = (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 gap-1.5"
        data-testid="review-with-piloti"
        disabled={piloti.busy}
        onClick={() => piloti.ask({ text: t('review.reviewSeed'), region: null, effort: 'medium' })}
      >
        <Sparkles className="size-3.5" aria-hidden />
        {/* On a phone the glyph carries it; the words stay for a screen reader. */}
        <span className="max-sm:sr-only">{t('review.reviewWithPiloti')}</span>
      </Button>
    )
    if (!piloti.busy) return button
    // A disabled button says why: a wrapper takes the pointer the button no longer does.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex rounded-md" data-testid="review-with-piloti-busy">
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent>{t('review.piloti.busyTooltip')}</TooltipContent>
      </Tooltip>
    )
  }
  const working = run.status === 'thinking'
  const found = run.status === 'answered' ? review.counts.proposed : 0
  const line = working
    ? (liveLine(stepsOf(run.view), tChat) ?? t('review.piloti.reviewing'))
    : run.status === 'failed'
      ? t('review.piloti.reviewFailed')
      : found > 0
        ? t('review.piloti.reviewFound', { count: found })
        : t('review.piloti.reviewDone')
  return (
    <div
      role="status"
      data-testid="review-piloti-status"
      className="border-border/70 bg-muted/40 flex h-8 max-w-[30rem] items-center gap-2 rounded-full border pr-1 pl-1"
    >
      <PilotiGlyph working={working} />
      {working ? (
        <ShimmerText className="min-w-0 flex-1 text-xs">{line}</ShimmerText>
      ) : (
        <span className="text-foreground min-w-0 flex-1 truncate text-xs font-medium">{line}</span>
      )}
      {found > 0 && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-6 shrink-0 rounded-full px-2.5 text-xs"
          data-testid="review-piloti-walk"
          onClick={onWalk}
        >
          {t('review.walkProposals')}
        </Button>
      )}
      {piloti.conversationHref && (
        <Button asChild variant="ghost" size="sm" className="h-6 px-2 text-xs">
          <Link href={piloti.conversationHref} data-testid="review-piloti-conversation">
            {t('review.piloti.openConversation')}
          </Link>
        </Button>
      )}
      {run.status === 'failed' && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 rounded-full [&_svg]:size-3"
          aria-label={t('review.piloti.retry')}
          onClick={() => piloti.retry(run.id)}
        >
          <RotateCcw aria-hidden />
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 rounded-full [&_svg]:size-3"
        aria-label={working ? t('review.piloti.stop') : t('review.piloti.close')}
        title={working ? t('review.piloti.stop') : t('review.piloti.close')}
        data-testid="review-piloti-dismiss"
        onClick={() => piloti.dismiss(run.id)}
      >
        <X aria-hidden />
      </Button>
    </div>
  )
}

/**
 * The focused review of one document: the sheet, the marks on it, the threads
 * under them, and the people looking at it with you.
 *
 * Built for two moments an architect has with a drawing. Alone, with time: go
 * through a Fachplaner's sheet and leave what you find exactly where you found
 * it, without a form in the way (C, click, type, Enter). Together: a Jour fixe
 * or a call where everybody looks at the same sheet, sees each other's
 * pointers, follows whoever is talking, and watches the marks land. Piloti is
 * in the room as a colleague: asked about a box (P, or from a draft or a
 * thread), it answers beside it; asked to review the document, it works
 * through it with its own pointer, and its findings arrive as proposals that
 * count only once a person takes one over.
 *
 * Everything else of the workspace is gone while it is open (a full-screen
 * `Dialog`, the overlay the design language gives an artifact looked at with
 * full attention). Escape steps back one thing at a time: the draft, the tool,
 * the open thread, and only then the review itself.
 */
export function DocumentReviewMode({
  open,
  onOpenChange,
  review,
  documentName,
  fassungLabel,
  canPickAssignee,
  focusRequest,
  popoutHref = null,
  initialTool,
  onPage,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  review: ReviewState
  documentName: string
  /** „Fassung 3", when the document has Fassungen to tell apart. */
  fassungLabel?: string | null
  canPickAssignee: boolean
  /** A mark to open at, when the review was entered from one. */
  focusRequest?: { annotationId: string; key: number } | null
  /** The review on a page of its own: offered as a window of its own, and as a link to send. */
  popoutHref?: string | null
  /** A tool to have in hand once the review opens (entered by „Anmerken"). */
  initialTool?: ReviewTool
  /** The page the reader is on, as it changes: the file preview opens there again once the review closes. */
  onPage?: (page: number) => void
}): JSX.Element {
  const t = useTranslations('files')
  const [focus, setFocus] = useState<{ page: number; y: number; key: string; instant?: boolean } | null>(null)
  const [following, setFollowing] = useState<string | null>(null)
  const { annotations, select, setTool, tool, selectedId, draft, setDraft, room, piloti } = review
  /**
   * The page this reader is on (the one crossing the middle of the view), for
   * who is elsewhere. Null until the viewer first reports: it opens on page 1.
   */
  const [viewPage, setViewPage] = useState<number | null>(null)
  /** Where the middle of the reader's view is, for the keyboard's crosshair to start there. */
  const viewAt = useRef<{ page: number; y: number } | null>(null)
  const { sendViewport } = room
  const onViewport = useCallback(
    (viewport: { page: number; y: number }) => {
      if (viewAt.current?.page !== viewport.page) onPage?.(viewport.page)
      viewAt.current = viewport
      setViewPage(viewport.page)
      sendViewport(viewport)
    },
    [sendViewport, onPage]
  )
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const touch = useMediaQuery('(pointer: coarse)')
  /**
   * Cursor chat („/"): open, and where this reader's pointer last was, to open
   * it there. From the toolbar's button there is no pointer to open at (the
   * hand is on the button): the bubble opens centred over the sheet.
   */
  const [chat, setChat] = useState<{ from: { x: number; y: number } | null } | null>(null)
  const lastPointer = useRef<{ x: number; y: number } | null>(null)
  const openChat = useCallback((atPointer: boolean) => setChat({ from: atPointer ? lastPointer.current : null }), [])
  const jumpTo = useCallback((state: RoomPeerState) => {
    const page = pageOf(state)
    if (page === null) return
    setFollowing(null)
    const y = state.viewport?.page === page ? state.viewport.y : (state.cursor?.y ?? 0)
    setFocus({ page, y, key: `jump:${state.peer.peerId}:${Date.now()}` })
  }, [])
  const openAsk = piloti.asks.find((ask) => ask.id === piloti.openId) ?? null
  // From `lg` the list is a column beside the sheet; below it, a sheet from the
  // bottom edge behind a header button (a phone on its side is 852px, under `lg`).
  const listBeside = useMediaQuery('(min-width: 1024px)')
  const [listOpen, setListOpen] = useState(false)
  // On a phone a card beside its mark runs off the screen: it comes up from the bottom edge instead.
  const docked = useMediaQuery(DOCKED_CARDS)

  /**
   * The tools spelled out, the first time a browser opens a review: every
   * tool with its name and key. Folded after the first mark or by its ×.
   */
  const [intro, setIntro] = useState(false)
  useEffect(() => {
    if (open && !touch && !toolsIntroSeen()) setIntro(true)
  }, [open, touch])
  const foldIntro = useCallback(() => {
    setIntro(false)
    rememberToolsIntro()
  }, [])
  useEffect(() => {
    if (intro && (draft || openAsk)) foldIntro()
  }, [intro, draft, openAsk, foldIntro])

  // Entered with a tool in hand: armed once per opening.
  const armed = useRef(false)
  useEffect(() => {
    if (!open) {
      armed.current = false
      return
    }
    // Not before the reader's rights are known: the tools are offered once the list has said so.
    if (armed.current || !initialTool || !toolOffered(initialTool, review)) return
    armed.current = true
    setTool(initialTool)
  }, [open, initialTool, review, setTool])

  const bring = useCallback(
    (annotation: AnnotationView) => {
      setFollowing(null)
      setDraft(null)
      select(annotation.id)
      if (annotation.onCurrentFassung) {
        setFocus({ page: annotation.page, y: annotation.y + (annotation.h ?? 0) / 2, key: `${annotation.id}:${Date.now()}` })
      }
    },
    [select, setDraft]
  )

  /**
   * The focus, for a reader on the keyboard. A card opened by a key (J, K, Enter
   * on a pin or a row) takes the focus itself: it is a dialog named by its
   * header, so it is announced, and no Enter lands on „Erledigen" by accident.
   * What had the focus is kept, and gets it back when the card closes (its ×,
   * Escape). Each key's ask is counted, so a key that lands on the card already
   * open is answered at once and leaves nothing behind for a later click. The
   * keyboard's crosshair returns the focus the same way when the tool is put down.
   */
  const cardTrigger = useRef<HTMLElement | null>(null)
  const [cardFocusAsked, setCardFocusAsked] = useState(0)
  const cardFocusAnswered = useRef(0)
  const focusNextCard = useCallback(() => {
    cardTrigger.current = keepTrigger(cardTrigger.current)
    setCardFocusAsked((asked) => asked + 1)
  }, [])
  const cardInHand = openAsk?.id ?? (draft ? 'draft' : selectedId)
  useEffect(() => {
    if (cardFocusAsked !== cardFocusAnswered.current) {
      cardFocusAnswered.current = cardFocusAsked
      if (!cardInHand) return
      const frame = requestAnimationFrame(() => {
        const card = document.querySelector<HTMLElement>('[data-review-card]')
        if (card && !card.contains(document.activeElement)) card.focus({ preventScroll: true })
      })
      return () => cancelAnimationFrame(frame)
    }
    const trigger = cardTrigger.current
    if (cardInHand || !trigger) return
    cardTrigger.current = null
    const frame = requestAnimationFrame(() => restoreFocus(trigger))
    return () => cancelAnimationFrame(frame)
  }, [cardInHand, cardFocusAsked])

  /** The keyboard's crosshair: a mark tool taken up by a key sets its place with the arrows. */
  const [aim, setAim] = useState<{ page: number; y: number; key: number } | null>(null)
  const aimTrigger = useRef<HTMLElement | null>(null)
  const startAim = useCallback(() => {
    aimTrigger.current = keepTrigger(aimTrigger.current)
    const at = viewAt.current
    setAim({ page: at?.page ?? viewPage ?? 1, y: at?.y ?? 0.5, key: Date.now() })
  }, [viewPage])
  useEffect(() => {
    if (tool !== 'select' || !aim) return
    setAim(null)
    // Put down, or the mark set and its card closed: the focus goes back to where the tool was taken up.
    const trigger = aimTrigger.current
    aimTrigger.current = null
    if (!trigger) return
    const frame = requestAnimationFrame(() => restoreFocus(trigger))
    return () => cancelAnimationFrame(frame)
  }, [tool, aim])

  /**
   * Going through Piloti's proposals („Durchgehen"): the proposal in hand. A
   * decision on it moves to the next one; choosing anything else ends the walk.
   */
  const [walking, setWalking] = useState<string | null>(null)
  const walkProposals = useCallback(() => {
    const next = review.step(1, 'proposed')
    setWalking(next?.id ?? null)
    if (next) bring(next)
  }, [review, bring])
  useEffect(() => {
    if (!walking) return
    if (selectedId !== walking) {
      setWalking(null)
      return
    }
    const current = annotations.find((annotation) => annotation.id === walking)
    if (current?.status === 'proposed') return
    // Taken over or dismissed: on to the next, or the walk is done.
    const next = review.step(1, 'proposed')
    setWalking(next?.id ?? null)
    if (next) bring(next)
  }, [walking, selectedId, annotations, review, bring])
  const walk = walking ? walkPosition(annotations, walking) : null
  /** A row of the list chosen: its mark brought into view, its card focused when a key chose it. */
  const openFromList = useCallback<OpenMark>(
    (annotation, byKeyboard) => {
      if (byKeyboard) focusNextCard()
      bring(annotation)
    },
    [bring, focusNextCard]
  )

  // Entered from a mark: open at it, once per request, as soon as the list holds it.
  const handled = useRef<number | null>(null)
  useEffect(() => {
    if (!open || !focusRequest || handled.current === focusRequest.key) return
    const target = annotations.find((annotation) => annotation.id === focusRequest.annotationId)
    if (!target) return
    handled.current = focusRequest.key
    bring(target)
  }, [open, focusRequest, annotations, bring])

  // Following: the view goes where theirs goes. Read off the room by what it needs, so
  // their pointer moving does not re-render the review; their view moving does.
  const followed = useRoomSelector(
    room,
    useCallback(
      (peers: readonly RoomPeerState[]) => {
        const state = following ? peers.find((peer) => peer.peer.peerId === following) : undefined
        return state
          ? { peerId: state.peer.peerId, userId: state.peer.userId, name: state.peer.name, viewport: state.viewport }
          : null
      },
      [following]
    ),
    sameValue
  )
  useEffect(() => {
    if (!following) return
    if (!followed) {
      setFollowing(null)
      return
    }
    if (!followed.viewport) return
    setFocus({
      page: followed.viewport.page,
      y: followed.viewport.y,
      key: `follow:${followed.viewport.page}:${followed.viewport.y.toFixed(3)}`,
      instant: true,
    })
  }, [following, followed])

  const { notice, dismissNotice } = review
  useEffect(() => {
    if (notice !== 'conflict') return
    toast.info(t('review.conflict'))
    dismissNotice()
  }, [notice, dismissNotice, t])

  const close = useCallback(() => {
    setFollowing(null)
    setDraft(null)
    setTool('select')
    onOpenChange(false)
  }, [onOpenChange, setDraft, setTool])

  // A mark of an earlier Fassung is listed, never drawn: selected, its thread
  // opens over the sheet instead of beside a pin that is not there.
  const earlier = annotations.find((annotation) => annotation.id === selectedId && !annotation.onCurrentFassung) ?? null
  const selected = annotations.find((annotation) => annotation.id === selectedId) ?? null
  // The card a phone docks: Piloti's answer on a box, the draft, or the open thread.
  const dockedAsk = openAsk && openAsk.region && !openAsk.replyInThread ? openAsk : null
  const dockOpen = docked && Boolean(dockedAsk || draft || selected)
  const closeCard = useCallback(() => {
    if (dockedAsk) {
      if (dockedAsk.status === 'thinking') piloti.open(null)
      else piloti.dismiss(dockedAsk.id)
    } else if (draft) setDraft(null)
    else select(null)
  }, [dockedAsk, piloti, draft, setDraft, select])

  /**
   * Escape steps back one thing at a time: Piloti's card, the draft, following,
   * the tool, the open thread, and only then the review itself. It runs as the
   * dialog's own Escape (Radix hears the key first, on the document, and only
   * for the topmost layer: an open menu or sheet takes its own Escape). In a
   * field it is the field's, unless there is a draft or a card to let go of.
   */
  const stepBack = (event: KeyboardEvent) => {
    event.preventDefault()
    if (typing(event.target) && !draft && !openAsk) return
    if (openAsk) piloti.open(null)
    else if (draft) setDraft(null)
    else if (following) setFollowing(null)
    else if (tool !== 'select') setTool('select')
    else if (selectedId) select(null)
    else close()
  }

  // Letters pick tools and walk the marks. The handler reads this render's state
  // through a ref: the listener is attached once per opening, not on every change.
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    // The list's sheet, and a phone's card sheet, are layers of their own: their keys are their own.
    if (listOpen || dockOpen) return
    if (event.key === 'Escape' || typing(event.target)) return
    const key = event.key.toLowerCase()
    if (key === '/') openChat(true)
    else if (key === 'v') setTool('select')
    else if ((key === 'c' || key === 'r') && review.canAnnotate) {
      setTool(key === 'c' ? 'point' : 'region')
      startAim()
    } else if (key === 'p' && piloti.available) {
      setTool('ask')
      startAim()
    } else if (key === 'j' && walk) {
      focusNextCard()
      walkProposals()
    } else if (key === 'j' || key === 'k') {
      const next = review.step(key === 'j' ? 1 : -1)
      if (next) {
        focusNextCard()
        bring(next)
      }
    } else if (key === 'e' && selectedId) {
      const current = annotations.find((annotation) => annotation.id === selectedId)
      if (!current?.canEdit) return
      if (current.status === 'proposed' || current.status === 'open') {
        void review
          .update(current.id, {
            status: current.status === 'proposed' ? 'open' : 'resolved',
            expectedStatus: current.status,
          })
          .catch(() => toast.error(t('review.actionFailed')))
      }
    } else if ((key === 'backspace' || key === 'delete') && selectedId) {
      // ⌫ on „Verwerfen" says it: a proposal in hand is dismissed, nothing else is.
      const current = annotations.find((annotation) => annotation.id === selectedId)
      if (!current?.canEdit || current.status !== 'proposed') return
      void review
        .update(current.id, { status: 'dismissed', expectedStatus: 'proposed' })
        .catch(() => toast.error(t('review.actionFailed')))
    } else return
    event.preventDefault()
  }
  const onKeyRef = useRef(onKey)
  useEffect(() => {
    onKeyRef.current = onKey
  })
  useEffect(() => {
    if (!open) return
    const listener = (event: KeyboardEvent) => onKeyRef.current(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [open])

  /** A link that opens the review at this mark, on the clipboard; a refusal says so. */
  const copyText = useCallback(
    (text: string) => {
      if (!navigator.clipboard) {
        toast.error(t('review.linkCopyFailed'))
        return
      }
      void navigator.clipboard
        .writeText(text)
        .then(() => toast.success(t('review.linkCopied')))
        .catch(() => toast.error(t('review.linkCopyFailed')))
    },
    [t]
  )
  const copyLink = useCallback(
    (annotation: AnnotationView) => {
      const url = new URL(window.location.href)
      url.searchParams.set('doc', annotation.documentId)
      url.searchParams.set('review', '1')
      url.searchParams.set('mark', annotation.id)
      copyText(url.toString())
    },
    [copyText]
  )
  const popout = useCallback(() => {
    if (popoutHref) window.open(popoutHref, '_blank', 'popup,width=1440,height=900')
  }, [popoutHref])

  const followedState = followed

  /** The card for whatever is in hand, wherever it is shown. */
  const threadCard = (placement: CardPlacement) => {
    if (draft) return <DraftCard review={review} draft={draft} placement={placement} canPickAssignee={canPickAssignee} />
    if (!selected) return null
    return (
      <ThreadCard
        key={selected.id}
        review={review}
        annotation={selected}
        placement={placement}
        canPickAssignee={canPickAssignee}
        onCopyLink={copyLink}
        walk={walk && walking === selected.id ? { ...walk, onNext: walkProposals } : null}
      />
    )
  }

  // What the tool in hand does next, said once at the top of the canvas.
  // With the keyboard's crosshair out, the keys that move and set it.
  const toolHint =
    tool !== 'select' && !draft && !openAsk
      ? aim
        ? t(`review.aim.hint.${tool}`)
        : t(`review.${touch ? 'toolHintTouch' : 'toolHint'}.${tool}`)
      : null

  const toolsPalette = (variant: 'icons' | 'intro' | 'touch') => (
    <ReviewTools
      review={review}
      chatOpen={chat !== null}
      onChat={() => openChat(false)}
      variant={variant}
      onFold={foldIntro}
      onAim={startAim}
    />
  )
  const exportMenu = annotations.length > 0 && (
    <ReviewExportMenu
      documentId={review.documentId}
      hasFassungen={annotations.some((annotation) => !annotation.onCurrentFassung)}
      hasProposals={annotations.some((annotation) => annotation.authorKind === 'piloti' && !annotation.acceptedBy)}
    />
  )

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={stepBack}
        // The sheet is what has focus to begin with, not the close button: a
        // ring on the X is the first thing an opened review would say.
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="bg-background inset-0 top-0 left-0 flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none"
        data-testid="document-review"
      >
        <header className="flex min-h-13 shrink-0 items-center gap-3 border-b px-3 pt-[env(safe-area-inset-top)] pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] max-sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 pointer-coarse:size-11"
            aria-label={t('review.close')}
            title={`${t('review.close')} (Esc)`}
            onClick={close}
          >
            <X className="size-4" aria-hidden />
          </Button>
          <div className="min-w-0 flex-1">
            {/* Cut in the middle: a phone's header leaves the name ~140px, and
                the index at its end is what says which Fassung is under review. */}
            <DialogTitle className="text-foreground flex text-sm font-semibold">
              <MiddleTruncate text={documentName} tail={12} />
            </DialogTitle>
            <DialogDescription className="text-muted-foreground truncate text-xs">
              {[
                fassungLabel,
                review.counts.open + review.counts.proposed > 0
                  ? t('annotations.openCount', { count: review.counts.open + review.counts.proposed })
                  : t('review.nothingOpen'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </DialogDescription>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3 max-sm:gap-2">
            {room.status === 'offline' && (
              <span
                className="text-muted-foreground text-[11px] font-medium"
                data-testid="review-offline"
                title={t('review.offlineHint')}
                role="status"
              >
                {t('review.offline')}
              </span>
            )}
            <Presence review={review} following={following} onFollow={setFollowing} />
            {popoutHref && (
              // A window of its own for a second screen, and the link to send: both quiet, beside the faces.
              <span className="flex items-center max-sm:hidden">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={t('review.popout')}
                  title={t('review.popout')}
                  data-testid="review-popout"
                  onClick={popout}
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={t('review.copyReviewLink')}
                  title={t('review.copyReviewLink')}
                  data-testid="review-copy-link"
                  onClick={() => copyText(new URL(popoutHref, window.location.href).toString())}
                >
                  <Link2 className="size-3.5" aria-hidden />
                </Button>
              </span>
            )}
            {!listBeside && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 pointer-coarse:h-11"
                aria-haspopup="dialog"
                aria-expanded={listOpen}
                aria-label={t('annotations.section')}
                data-testid="review-list-open"
                onClick={() => setListOpen(true)}
              >
                <MessagesSquare className="size-3.5" aria-hidden />
                <span className="font-mono tabular-nums">{review.counts.open + review.counts.proposed}</span>
              </Button>
            )}
            {listBeside && exportMenu}
            {piloti.available && review.canAnnotate && <PilotiReview review={review} onWalk={walkProposals} />}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div
            ref={canvasRef}
            className="relative min-w-0 flex-1"
            data-testid="review-canvas"
            onWheelCapture={() => following && setFollowing(null)}
            onPointerDownCapture={() => following && setFollowing(null)}
            onPointerMove={(event) => {
              lastPointer.current = { x: event.clientX, y: event.clientY }
            }}
          >
            {/* What sits at the top of the canvas, one under the other: whom the
                view follows, who is out of view above, what the tool in hand does. */}
            <div className="pointer-events-none absolute inset-x-3 top-3 z-30 flex flex-col items-center gap-1.5">
              {followedState && (
                <span
                  className="rounded-full px-3 py-1 text-xs font-medium text-white shadow-md"
                  style={{ backgroundColor: identityInk(followedState.userId) }}
                  role="status"
                >
                  {t('review.following', { name: followedState.name })}
                </span>
              )}
              <Elsewhere review={review} page={viewPage ?? 1} edge="above" canvas={canvasRef} onJump={jumpTo} />
              {toolHint && (
                // With the crosshair out its own label says the keys in words; the glyphs here would be read on top of it.
                <FloatingNote role={aim ? undefined : 'status'} aria-hidden={aim ? true : undefined} data-testid="review-tool-hint">
                  {toolHint}
                </FloatingNote>
              )}
            </div>
            <Elsewhere review={review} page={viewPage ?? 1} edge="below" canvas={canvasRef} onJump={jumpTo} />
            {earlier && !openAsk && !draft && !docked && (
              <div className="absolute top-4 left-1/2 z-40 -translate-x-1/2" data-testid="review-earlier-thread">
                {threadCard('detached')}
              </div>
            )}
            {chat && (
              <CursorChat
                userId={room.self?.userId ?? null}
                from={chat.from}
                bounds={() => canvasRef.current?.getBoundingClientRect() ?? null}
                // Above the viewer's pill and the chips of who is below, and on a
                // touch screen above the tools over the pill too.
                foot={touch ? 176 : 100}
                onChat={room.sendChat}
                onClose={() => setChat(null)}
              />
            )}
            {followedState && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 z-30 border-[3px]"
                style={{ borderColor: identityInk(followedState.userId) }}
              />
            )}
            {touch && (
              // On a touch screen the tools sit centred ABOVE the viewer's own
              // pill, at the thumb, each with its name under it.
              <FloatingToolbar className="pointer-events-auto absolute bottom-[4.75rem] left-1/2 z-30 -translate-x-1/2">
                {toolsPalette('touch')}
              </FloatingToolbar>
            )}
            <PdfDocumentView
              src={documentFileUrl(review.documentId)}
              title={documentName}
              focus={focus}
              onViewport={onViewport}
              // With a pointer, the tools lead the viewer's own pill: one bar at the foot.
              toolbarLead={touch ? undefined : toolsPalette(intro ? 'intro' : 'icons')}
              pageOverlay={(page) => (
                <ReviewPageLayer
                  page={page}
                  review={review}
                  focused
                  onPinByKeyboard={focusNextCard}
                  aim={aim && aim.page === page ? aim : null}
                  renderAsk={
                    docked ? undefined : (ask, { placement }) => <PilotiAnswerCard key={ask.id} review={review} ask={ask} placement={placement} />
                  }
                  renderThread={
                    docked
                      ? undefined
                      : ({ placement }) => (draft && draft.page !== page ? null : threadCard(placement))
                  }
                />
              )}
              className="size-full"
            />
          </div>
          <ReviewPanel review={review} onOpen={openFromList} onWalkProposals={walkProposals} />
        </div>
        {docked && (
          // Not modal: no veil over the drawing the card is about, and the page
          // stays in reach (another pin, a pinch). Only its × and Escape close it.
          <Sheet open={dockOpen} modal={false} onOpenChange={(next) => !next && closeCard()}>
            <SheetContent
              side="bottom"
              closeLabel={t('review.closeThread')}
              data-testid="review-card-sheet"
              onInteractOutside={(event) => event.preventDefault()}
              // The sheet is the card's frame: no second border inside it.
              className="max-h-[75dvh] gap-0 rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)]"
            >
              <SheetTitle className="sr-only">{documentName}</SheetTitle>
              <SheetDescription className="sr-only">{t('annotations.section')}</SheetDescription>
              {dockedAsk ? (
                <PilotiAnswerCard key={dockedAsk.id} review={review} ask={dockedAsk} placement="docked" />
              ) : (
                threadCard('docked')
              )}
            </SheetContent>
          </Sheet>
        )}
        {!listBeside && (
          <Sheet open={listOpen} onOpenChange={setListOpen}>
            <SheetContent
              side="bottom"
              closeLabel={t('review.close')}
              data-testid="review-list-sheet"
              className="flex h-[70dvh] flex-col gap-0 rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)] sm:mx-auto sm:max-w-xl"
            >
              <SheetHeader className="flex-row items-center gap-2 px-4 pt-4 pr-14 pb-0">
                <SheetTitle className="text-base">{t('annotations.section')}</SheetTitle>
                <SheetDescription className="sr-only">{documentName}</SheetDescription>
                {exportMenu && <div className="ml-auto">{exportMenu}</div>}
              </SheetHeader>
              <ReviewPanel
                review={review}
                presentation="sheet"
                // Choosing a mark shows it: the sheet steps aside for the page.
                onOpen={(annotation, byKeyboard) => {
                  setListOpen(false)
                  openFromList(annotation, byKeyboard)
                }}
                onWalkProposals={() => {
                  setListOpen(false)
                  walkProposals()
                }}
              />
            </SheetContent>
          </Sheet>
        )}
        <ReviewAnnouncer review={review} />
      </DialogContent>
    </Dialog>
  )
}
