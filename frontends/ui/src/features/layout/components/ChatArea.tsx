/**
 * ChatArea Component
 *
 * Main chat display area showing messages between user and assistant.
 * Includes the message list and is positioned in the center of the layout.
 *
 * Shows different welcome states based on authentication:
 * - Logged out: Prompt to sign in with CTA button
 * - Logged in: Ready to start chatting
 */

'use client'

import {
  type FC,
  memo,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useState,
  useMemo,
} from 'react'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { ArrowDown, Check, FileText, Lock, WifiOff } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  useChatStore,
  AgentPrompt,
  AgentResponse,
  ErrorBanner,
  UserMessage,
  ChatThinking,
  useElapsedSeconds,
  formatElapsed,
} from '@/features/chat'
import type { ChatMessage } from '@/features/chat'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'
import type { ThinkingEnding } from '@/features/chat/components/ChatThinking'
import type { TurnView } from '@/features/chat/lib/turn-fold'
import { useAnswerRevealStore } from '@/features/chat/stores/answer-reveal-store'
// Imported from its own module rather than the `@/features/chat` barrel so the
// shared-thread additions do not depend on that barrel's mock in existing specs.
import type { UserMessageAuthor } from '@/features/chat/components/UserMessage'
// From its own module rather than the `@/features/chat` barrel, for the same
// reason the collaboration imports above are: existing specs mock that barrel,
// and a new export on it would have to be added to every one of those mocks.
import { FollowUpsRail } from '@/features/chat/components/FollowUpsRail'
import { offersAktenvermerk } from '@/features/chat/lib/aktenvermerk-chip'
// Its own module rather than a barrel, for the reason FollowUpsRail is: the
// specs that mock `@/features/chat` must not have to know about the run block.
import type { Finding, Findings } from '@/lib/conversations/message-findings'
import { RunBlockMessage } from '@/features/runs/components/RunBlockMessage'
import { useCommissionRun } from '@/features/runs/hooks/use-commission-run'
import {
  continuationBrief,
  findingBrief,
  previousRunFindings,
} from '@/features/runs/lib/carry-forward'
import { AGENT_MENTION_ID } from '@/lib/mentions/types'
import { cn } from '@/lib/utils'
import { AwaitingBanner } from '@/features/collaboration/components/AwaitingBanner'
import { EngagementNotice } from '@/features/collaboration/components/EngagementNotice'
import { useMessageAnchor } from '@/features/collaboration/hooks/use-message-anchor'
import { MentionPeopleProvider } from '@/features/collaboration/context/mention-people'
import { HandbackOffer } from '@/features/collaboration/components/HandbackOffer'
import { useSharedThread } from '@/features/collaboration/hooks/use-shared-thread'
import { useSpectatedTurn } from '@/features/collaboration/hooks/use-spectated-turn'
import { SpectatedTurn } from '@/features/collaboration/components/SpectatedTurn'
import { TypingPresence } from '@/features/collaboration/components/TypingPresence'
import { useAwaitingState } from '@/features/collaboration/hooks/use-sharing'
import {
  AnimatePresence,
  motion,
  motionEntrance,
  motionInstant,
  motionQuick,
  motionQuickExit,
  motionSheetEnter,
  motionSheetExit,
} from '@/components/motion'
import type { Variants } from 'motion/react'
import { glideScrollTo, type GlideHandle } from '../lib/glide-scroll'
import { useAuth } from '@/adapters/auth'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { useShowReasoningSkills } from '@/lib/user-preferences/use-show-reasoning-skills'
import { WELCOME_OFFSET_FALLBACK } from '../hooks/use-composer-metrics'
import { isDisplayableMessage, isTransientConnectionError, selectThreadPhase } from '../lib/thread-phase'
import { readThreadPosition, rememberThreadPosition, type ThreadPosition } from '../lib/thread-positions'

/** How much of an answer the settle announcement reads out. */
const GIST_MAX_CHARS = 120

/**
 * What the settle announcement says the answer comes to: the verdict when the
 * answer earned one, else its first sentence, without Markdown or citation
 * marks, cut at a word.
 */
const answerGist = (answer: ChatMessage): string => {
  const verdict = answer.answerMeta?.verdict
  if (verdict) return `${verdict.subject}: ${verdict.value}`
  const plain = answer.content
    .replace(/\[\d+\]/g, '')
    .replace(/[#*_`>|~]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  const sentence = plain.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? plain
  if (sentence.length <= GIST_MAX_CHARS) return sentence
  const cut = sentence.slice(0, GIST_MAX_CHARS)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 0)) || cut}…`
}

/** Error cards that say the turn was not taken on, rather than that it failed. */
const REFUSAL_CODES: ReadonlySet<string> = new Set(['research.queue_full', 'budget.exhausted'])

/**
 * How a finished turn ended, when it is not simply „done": what the turn's own
 * terminal said first (a run commissioned, a refusal), then what the thread
 * shows (a run message, a refusal banner), then a failure.
 */
const turnEnding = (
  view: TurnView | undefined,
  turnMessages: ChatMessage[],
  failed: boolean
): ThinkingEnding | undefined => {
  if (view?.outcome === 'handed_off' || view?.result?.run || turnMessages.some((m) => m.runLedger)) {
    return 'handed_off'
  }
  const refusedByBanner = turnMessages.some(
    (m) => m.messageType === 'error' && REFUSAL_CODES.has(m.errorData?.errorCode ?? '')
  )
  if (view?.outcome === 'refused' || view?.result?.job_admission_rejected || refusedByBanner) return 'refused'
  return failed ? 'failed' : undefined
}

/** How long „Wieder verbunden" stays before the dock goes quiet again. */
const RECONNECTED_NOTE_MS = 2400

/** A question with no turn yet, without a new array per render. */
const NO_MESSAGES: ChatMessage[] = []

/** The thread list's `gap-4`, which a leaving row gives back. */
const ROW_GAP_PX = 16

/**
 * How long a live answer waits for the Herleitung above it to fold: the fold's
 * fade, then two frames for the height to drop while nothing is visible.
 */
const FOLD_HOLD_MS = (motionQuickExit.duration ?? 0.18) * 1000 + 34

/** `--composer-h` before the composer has measured itself (11rem). */
const COMPOSER_FALLBACK_PX = 176
/** The list's breathing room above the composer (its `+ 1.5rem` bottom padding). */
const LIST_END_GAP_PX = 24
/** Unseen content below, in px, before the jump button is worth showing. */
const UNSEEN_SLACK_PX = 24
/** A scroll this soon after the reader's own input is the reader's. */
const READER_SCROLL_MS = 300
/** A wheel or fling is still moving the thread this soon after its last event. */
const GESTURE_SETTLE_MS = 150
/** How long after a retry the re-sent question counts as a retry. */
const RETRY_ANCHOR_WINDOW_MS = 1000

/**
 * An element's top as laid out, without the vertical translate of an entrance
 * still playing on it. The thread row rises 4px as it arrives, and the anchor
 * measured mid-rise put the question 4px off for the rest of the turn.
 */
const layoutTop = (el: HTMLElement): number => {
  const top = el.getBoundingClientRect().top
  const transform = getComputedStyle(el).transform
  if (!transform || transform === 'none' || typeof DOMMatrixReadOnly === 'undefined') return top
  try {
    return top - new DOMMatrixReadOnly(transform).m42
  } catch {
    return top
  }
}

/**
 * The lowest line of the thread the reader can see: the viewport's foot less
 * the floating composer over it and the list's clearance above that (the
 * list's bottom padding is the composer's height plus 1.5rem, the same).
 */
const visibleBottom = (container: HTMLElement): number => {
  const composer = Number.parseFloat(getComputedStyle(container).getPropertyValue('--composer-h'))
  const covered = (Number.isFinite(composer) ? composer : COMPOSER_FALLBACK_PX) + LIST_END_GAP_PX
  return container.getBoundingClientRect().bottom - covered
}

interface ChatAreaProps {
  /** Whether the user is authenticated */
  isAuthenticated?: boolean
  /** Callback when sign in is clicked */
  onSignIn?: () => void
  /**
   * Whether the AgentResponse confidence chip renders (WorkOS
   * `chat-confidence-chip` flag, FB-6). Defaults to true (fail-open) so
   * existing callers/specs are unaffected.
   */
  showConfidenceChip?: boolean
  /**
   * Whether answers show the per-answer thumbs feedback row (WorkOS
   * `answer-feedback` flag, WS-7). Defaults to true (fail-open) so existing
   * callers/specs are unaffected.
   */
  showAnswerFeedback?: boolean
  /**
   * Whether the collaboration surfaces are reachable for this org (ADR-0032…0035,
   * dark-launched behind the per-org `collaboration` flag).
   *
   * **Defaults to false, and false means "exactly today"** (spec NF-8): no
   * conversation read, no live subscription, no authorship, no banners — the
   * local-first chat path is untouched. Even with the flag on, a conversation the
   * server reports as private keeps that path; only a shared one switches to the
   * server-authoritative one (ADR-0033).
   */
  canCollaborate?: boolean
}

/**
 * Main chat area container with scrollable message list.
 * Shows welcome state when no messages exist.
 */
export const ChatArea: FC<ChatAreaProps> = memo(function ChatArea({
  isAuthenticated = false,
  onSignIn,
  showConfidenceChip = true,
  showAnswerFeedback = true,
  canCollaborate = false,
}) {
  const {
    currentConversation,
    isStreaming,
    currentUserMessageId,
    isRecoveryPending,
  } = useChatStore(
    useShallow((s) => ({
      currentConversation: s.currentConversation,
      isStreaming: s.isStreaming,
      currentUserMessageId: s.currentUserMessageId,
      isRecoveryPending: s.isRecoveryPending,
    }))
  )
  // What the thread is: still being read from storage, loading its messages,
  // the empty canvas, or a thread. The same selector decides whether
  // `MainLayout` lifts the composer, so the two never disagree.
  const threadPhase = useChatStore(selectThreadPhase)
  const pendingMessagesFor = useChatStore((s) => s.pendingMessagesFor)
  const setPendingMessagesFor = useChatStore((s) => s.setPendingMessagesFor)
  // The stream ends before the answer's text is all on screen: the answer
  // finishes what its pace held back, then settles. The Herleitung's header
  // stays live until then (`answer-reveal-store.ts`); it folded long before,
  // when the answer's first words arrived, so the settle changes no height.
  const revealingId = useAnswerRevealStore((s) => s.revealingId)
  const turnLive = isStreaming || revealingId !== null
  // How each of this client's turns ENDED. Read for the Herleitung's status:
  // a turn that has no answer message is not therefore a lost one (a run was
  // handed off, a question refused, the reader pressed Stop).
  const turns = useChatStore((s) => s.turns)
  // Turns that FAILED here. The store drops a failed turn's view in the step
  // after the fold marks it (`failTurn`), before its error card is added, and
  // with neither on screen the turn read as lost: „Unterbrochen" and a
  // recovery spinner flashed in front of a failure. Noted as the fold marks it.
  const failedTurnIdsRef = useRef(new Set<string>())
  useEffect(() => {
    if (typeof useChatStore.subscribe !== 'function') return
    return useChatStore.subscribe((state) => {
      for (const view of Object.values(state.turns ?? {})) {
        if (view.phase === 'failed') failedTurnIdsRef.current.add(view.turnId)
      }
    })
  }, [])

  // The project this thread is scoped to. Read here for one reason: the
  // „Als Aktenvermerk schreiben" chip is only offered where a draft has
  // somewhere to be filed (ledger 23).
  const activeProjectId = useChatStore((s) => s.projectId)
  const setComposerPrefill = useChatStore((s) => s.setComposerPrefill)
  const stableStepsRef = useRef(new Map<string, StoredThinkingStep[]>())
  const dismissErrorCard = useChatStore((s) => s.dismissErrorCard)
  const retryLastUserMessage = useChatStore((s) => s.retryLastUserMessage)
  const t = useTranslations('research')
  const tCollaboration = useTranslations('collaboration')
  const { user } = useAuth()
  const currentUserId = user?.id ?? null
  // Fetched ONCE for the whole transcript and passed down to each answer.
  // Reading it inside AgentResponse would fire one GET per message and re-render
  // every answer when it settled; the list renders once, so the preference does.
  const { showReasoningSkills } = useShowReasoningSkills()

  // ── The ADR-0033 seam ───────────────────────────────────────────────────────
  // One hook owns "is this thread shared, load it from the server, keep it
  // reconciled". With `canCollaborate` false — the default — it does nothing at
  // all, so the local-first path below is byte-identical to today's.
  const {
    shared,
    myRole,
    loading: sharedLoading,
    accessLost,
    turnInFlight,
    clearTurnInFlight,
    noteTurnActivity,
    typists,
    unreadAfterMessageId,
    lastArrival,
    participants,
    engagement,
    engagementSuggestion,
    setEngagement,
    authorOf,
  } = useSharedThread({
    conversationId: currentConversation?.id ?? null,
    enabled: canCollaborate,
    currentUserId,
  })

  // ── Watching a colleague's turn (ADR-0039) ──────────────────────────────────
  // Only for a turn that is NOT this reader's: the asker already has the frames
  // on their own agent socket, and a second copy would render the answer twice.
  // Everything else — a private thread, a gated org, no turn running — resolves
  // to `enabled: false`, and the hook then opens no connection at all.
  const isForeignTurn = Boolean(
    shared && turnInFlight && turnInFlight.actorUserId !== currentUserId && !isStreaming
  )
  const { turn: spectatedTurn, live: spectatingLive } = useSpectatedTurn({
    conversationId: currentConversation?.id ?? null,
    enabled: isForeignTurn,
    // Every frame restarts the staleness clock. This used to be derived from
    // `answer.length` + `steps.length`, which stand still for the whole of a
    // single long tool call (the reducer merges repeats into the step it
    // already has) — so a six-minute `ris_search` looked like silence and the
    // banner was torn down mid-turn.
    onFrame: noteTurnActivity,
  })

  /*
    Two wires from the spectated stream back to the banner.

    FAILED clears it. A turn that dies without persisting an assistant message —
    cancelled, or a server-side persist that failed — never publishes `ended`,
    which is published as a side effect of that write, so the observer would
    otherwise sit behind a locked composer until the staleness clock ran out.

    DONE deliberately does NOT clear it. `done` is the terminal frame, which
    strictly precedes persistence — and the whole live view is gated on
    `turnInFlight`, so clearing on `done` unmounted the finished answer the
    observer was reading and left them blank until the persisted message landed a
    round trip later. On the very case this was written for (no persist at all)
    it threw away a completed answer and replaced it with nothing. The persisted
    message's own `ended` event is what clears it; until then the completed
    spectated answer stays on screen, which is the truthful thing to show.

    Any frame at all is evidence the turn is alive, which restarts the clock —
    that is what lets the timeout be short without cutting off a long turn. That
    wire is `onFrame` on the hook itself, below.
  */
  useEffect(() => {
    if (isForeignTurn && spectatedTurn?.phase === 'failed') clearTurnInFlight()
  }, [isForeignTurn, spectatedTurn?.phase, clearTurnInFlight])

  // One label, two renderings (the static banner and the live stream), so the
  // observer's headline cannot change wording just because frames started
  // arriving.
  const turnInFlightLabel = useMemo(() => {
    if (!turnInFlight) return ''
    if (turnInFlight.actorUserId && turnInFlight.actorUserId === currentUserId) {
      return tCollaboration('thread.turnInFlightYou')
    }
    return tCollaboration('thread.turnInFlight', {
      name: authorOf(turnInFlight.actorUserId)?.name ?? tCollaboration('inbox.unknownActor'),
    })
  }, [turnInFlight, currentUserId, authorOf, tCollaboration])

  // Stick-to-bottom scroll controller refs/state (replaces the old count-based
  // scrollIntoView). `scrollContainerRef` is the scroll viewport; `contentRef`
  // is the growing message list we observe for height changes. It excludes
  // the anchor spacer, which the observer itself resizes.
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // Whether growth below is FOLLOWED (auto-scroll). Kept in a ref (not just
  // state) so the ResizeObserver callback reads a fresh value without being
  // re-created on every scroll. Only the reader engages it: a scroll they drove
  // to the end of the content, or the jump-to-latest button. A scroll the page
  // caused (a clamp as a collapsing panel shrinks the list, a glide) never
  // does: reading a clamp as "the reader is at the bottom" chased a reader at
  // the settle, seven programmatic scrolls in a row (motion audit, 2026-10).
  const followRef = useRef(true)
  // When the reader last touched the scroll (wheel, touch, pointer, key), and
  // the scroll height at the last scroll event: together they tell a scroll the
  // reader drove from one the layout caused.
  const lastReaderInputRef = useRef(0)
  const lastScrollHeightRef = useRef(0)
  // A finger is on the thread. Following waits until it lifts and the fling's
  // scroll stops, so a programmatic scroll never fights a hand mid-gesture.
  const touchActiveRef = useRef(false)
  // The reader asked to follow the anchored turn by pressing jump-to-latest.
  const jumpedRef = useRef(false)
  // The pending follow scroll, so the anchor can cancel one queued before the
  // send (a stale rAF could otherwise cancel the send's glide).
  const followRafRef = useRef(0)
  // The running anchor glide, stopped by the reader's input or a thread swap.
  const glideRef = useRef<GlideHandle | null>(null)
  // When the reader last retried an errored answer: the re-sent question is
  // not glided to when it is already within a viewport of where it would land.
  const retryAtRef = useRef(-Infinity)
  // Rows whose removal must not animate (the error card a retry replaces).
  const instantExitIdsRef = useRef(new Set<string>())
  const [showScrollButton, setShowScrollButton] = useState(false)

  // ── New-question top-anchor bookkeeping (ChatGPT/Claude pattern) ────────────
  // When a NEW user message is sent we pin THAT message near the top of the
  // viewport and let the answer stream fill downward, instead of the stick-to-
  // bottom controller chasing the growing answer (which scrolled the question
  // off-screen). The anchored question's turn carries `data-chat-anchor` so the
  // effect can find it in the committed DOM (motion.div doesn't attach a
  // forwarded ref synchronously); `anchorSpacerRef` is an invisible min-height
  // block below the list that guarantees there is always enough scroll room to
  // bring the question to the top (imperatively sized, and refitted as the
  // answer grows, so it needs no extra render); `prevAnchorIdRef`
  // debounces the anchor so it fires once per newly-sent question (and never
  // on mount / session restore, where the opening effect below owns
  // scrolling).
  const anchorSpacerRef = useRef<HTMLDivElement>(null)
  // Whether a sent question is anchored to the top right now: from its send
  // until the thread is swapped. While it is, the spacer is kept FITTED
  // (`fitAnchorSpacer`) rather than a fixed viewport.
  const anchoredRef = useRef(false)
  // Latest reduced-motion preference for the anchor scroll (a JS scrollIntoView
  // overrides the CSS scroll-behavior gate, so honour it explicitly). Ref-held so
  // the anchor effect's deps stay tied to the turn id, not this preference.
  const prefersReducedMotion = useReducedMotion()
  const reducedMotionRef = useRef(prefersReducedMotion)
  reducedMotionRef.current = prefersReducedMotion

  // A thread row's motion. Built once; the refs are read when a row enters or
  // leaves, so a row's removal sees the retry that asked for it to be instant.
  //
  // Leaving, the row gives up its height with its opacity (and the list's gap
  // above it, as a negative margin), clipped while it goes. With
  // `presenceAffectsLayout={false}` nothing else closes the gap, and an
  // opacity-only exit left a hole for 180 ms and then snapped every row below.
  const rowEnter = prefersReducedMotion ? motionInstant : motionEntrance
  const rowLeave = prefersReducedMotion ? motionInstant : motionQuickExit
  const rowVariants = useMemo<Variants>(
    () => ({
      hidden: { opacity: 0, y: 4 },
      shown: () => ({
        opacity: 1,
        y: 0,
        transition: reducedMotionRef.current ? motionInstant : motionEntrance,
      }),
      leave: (id: string) => ({
        opacity: 0,
        height: 0,
        marginTop: -ROW_GAP_PX,
        overflow: 'hidden',
        transition:
          instantExitIdsRef.current.has(id) || reducedMotionRef.current
            ? motionInstant
            : motionQuickExit,
      }),
    }),
    []
  )

  const messages = currentConversation?.messages
  // Commissioning from inside the thread: an open finding to clear, or a
  // report to carry forward. Null when there is no project or conversation.
  const commissionRun = useCommissionRun(activeProjectId ?? null, currentConversation?.id ?? null)
  const commissionFromFinding = useCallback(
    async (finding: Finding): Promise<boolean> => {
      if (!commissionRun) return false
      const brief = findingBrief(finding)
      return commissionRun.commission(brief.question, brief.context)
    },
    [commissionRun]
  )
  const continueRun = useCallback(
    async (message: ChatMessage): Promise<void> => {
      if (!commissionRun) return
      const brief = continuationBrief(message)
      await commissionRun.commission(brief.question, brief.context, brief.documents)
    },
    [commissionRun]
  )

  // Filter to only show displayable message types in the chat area
  // Assistant text messages (full reports) are displayed in the Details Panel instead.
  // A dropped connection is not a message either: it is said by the quiet
  // status line above the composer (`connectionNote`), not by a card that
  // collapses out of the thread when the socket comes back.
  const displayableMessages = useMemo(
    () => (messages ?? []).filter(isDisplayableMessage),
    [messages]
  )
  const connectionLost = useMemo(() => (messages ?? []).some(isTransientConnectionError), [messages])

  const isEmpty = displayableMessages.length === 0
  // The skeleton, not the greeting, while the thread's messages are on their
  // way: from storage, from the server, or (for a first-time recipient of a
  // shared thread) from the shared read, whose history lands a moment after
  // the conversation is materialised empty.
  const sharedHistoryPending = shared && sharedLoading && isEmpty
  const showSkeleton = threadPhase === 'hydrating' || threadPhase === 'loading' || sharedHistoryPending
  const listReady = !showSkeleton
  // The shared read is a history fetch like the store's own, so it names the
  // thread pending in the store too: `MainLayout` reads the phase from there,
  // and decided "empty" on its own it lifted the composer over this skeleton.
  // Only a claim this view made is released here; a store fetch that named the
  // thread first clears its own (a release here would greet the reader while
  // it is still in flight). Before paint, so the two are never seen apart.
  const sharedPendingClaimRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    const id = currentConversation?.id ?? null
    if (sharedHistoryPending && id) {
      if (sharedPendingClaimRef.current === id || pendingMessagesFor === id) return
      sharedPendingClaimRef.current = id
      setPendingMessagesFor?.(id)
      return
    }
    const claimed = sharedPendingClaimRef.current
    if (!claimed) return
    sharedPendingClaimRef.current = null
    if (pendingMessagesFor === claimed) setPendingMessagesFor?.(null)
  }, [sharedHistoryPending, currentConversation?.id, pendingMessagesFor, setPendingMessagesFor])
  // Whether the list now on screen replaces the skeleton (the frame before was
  // the skeleton): only then does it fade in.
  const skeletonShownRef = useRef(showSkeleton)
  const listArrivesFromSkeleton = skeletonShownRef.current
  useEffect(() => {
    skeletonShownRef.current = showSkeleton
  }, [showSkeleton])

  // The connection, said quietly in the status dock: lost while this page
  // reconnects, then „Wieder verbunden" for a moment once it has. Derived from
  // the thread's transient connection errors, which the recovery hook dismisses
  // when the socket is back; a thread switch is not a reconnect.
  const [connectionNote, setConnectionNote] = useState<'lost' | 'restored' | null>(
    connectionLost ? 'lost' : null
  )
  const [connectionSeen, setConnectionSeen] = useState({
    conversationId: currentConversation?.id,
    lost: connectionLost,
  })
  if (connectionSeen.conversationId !== currentConversation?.id) {
    setConnectionSeen({ conversationId: currentConversation?.id, lost: connectionLost })
    setConnectionNote(connectionLost ? 'lost' : null)
  } else if (connectionSeen.lost !== connectionLost) {
    setConnectionSeen({ conversationId: currentConversation?.id, lost: connectionLost })
    setConnectionNote(connectionLost ? 'lost' : 'restored')
  }
  useEffect(() => {
    if (connectionNote !== 'restored') return
    const timer = setTimeout(() => setConnectionNote(null), RECONNECTED_NOTE_MS)
    return () => clearTimeout(timer)
  }, [connectionNote])

  /**
   * The other half of an inbox deep link: `#message-<id>` scrolls to the message
   * the notification was actually about, once it has rendered. Without it the
   * recipient arrives at the bottom of the thread with no idea which message
   * concerns them — and the inbox row is already marked read.
   */
  const anchoredMessageIds = useMemo(
    () => displayableMessages.map((m) => m.id),
    [displayableMessages]
  )
  // The thread the link landed in. Its opening position is the link's: the
  // bottom jump and the follow below must not move the reader off the message
  // the link was about (they used to, a frame after it landed).
  const deepLinkedConversationRef = useRef<string | undefined>(undefined)
  const { highlightedId: highlightedMessageId, isTargetPending } = useMessageAnchor(anchoredMessageIds, {
    conversationId: currentConversation?.id ?? null,
    // All of the thread is here: a target missing now is missing from it, and
    // stops holding the thread's placement and follow. Not while a shared
    // thread's history is still arriving, which is where an inbox link's
    // message usually is.
    ready: listReady && !sharedLoading,
    onLand: () => {
      deepLinkedConversationRef.current = currentConversation?.id
      glideRef.current?.stop()
      followRef.current = false
      jumpedRef.current = false
    },
  })

  // ── Multi-author bookkeeping (shared threads only) ──────────────────────────
  // Authorship per message, plus whether it CONTINUES a run by the same author.
  // Grouping is computed here rather than in the bubble because it is a property
  // of the sequence, not of a message: a run is broken by anyone else speaking and
  // by the agent answering in between.
  const authorship = useMemo(() => {
    const byMessageId = new Map<string, { author: UserMessageAuthor; grouped: boolean }>()
    if (!shared) return byMessageId

    let previousAuthorKey: string | null = null
    for (const message of displayableMessages) {
      const isUserMessage = message.messageType === 'user' || message.role === 'user'
      if (!isUserMessage) {
        // The agent answering ends the run: the next human message starts fresh.
        previousAuthorKey = null
        continue
      }

      // A user message with no author can only be one this browser just wrote —
      // the optimistic echo, before the server's copy (which carries the author)
      // has come back. Attributing it to the reader avoids a flash of "Someone".
      const userId = message.authorUserId ?? currentUserId ?? null
      const person = authorOf(userId)
      const key = userId ?? `unattributed:${message.id}`

      byMessageId.set(message.id, {
        author: {
          userId,
          name: person?.name ?? message.authorName ?? null,
          avatarUrl: person?.profilePictureUrl ?? message.authorAvatarUrl ?? null,
          isYou: Boolean(userId && currentUserId && userId === currentUserId),
        },
        grouped: key === previousAuthorKey,
      })
      previousAuthorKey = key
    }
    return byMessageId
  }, [shared, displayableMessages, authorOf, currentUserId])

  // Where the reader left off (spec CC-19). Anchored on the server-held read mark,
  // then advanced past the reader's OWN messages — a separator whose first item is
  // your own message would be telling you that you have not read yourself.
  //
  // The anchor is resolved against the FULL message list, not the displayable
  // subset: the read receipt marks the newest mapped message, which may be a full
  // report (rendered in the details panel, not here), and an anchor that cannot be
  // found would silently drop the divider on the next open.
  const unreadDividerBeforeId = useMemo(() => {
    if (!shared || !unreadAfterMessageId) return null
    const all = messages ?? []
    const anchorIndex = all.findIndex((m) => m.id === unreadAfterMessageId)
    if (anchorIndex < 0) return null
    const displayableIds = new Set(displayableMessages.map((m) => m.id))
    for (const message of all.slice(anchorIndex + 1)) {
      if (!displayableIds.has(message.id)) continue
      const mine = authorship.get(message.id)?.author.isYou === true
      if (!mine) return message.id
    }
    return null
  }, [shared, unreadAfterMessageId, messages, displayableMessages, authorship])

  // ── The hand-back offer (ADR-0034 addendum, the last transition) ────────────
  // The state machine is: asking Piloti → tag a human → waiting → they answer →
  // **hand back?** → asking Piloti. Every transition but the last one had a visible
  // affordance; this is the last one. The wait itself is read from the server, never
  // computed here, so this offer and the banner cannot disagree.
  const { awaiting, release } = useAwaitingState(
    currentConversation?.id ?? null,
    canCollaborate && shared
  )
  const threadAwaitsHuman = (awaiting?.pending.length ?? 0) > 0

  // Dismissal is per resolution point, so a later answer offers again.
  const [handbackDismissedFor, setHandbackDismissedFor] = useState<string | null>(null)

  /**
   * Whether the thread is sitting at a resolution point — and who answered.
   *
   * Derived from the thread itself rather than from a live transition, on purpose:
   * the asker usually arrives *after* the colleague answered (hours later, from
   * another device), and an offer that only existed in the browser that watched the
   * message land would be missing in exactly that case.
   */
  const handback = useMemo((): {
    anchorId: string
    people: Array<{ userId: string; name: string }>
  } | null => {
    if (!shared || threadAwaitsHuman) return null

    // Who this thread has actually ASKED. A message whose server-computed addressee
    // set names people and NOT the agent is the hand-off (MN-1/MN-2); the structured
    // mentions are the fallback for a message stored before that ruling was kept.
    const asked = new Set<string>()
    for (const message of displayableMessages) {
      if (message.addressees) {
        if (!message.addressees.agent) {
          for (const userId of message.addressees.users) asked.add(userId)
        }
        continue
      }
      const mentions = message.mentions ?? []
      if (mentions.length === 0) continue
      if (mentions.some((mention) => mention.targetId === AGENT_MENTION_ID)) continue
      for (const mention of mentions) asked.add(mention.targetId)
    }
    if (asked.size === 0) return null

    // The trailing run of messages by people who were asked. Anything else ends it:
    // the agent has already answered (nothing to hand back), or the reader had the
    // last word (they are mid-thought, and it is not their own answer to offer on).
    const answerers: Array<{ userId: string; name: string }> = []
    let anchorId: string | null = null
    for (let index = displayableMessages.length - 1; index >= 0; index -= 1) {
      const message = displayableMessages[index]
      const isUserMessage = message.messageType === 'user' || message.role === 'user'
      if (!isUserMessage) break
      const userId = message.authorUserId ?? null
      if (!userId || userId === currentUserId || !asked.has(userId)) break
      anchorId ??= message.id
      if (answerers.some((person) => person.userId === userId)) continue
      answerers.unshift({
        userId,
        name: authorOf(userId)?.name ?? message.authorName ?? tCollaboration('inbox.unknownActor'),
      })
    }
    if (!anchorId || answerers.length === 0) return null
    return { anchorId, people: answerers }
  }, [shared, threadAwaitsHuman, displayableMessages, currentUserId, authorOf, tCollaboration])

  const showHandback = handback !== null && handbackDismissedFor !== handback.anchorId

  /**
   * Accepting PRE-FILLS the composer and focuses it — it never sends. The message
   * has to stay honestly authored: a button that fired a turn would either put words
   * under the user's name that they did not write, or produce an answer to a question
   * nobody can see, in a thread several people read as a shared record.
   *
   * The `@Piloti` token rides along as a STRUCTURED mention: without it the
   * prefill would send as plain text and route by the engagement mode instead of
   * to the agent (MN-3 — a mention is never re-derived from text).
   */
  const handleHandback = useCallback(() => {
    if (!handback) return
    const agentName = tCollaboration('mentions.picker.agentName')
    setComposerPrefill(`@${agentName} ${tCollaboration('mentions.handback.prefill')}`, [
      { targetId: AGENT_MENTION_ID, display: agentName },
    ])
    setHandbackDismissedFor(handback.anchorId)
  }, [handback, setComposerPrefill, tCollaboration])

  /**
   * "Stattdessen Piloti fragen" from inside the wait (spec MN-9.3).
   *
   * Pre-fills rather than sending, for the same reason the hand-back offer does:
   * the message stays honestly authored, and a turn with no user-authored question
   * produces "Based on the discussion above…". A STRUCTURED `@Piloti` mention is
   * what releases the wait server-side — bare `@Piloti` text would not, so the
   * mention travels with the prefill.
   */
  const handleAskAgent = useCallback(() => {
    const agentName = tCollaboration('mentions.picker.agentName')
    setComposerPrefill(`@${agentName} `, [{ targetId: AGENT_MENTION_ID, display: agentName }])
  }, [setComposerPrefill, tCollaboration])

  /**
   * "Rückfrage an Matthias" — the reader was asked something they cannot answer
   * without more information.
   *
   * Pre-fills `@{asker} ` WITH its structured mention, which routes the message
   * as a mention: the asker's own request closes as `asked_back` rather than as
   * an answer they never gave, and the thread keeps waiting — on them. A
   * text-only prefill would send the same question as plain text, settle the
   * request, tell the asker "they answered", and hand the thread back to Piloti
   * in the middle of a human conversation.
   */
  const handleAskBack = useCallback(
    (asker: { userId: string; name: string }) => {
      setComposerPrefill(`@${asker.name} `, [{ targetId: asker.userId, display: asker.name }])
    },
    [setComposerPrefill]
  )

  // Entrance-animation bookkeeping: messages already present when a conversation
  // renders (hydration / session switch) must NOT animate in — only messages
  // appended afterwards get the fade-rise entrance. Seeded synchronously so the
  // very first render already knows which ids are "old".
  //
  // Seeded again when the thread's messages ARRIVE (the skeleton gives way to
  // the list): seeded while it loaded, the set was empty, and every message of
  // a thread opened from the server played its entrance as it landed.
  const hydratedIdsRef = useRef<Set<string> | null>(null)
  // The follow-ups rails already there at the seed: a restored rail is simply
  // there, only one a live stage delivers fades in.
  const hydratedRailIdsRef = useRef(new Set<string>())
  const hydratedConversationIdRef = useRef<string | undefined>(currentConversation?.id)
  const hydratedListReadyRef = useRef(listReady)
  // Questions whose Herleitung this view showed live. It stays for them after
  // the settle even when the turn took no step, because the header was the
  // working cue from the send: removing it at the settle would pull the answer
  // up by its height in the frame the turn ends.
  const liveShownIdsRef = useRef(new Set<string>())
  if (
    hydratedIdsRef.current === null ||
    hydratedConversationIdRef.current !== currentConversation?.id ||
    hydratedListReadyRef.current !== listReady
  ) {
    const sameThread = hydratedConversationIdRef.current === currentConversation?.id
    hydratedConversationIdRef.current = currentConversation?.id
    hydratedListReadyRef.current = listReady
    hydratedIdsRef.current = new Set(displayableMessages.map((m) => m.id))
    hydratedRailIdsRef.current = new Set(
      displayableMessages.filter((m) => m.stages?.followUps).map((m) => m.id)
    )
    if (!sameThread) liveShownIdsRef.current = new Set()
  }
  const hydratedIds = hydratedIdsRef.current
  // A colleague's answer, watched live, is swapped for its persisted row when
  // that lands. The swap is like for like (the same answer surface), so the
  // row is placed, not entered: an entrance there replayed the answer the
  // observer had just watched being written.
  if (spectatedTurn?.messageId) hydratedIds.add(spectatedTurn.messageId)

  // Each question's turn (the messages up to the next question), and the
  // React key of each row, in one pass over the thread. Derived per row inside
  // the render loop, it sliced the rest of the thread once per question on
  // every delta flush.
  //
  // A turn's answer row is keyed by its QUESTION, not by its own id: a turn
  // handed to a run swaps its answer for the run's message, a different id in
  // the same place, and keyed by id the row left and a new one entered in the
  // slot the reader was looking at (lifecycle L15).
  const threadLayout = useMemo(() => {
    const turnOf = new Map<string, ChatMessage[]>()
    const rowKeyOf = new Map<string, string>()
    let question: ChatMessage | null = null
    let answerKeyed = false
    for (const message of displayableMessages) {
      if (message.messageType === 'user' || message.role === 'user') {
        question = message
        answerKeyed = false
        turnOf.set(message.id, [])
        continue
      }
      if (!question) continue
      turnOf.get(question.id)?.push(message)
      if (message.messageType === 'agent_response' && !answerKeyed) {
        answerKeyed = true
        rowKeyOf.set(message.id, `answer:${question.id}`)
      }
    }
    return { turnOf, rowKeyOf, lastQuestionId: question?.id ?? null }
  }, [displayableMessages])

  /**
   * The Herleitung of a user message: the steps the turn's fold wrote onto it,
   * live or restored alike. A deep-research step is the run block's
   * (`RunBlockMessage`), not the turn's.
   */
  const getStepsForUserMessage = (messageId: string): StoredThinkingStep[] => {
    const steps = (currentConversation?.messages.find((m) => m.id === messageId)?.thinkingSteps ?? []).filter(
      (step) => step.scope !== 'deep'
    )
    // The filter builds a new array per call. Hand back the previous one while
    // its steps are the same objects, so the memoised ChatThinking of a turn that
    // did not change skips the render every delta flush of the live answer.
    const previous = stableStepsRef.current.get(messageId)
    if (previous && previous.length === steps.length && previous.every((step, i) => step === steps[i])) {
      return previous
    }
    stableStepsRef.current.set(messageId, steps)
    return steps
  }

  // ── The live turn ──────────────────────────────────────────────────────────
  // This client's current question and the answer it has drawn so far. Whether
  // that answer has begun decides the Herleitung's fold and the end of the
  // steps phase; its id decides which answer row waits for the fold.
  const currentTurnHasSteps = currentUserMessageId
    ? getStepsForUserMessage(currentUserMessageId).length > 0
    : false
  const currentTurn = useMemo(() => {
    if (!currentUserMessageId) return null
    const index = displayableMessages.findIndex((m) => m.id === currentUserMessageId)
    if (index < 0) return null
    const rest = displayableMessages.slice(index + 1)
    const nextQuestion = rest.findIndex((m) => m.messageType === 'user' || m.role === 'user')
    const messages = nextQuestion >= 0 ? rest.slice(0, nextQuestion) : rest
    const answer = messages.find((m) => m.messageType === 'agent_response')
    return {
      messages,
      answerId: answer?.id ?? null,
      // Begun the moment the answer has ANYTHING to draw: its masthead or a
      // card can arrive before its first word, and an answer that opened with
      // either used to render under the open panel and jump up by its height.
      answerBegun: Boolean(
        answer && (answer.content.trim() || answer.answerMeta || answer.cards?.some(Boolean))
      ),
      stopped: answer?.stopped === true,
      failed: answer?.failed === true,
      gist: answer ? answerGist(answer) : '',
    }
  }, [currentUserMessageId, displayableMessages])

  // Whether this turn's answer has EVER begun. A retraction empties the answer
  // and `answerBegun` goes false again, which reopened the Herleitung over the
  // answer's held frame (155 → 555 px, the answer pushed down by 248 px) only
  // to fold it again in one frame at the next round's first word. The answer
  // holds its own frame through a retraction now, so the panel stays folded.
  const [answerBegunFor, setAnswerBegunFor] = useState<string | null>(null)
  if (currentTurn?.answerBegun && currentUserMessageId && answerBegunFor !== currentUserMessageId) {
    setAnswerBegunFor(currentUserMessageId)
  }
  const answerHasBegun = Boolean(currentTurn?.answerBegun) || (currentUserMessageId !== null && answerBegunFor === currentUserMessageId)

  // The answer's first words fold the Herleitung above it, and the answer is
  // WITHHELD until that fold is done: mounted at once, its first line painted
  // below an open panel (below the fold, on most screens) and was then yanked
  // up by the panel's height, 400 px, as the reader started reading it. Held,
  // it mounts where it stays, directly under the folded bar. Only an answer
  // this view watched begin, under a Herleitung that had steps to fold, and
  // only one not on screen yet: an answer row a snapshot mounted before its
  // first word (its sources, no text) is already where it stays, and holding
  // it pulled it out of the thread and back in.
  //
  // The hold runs from the fold's start to its end, whatever the turn does
  // meanwhile: keyed on the live turn, a Stop or an end inside the fold
  // released it at once, and the answer mounted under the fading panel.
  const renderedIdsRef = useRef(new Set<string>())
  const foldStarts =
    turnLive &&
    currentTurnHasSteps &&
    currentTurn?.answerBegun &&
    currentTurn.answerId &&
    !hydratedIds.has(currentTurn.answerId) &&
    !renderedIdsRef.current.has(currentTurn.answerId)
      ? currentTurn.answerId
      : null
  const [foldHoldId, setFoldHoldId] = useState<string | null>(null)
  const [releasedHoldId, setReleasedHoldId] = useState<string | null>(null)
  if (foldStarts && foldStarts !== foldHoldId && foldStarts !== releasedHoldId) setFoldHoldId(foldStarts)
  useEffect(() => {
    if (!foldHoldId || releasedHoldId === foldHoldId) return
    const timer = setTimeout(
      () => setReleasedHoldId(foldHoldId),
      prefersReducedMotion ? 0 : FOLD_HOLD_MS
    )
    return () => clearTimeout(timer)
  }, [foldHoldId, releasedHoldId, prefersReducedMotion])
  const holdId = foldStarts ?? foldHoldId
  const heldAnswerId = holdId && releasedHoldId !== holdId ? holdId : null

  // The settle, said once (WCAG 4.1.3). One stable region for the thread's
  // lifetime, written only when this client's turn ends: a live region that
  // mounts with its text is not announced, and one written per frame would be
  // read per frame. The header's own status says what Piloti is doing; this
  // says the answer is there to be read, and what it comes to. A turn that
  // ended without an answer of its own says how, in the Herleitung's own word
  // for it: „Antwort fertig" over a failed answer, or over the provisional
  // message of a turn handed to a run, said the opposite of what happened.
  const [turnNote, setTurnNote] = useState({ live: turnLive, text: '' })
  if (turnNote.live !== turnLive) {
    let text = ''
    if (!turnLive && currentTurn && currentUserMessageId) {
      const view = turns?.[currentUserMessageId]
      const failed =
        currentTurn.failed ||
        view?.phase === 'failed' ||
        failedTurnIdsRef.current.has(currentUserMessageId) ||
        currentTurn.messages.some(
          (m) => m.messageType === 'error' && m.errorData?.errorCode !== 'agent.response_interrupted'
        )
      const ending = turnEnding(view, currentTurn.messages, failed)
      if (currentTurn.stopped) text = t('chatArea.status.stopped')
      else if (ending === 'failed') text = t('chatArea.status.failed')
      else if (ending === 'handed_off') text = t('chatArea.status.handedOff')
      else if (ending === 'refused') text = t('chatArea.status.refused')
      else if (!currentTurn.answerId) text = ''
      else if (currentTurn.gist) text = t('chatArea.status.answerReadyWith', { gist: currentTurn.gist })
      else text = t('chatArea.status.answerReady')
    }
    setTurnNote({ live: turnLive, text })
  }
  // The steps phase of an anchored turn: the reader is watching the Herleitung
  // grow under their question, and that growth is not "newer content below".
  const stepsPhaseRef = useRef(false)
  stepsPhaseRef.current = turnLive && !answerHasBegun
  const turnLiveRef = useRef(turnLive)
  turnLiveRef.current = turnLive

  // ── Scroll controller ──────────────────────────────────────────────────────
  // Follows growth below ONLY while the reader has asked for it (`followRef`),
  // so a reader who scrolled up to read is never yanked back down, and surfaces
  // the jump button when there is unseen content below.
  //
  // "Below" is measured to the END OF THE CONTENT (the anchor spacer's top),
  // not to the scroll height: while a question is anchored the spacer's room
  // sits under the content, and measured against the scroll height every live
  // turn read as "not at the bottom" and showed the button.

  /** How far the content's end lies below what the reader can see over the composer. */
  const unseenBelow = useCallback((): number => {
    const container = scrollContainerRef.current
    const spacer = anchorSpacerRef.current
    if (!container || !spacer) return 0
    return spacer.getBoundingClientRect().top - visibleBottom(container)
  }, [])

  /** Bring the content's end to just above the composer. */
  const scrollToContentEnd = useCallback(
    (behavior: ScrollBehavior) => {
      const el = scrollContainerRef.current
      if (!el) return
      const delta = unseenBelow()
      if (Math.abs(delta) < 1) return
      el.scrollTo({ top: el.scrollTop + delta, behavior })
    },
    [unseenBelow]
  )

  /** Show the jump button exactly while there is unseen content below. */
  const updateScrollButton = useCallback(() => {
    const show = !stepsPhaseRef.current && !followRef.current && unseenBelow() > UNSEEN_SLACK_PX
    setShowScrollButton((prev) => (prev === show ? prev : show))
  }, [unseenBelow])

  // The reader's hands on the scroll. A scroll event within READER_SCROLL_MS of
  // one of these (or of the previous reader-driven scroll, which carries a
  // touch fling's momentum) is the reader's; anything else the page caused.
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const touched = () => {
      lastReaderInputRef.current = performance.now()
    }
    const touchStart = () => {
      touchActiveRef.current = true
      touched()
    }
    const touchEnd = () => {
      touchActiveRef.current = false
      touched()
    }
    const events = ['wheel', 'touchmove', 'pointerdown'] as const
    for (const type of events) container.addEventListener(type, touched, { passive: true })
    container.addEventListener('touchstart', touchStart, { passive: true })
    container.addEventListener('touchend', touchEnd, { passive: true })
    container.addEventListener('touchcancel', touchEnd, { passive: true })
    window.addEventListener('keydown', touched)
    return () => {
      for (const type of events) container.removeEventListener(type, touched)
      container.removeEventListener('touchstart', touchStart)
      container.removeEventListener('touchend', touchEnd)
      container.removeEventListener('touchcancel', touchEnd)
      window.removeEventListener('keydown', touched)
    }
  }, [isEmpty, listReady])

  // The thread on screen, as the scroll bookkeeping last saw it (set by the
  // opening effect, below the anchor's).
  const shownConversationIdRef = useRef<string | undefined>(undefined)

  /**
   * Where the reader is, as the first row they can see: kept per thread, so a
   * thread switched away from and back to reopens where it was left.
   */
  const capturePosition = useCallback((): ThreadPosition | null => {
    const container = scrollContainerRef.current
    const content = contentRef.current
    if (!container || !content) return null
    if (unseenBelow() <= UNSEEN_SLACK_PX) return { atEnd: true }
    const top = container.getBoundingClientRect().top
    for (const row of content.querySelectorAll<HTMLElement>(':scope > [id^="message-"]')) {
      const rect = row.getBoundingClientRect()
      if (rect.bottom <= top) continue
      return { atEnd: false, messageId: row.id.slice('message-'.length), offsetTop: rect.top - top }
    }
    return null
  }, [unseenBelow])
  const positionRafRef = useRef(0)

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const now = performance.now()
    const heightChanged = el.scrollHeight !== lastScrollHeightRef.current
    lastScrollHeightRef.current = el.scrollHeight
    const readerDriven = !heightChanged && now - lastReaderInputRef.current < READER_SCROLL_MS
    if (readerDriven) {
      lastReaderInputRef.current = now
      // 80px of slack: a small nudge short of the end still counts as there.
      // While a question is anchored, reaching the end does not start
      // following on its own: the anchored layout is what the reader chose
      // by sending, and only the jump button trades it for following.
      const atEnd = unseenBelow() <= 80
      followRef.current = atEnd && (!anchoredRef.current || jumpedRef.current)
    }
    updateScrollButton()
    // Once a frame at most, and for the thread this scroll happened in: a
    // capture that ran after a swap would file the new thread's rows under it.
    const conversationId = shownConversationIdRef.current
    if (!conversationId || positionRafRef.current) return
    positionRafRef.current = requestAnimationFrame(() => {
      positionRafRef.current = 0
      if (shownConversationIdRef.current !== conversationId) return
      const position = capturePosition()
      if (position) rememberThreadPosition(conversationId, position)
    })
  }, [unseenBelow, updateScrollButton, capturePosition])

  // The spacer holds exactly the room the anchored turn has not filled yet: a
  // viewport minus the height from the question's top to the end of the list.
  // As the answer grows the spacer shrinks by the same amount, so the list's
  // scroll height never changes and nothing is ever clamped. A fixed viewport
  // released at the end of the stream did change it: the browser clamped the
  // scroll position and a short answer dropped by the room it had not used,
  // hundreds of pixels, the moment it finished (ADR-0066). So the spacer is
  // never released when the answer lands: what is left below a short answer
  // is the space that keeps its question at the top, and the next question or
  // a thread swap takes it. Idempotent, so the resize it causes settles on the
  // next observation. Measured without the row's entrance rise, which is a
  // transform the layout does not have.
  const fitAnchorSpacer = useCallback(() => {
    const container = scrollContainerRef.current
    const spacer = anchorSpacerRef.current
    if (!anchoredRef.current || !container || !spacer) return
    const target = container.querySelector<HTMLElement>('[data-chat-anchor="true"]')
    if (!target) return
    // The list's bottom padding (the composer's height plus a gap) is scroll
    // room as well. Counted, the spacer absorbs a composer that changes height
    // (it shrinks after a send): the padding gives up what the spacer takes,
    // the scroll height holds, and nothing is clamped.
    const padding = Number.parseFloat(getComputedStyle(spacer.parentElement ?? spacer).paddingBottom) || 0
    const filled = spacer.getBoundingClientRect().top - layoutTop(target)
    const room = `${Math.max(0, Math.round(container.clientHeight - filled - padding))}px`
    if (spacer.style.minHeight !== room) spacer.style.minHeight = room
  }, [])

  // Follow height growth (streaming tokens AND newly appended messages) via a
  // ResizeObserver on the list, while the reader follows. rAF + behavior:'auto'
  // rides a live answer's growth frame by frame; growth after the turn ended
  // (a post-answer stage, the follow-ups rail) glides instead of jumping, since
  // the reader is reading by then. When the reader is not following we don't
  // move them — the jump button surfaces instead. The viewport is observed
  // too: its height is the other input of the anchor spacer.
  useEffect(() => {
    const content = contentRef.current
    const viewport = scrollContainerRef.current
    if (!content) return
    // Only GROWTH means "newer content below". The observer also fires when the
    // list shrinks — collapsing a Herleitung or a code block above the viewport.
    let lastHeight = content.getBoundingClientRect().height
    const observer = new ResizeObserver((entries) => {
      let height = lastHeight
      let viewportResized = false
      for (const entry of entries) {
        if (entry.target === content) height = entry.contentRect.height
        else if (entry.target === viewport) viewportResized = true
      }
      const grew = height > lastHeight
      lastHeight = height
      fitAnchorSpacer()
      // A deep link still waiting for its message owns the position.
      if (followRef.current && (grew || viewportResized) && !isTargetPending()) {
        cancelAnimationFrame(followRafRef.current)
        followRafRef.current = requestAnimationFrame(() => {
          // Re-read at run time: the reader may have left, or a send anchored,
          // since this was queued. And not under a hand: while a finger is
          // down or a wheel/fling is still moving the thread, the reader's
          // scroll wins; the next growth after it ends follows again.
          if (!followRef.current) return
          const handOnScroll =
            touchActiveRef.current ||
            performance.now() - lastReaderInputRef.current < GESTURE_SETTLE_MS
          if (handOnScroll) return
          scrollToContentEnd(turnLiveRef.current || reducedMotionRef.current ? 'auto' : 'smooth')
        })
      }
      updateScrollButton()
    })
    observer.observe(content)
    if (viewport) observer.observe(viewport)
    // The composer's height reaches the list as `--composer-h` on an ancestor's
    // style, which no ResizeObserver here sees change: watch the attribute, on
    // every ancestor. Found by the variable, the host was missed whenever the
    // composer had not measured itself yet (the first thread after a mount), and
    // a composer that shrank after the send left the spacer unfitted.
    const composerWatch = new MutationObserver(() => fitAnchorSpacer())
    for (let host = viewport?.parentElement; host; host = host.parentElement) {
      composerWatch.observe(host, { attributes: true, attributeFilter: ['style'] })
    }
    return () => {
      cancelAnimationFrame(followRafRef.current)
      observer.disconnect()
      composerWatch.disconnect()
    }
    // Re-attach when the list mounts/unmounts (skeleton ↔ list ↔ welcome), and
    // per thread: the list's height measured in the last thread is not this
    // one's, and its first growth read as a shrink.
  }, [
    scrollToContentEnd,
    fitAnchorSpacer,
    updateScrollButton,
    isTargetPending,
    isEmpty,
    listReady,
    currentConversation?.id,
  ])

  useEffect(() => () => glideRef.current?.stop(), [])

  // A colleague's turn, watched live, is anchored like the reader's own: its
  // question at the top, the answer filling downward. Without it the observer
  // who was following the end chased the bottom of an answer they had not
  // asked for, the question scrolling off above. Only for an observer who was
  // at the end: following, or watching the last anchored turn with its end in
  // view (anchoring stops following, so asking for following alone anchored
  // the first colleague's turn and none after it). One reading further up is
  // not moved. The reader's own send takes the anchor back.
  const spectatorLive = isForeignTurn && spectatingLive
  const [spectatorAnchor, setSpectatorAnchor] = useState<{
    id: string
    sentId: string | null | undefined
  } | null>(null)
  /**
   * Whether the reader was at the end when this question arrived: its top, the
   * end of the content before it, is in view above the composer. Measured at
   * the new row rather than at the content's end, which the row itself has
   * just moved down by its height.
   */
  const sawQuestionArrive = useCallback(
    (questionId: string): boolean => {
      const container = scrollContainerRef.current
      const row = document.getElementById(`message-${questionId}`)
      if (!container || !row || !container.contains(row)) return false
      return layoutTop(row) - visibleBottom(container) <= UNSEEN_SLACK_PX
    },
    []
  )
  useEffect(() => {
    const questionId = threadLayout.lastQuestionId
    if (!spectatorLive || !questionId) return
    if (!followRef.current && !(anchoredRef.current && sawQuestionArrive(questionId))) return
    setSpectatorAnchor((previous) =>
      previous?.id === questionId ? previous : { id: questionId, sentId: currentUserMessageId }
    )
  }, [spectatorLive, threadLayout.lastQuestionId, currentUserMessageId, sawQuestionArrive])
  const anchorId =
    spectatorAnchor && spectatorAnchor.sentId === currentUserMessageId
      ? spectatorAnchor.id
      : currentUserMessageId
  const prevAnchorIdRef = useRef<string | null | undefined>(anchorId)

  // Anchor a NEWLY-sent user question near the TOP of the viewport and DISENGAGE
  // following, so the streaming answer fills downward from the question instead
  // of the controller chasing the bottom (which scrolled the question
  // off-screen). Runs only when `currentUserMessageId` transitions to a
  // brand-new id — never on mount / restore (prevAnchorIdRef is seeded with
  // the mount value). A layout effect so following stops, and a follow scroll
  // queued before the send is cancelled, BEFORE the ResizeObserver's
  // post-layout callback can act on the send's own growth. The scroll itself
  // waits a frame, so the question is measured where it landed (an error card
  // a retry removed has given up its height by then).
  useLayoutEffect(() => {
    const id = anchorId
    if (!id || id === prevAnchorIdRef.current) return
    prevAnchorIdRef.current = id
    const container = scrollContainerRef.current
    if (!container?.querySelector('[data-chat-anchor="true"]')) return
    followRef.current = false
    jumpedRef.current = false
    cancelAnimationFrame(followRafRef.current)
    glideRef.current?.stop()
    setShowScrollButton(false)
    // Guarantee the question can actually reach the top: reserve the scroll
    // room below it (imperative — no extra render). The streaming answer
    // consumes that room as it grows (`fitAnchorSpacer`).
    anchoredRef.current = true
    fitAnchorSpacer()
    const retry = performance.now() - retryAtRef.current < RETRY_ANCHOR_WINDOW_MS
    const raf = requestAnimationFrame(() => {
      const target = container.querySelector<HTMLElement>('[data-chat-anchor="true"]')
      if (!target) return
      fitAnchorSpacer()
      // scroll-mt on the anchored turn keeps clearance for the floating
      // toolbar pills, so the question lands just below them.
      const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0
      const top =
        container.scrollTop + layoutTop(target) - container.getBoundingClientRect().top - margin
      // A retried question is usually already in view, one card above where
      // its error was: moving it the last few hundred pixels reads as a jolt.
      if (retry && Math.abs(top - container.scrollTop) < container.clientHeight) return
      // Already there: a write would still count as a scroll the reader saw.
      if (Math.abs(top - container.scrollTop) < 1) return
      glideRef.current = glideScrollTo(container, top, {
        reducedMotion: reducedMotionRef.current,
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [anchorId, fitAnchorSpacer])

  // ── Opening a thread ───────────────────────────────────────────────────────
  // On a switch, the anchor and the follow state of the thread left go with it.
  // A layout effect, and the position set directly: a frame later (as this
  // was), the new thread painted once at the old one's scroll position and
  // then jumped.
  //
  // Not when the conversation is the one this send just created. The first
  // question of a new chat brings the conversation id in the same commit that
  // anchors the question (the anchor's layout effect, above, runs first), and
  // a reset here undid the anchor: the view chased the bottom of the growing
  // Herleitung, the question 2,900 px above it on a phone (Herleitung audit,
  // 2026-09).
  //
  // Where the thread opens, once its messages are here, in this order: the
  // message a deep link names (`useMessageAnchor` puts it there); in a shared
  // thread, where the reader left off (the unread divider); where the reader
  // was when they left it this session; else its end, or, when the last
  // turn is taller than the viewport, that turn's question, so a long answer
  // is read from its start rather than from its last line.
  const positionedConversationRef = useRef<string | null | undefined>(null)
  useLayoutEffect(() => {
    const id = currentConversation?.id
    if (shownConversationIdRef.current !== id) {
      const createdBySend = shownConversationIdRef.current === undefined && anchoredRef.current
      shownConversationIdRef.current = id
      cancelAnimationFrame(positionRafRef.current)
      positionRafRef.current = 0
      if (createdBySend) {
        positionedConversationRef.current = id
        return
      }
      glideRef.current?.stop()
      followRef.current = true
      jumpedRef.current = false
      setShowScrollButton(false)
      anchoredRef.current = false
      setSpectatorAnchor(null)
      if (anchorSpacerRef.current) anchorSpacerRef.current.style.minHeight = '0px'
      positionedConversationRef.current = null
      // The link's position held for its own visit. Coming back is a switch
      // like any other: kept, the thread was never placed again.
      deepLinkedConversationRef.current = undefined
    }
    const container = scrollContainerRef.current
    if (!id || !listReady || isEmpty || !container || positionedConversationRef.current === id) return
    positionedConversationRef.current = id

    if (isTargetPending() || deepLinkedConversationRef.current === id) {
      followRef.current = false
      return
    }
    const viewportTop = container.getBoundingClientRect().top
    // A row's scroll position, less its scroll margin (the floating toolbar's
    // clearance) when it is to land at the top.
    const rowTop = (rowId: string, { clearToolbar }: { clearToolbar: boolean }): number | null => {
      const row = document.getElementById(`message-${rowId}`)
      if (!row || !container.contains(row)) return null
      const margin = clearToolbar ? Number.parseFloat(getComputedStyle(row).scrollMarginTop) || 0 : 0
      return container.scrollTop + layoutTop(row) - viewportTop - margin
    }
    // One write, and none where the thread already is: each is a scroll the
    // reader did not make.
    const openAt = (top: number, { follow }: { follow: boolean } = { follow: false }) => {
      followRef.current = follow
      if (Math.abs(container.scrollTop - top) >= 1) container.scrollTop = top
    }
    // A thread switched back to mid-turn is anchored again, as it was: its
    // question held at the top and the answer filling down from it. Opened
    // at its end and following, it scrolled with every flush of the answer
    // (25 scrolls in one switch-and-back, motion audit 2026-10).
    const liveQuestion = turnLiveRef.current && anchorId ? rowTop(anchorId, { clearToolbar: true }) : null
    if (liveQuestion !== null) {
      anchoredRef.current = true
      fitAnchorSpacer()
    }
    if (unreadDividerBeforeId) {
      const top = rowTop(unreadDividerBeforeId, { clearToolbar: true })
      if (top !== null) return openAt(top)
    }
    const saved = readThreadPosition(id)
    if (saved && !saved.atEnd) {
      const top = rowTop(saved.messageId, { clearToolbar: false })
      if (top !== null) return openAt(top - saved.offsetTop)
    }
    if (liveQuestion !== null) return openAt(liveQuestion)
    const end = container.scrollHeight - container.clientHeight
    const lastQuestion = saved ? null : threadLayout.lastQuestionId
    const questionTop = lastQuestion ? rowTop(lastQuestion, { clearToolbar: true }) : null
    if (questionTop !== null && questionTop < end) openAt(Math.max(0, questionTop))
    else openAt(end, { follow: true })
    // Each input is read when its thread opens, not tracked: a later change of
    // the divider or the saved position must not move a thread being read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentConversation?.id, listReady, isEmpty])

  const handleScrollToLatest = useCallback(() => {
    glideRef.current?.stop()
    followRef.current = true
    jumpedRef.current = true
    setShowScrollButton(false)
    scrollToContentEnd(reducedMotionRef.current ? 'auto' : 'smooth')
  }, [scrollToContentEnd])

  // Retry an errored answer: clear the stale error card, then resend the last
  // user message through the live send path (or prefill the composer as a
  // fallback). The card goes FIRST and without its exit: it sits above where
  // the re-sent question lands, and a card that faded for 180 ms and then gave
  // up its height moved the just-anchored question up after it had arrived.
  const handleErrorRetry = useCallback(
    (messageId: string) => {
      instantExitIdsRef.current.add(messageId)
      // The retry also takes the failed turn's cut-off answer: it leaves with
      // the card, at once, for the same reason.
      for (const message of messages ?? []) {
        if (message.failed) instantExitIdsRef.current.add(message.id)
      }
      retryAtRef.current = performance.now()
      dismissErrorCard(messageId)
      retryLastUserMessage()
    },
    [retryLastUserMessage, dismissErrorCard, messages]
  )

  // Latency-gap typing indicator, shown at the bottom of the thread while a
  // HITL prompt (clarification, a Folgewege choice, a plan decision) the user
  // just answered waits for the turn to resume.
  //
  // Not for a just-sent question any more: from the send, the question's own
  // Herleitung header is the working cue (one object from send to settle, in
  // the place the reasoning will grow), so a typing bubble that a Herleitung
  // later replaced was a box swap.
  //
  // The answered prompt: `respondToPrompt` flips it to "received"
  // optimistically and `isStreaming` goes true the moment the reply is
  // sent, but that only says the answer LANDED — it says nothing about
  // Piloti having resumed. The Herleitung spinner for the turn, if any,
  // sits back at the TOP of the exchange (attached to the ORIGINAL user
  // message, not to whichever prompt is currently last), so on a
  // multi-round exchange it can be scrolled well out of view by the time
  // the reader answers the second or third question. Without a bottom
  // cue, an answered prompt just sits there looking finished — nothing
  // on screen says the turn is still going — until the next thing
  // eventually appears.
  const showTypingPlaceholder = useMemo(() => {
    if (!isStreaming) return false
    const last = displayableMessages[displayableMessages.length - 1]
    if (!last) return false
    return last.messageType === 'prompt' && !!last.isPromptResponded
  }, [isStreaming, displayableMessages])

  return (
    // Mentions in message text resolve to a person through this, so a pill can
    // answer "who is that?" without the reader leaving the thread. Disabled in a
    // solo conversation, where it resolves nothing and pills stay plain (NF-8).
    <MentionPeopleProvider
      participants={participants}
      currentUserId={currentUserId}
      agentName={tCollaboration('mentions.picker.agentName')}
      enabled={shared}
    >
      {/* Non-scrolling wrapper: anchors the floating "scroll to latest" button so
          it stays pinned to the viewport instead of scrolling away with content. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="scrollbar-hide flex flex-1 flex-col overflow-y-auto overscroll-contain"
          // A named, focusable region, so a keyboard reader can scroll the
          // thread. Not `role="log"`: a log announces every addition, and the
          // live answer adds words every frame. The settle is announced once,
          // below.
          role="region"
          tabIndex={0}
          aria-label={t('chatArea.ariaMessages')}
        >
          {/* Access revoked while viewing: the fallback shows the local copy, so
              without this the thread simply freezes with no explanation. */}
          {accessLost && (
            <div
              role="status"
              className="text-muted-foreground mx-auto mt-3 w-full max-w-5xl px-4 text-sm sm:px-6"
            >
              {tCollaboration('thread.accessLost')}
            </div>
          )}
          {/* Loading skeleton (C5): the persisted thread hasn't rehydrated yet,
              or the open thread's messages are on their way (`showSkeleton`).
              A lightweight grey-bubble placeholder — never a flash of the
              WelcomeState for a reader whose conversation is about to load in.
              The same holds for a first-time RECIPIENT of a shared thread: the
              conversation is materialised empty and the server history lands a
              moment later.

              It leaves as the list arrives, the two overlapping (`popLayout`):
              the skeleton fades on the exit easing while the list fades in over
              it, so the swap is a cross-fade, not a cut. */}
          <AnimatePresence initial={false} mode="popLayout">
            {showSkeleton && (
              <motion.div
                key="skeleton"
                className="flex flex-1 flex-col"
                exit={{ opacity: 0, transition: rowLeave }}
              >
                <MessageListSkeleton />
              </motion.div>
            )}
          </AnimatePresence>
          {!showSkeleton && (
            <>
              {/* The greeting LEAVES rather than disappearing. Sending the first
                message swaps this whole plane in one commit — greeting out,
                transcript in, composer down to the floor — and the reader is
                looking straight at the greeting when it happens, because it is
                what sits above the input they just typed into.

                `mode="popLayout"` is what makes the two overlap: the outgoing
                greeting is lifted out of the flow, so the transcript takes the
                plane immediately instead of waiting behind a fade. It drifts
                DOWN as it goes, with the composer, rather than up and away from
                it — the whole empty-canvas group descends and dissolves while
                the conversation arrives above it.

                The offset it is bottom-aligned against is frozen for exactly
                this reason (see `useComposerMetrics`): every number under it
                changes in the same tick. */}
              <AnimatePresence initial={false} mode="popLayout">
                {isEmpty && (
                  <motion.div
                    key="welcome"
                    className="flex flex-1 flex-col"
                    // Its arrival mirrors its exit: a new chat brings the greeting
                    // UP as the composer rises to meet it, the reverse of the drift
                    // down a first send gives it. Opening on an empty canvas plays
                    // nothing (`initial={false}` on the presence above).
                    initial={{ opacity: 0, y: 16 }}
                    animate={{
                      opacity: 1,
                      y: 0,
                      transition: prefersReducedMotion ? motionInstant : motionSheetEnter,
                    }}
                    exit={{ opacity: 0, y: 16 }}
                    transition={prefersReducedMotion ? motionInstant : motionSheetExit}
                  >
                    <WelcomeState
                      isAuthenticated={isAuthenticated}
                      onSignIn={onSignIn}
                      inProject={Boolean(activeProjectId)}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
              {!isEmpty && (
                // Bottom padding tracks the floating composer's REAL height (published
                // as --composer-h by MainLayout's ResizeObserver) plus a breathing gap,
                // so the last message/Herleitung never renders behind the composer no
                // matter how tall it grows. The 11rem fallback matches the old pb-44.
                <motion.div
                  // Top padding reserves clearance for the floating toolbar pills that
                  // overlay the top of this scroll plane, so the first message never
                  // renders behind them — a little extra on mobile where the pills sit
                  // edge-to-edge over the full-width column.
                  // The side padding keeps clear of a landscape phone's notch.
                  //
                  // Fades in when it replaces the loading skeleton (the other half
                  // of that cross-fade); otherwise it is simply there.
                  initial={listArrivesFromSkeleton ? { opacity: 0 } : false}
                  animate={{ opacity: 1, transition: rowEnter }}
                  className="mx-auto flex w-full max-w-5xl flex-col gap-4 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-20 sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pt-14"
                  style={{ paddingBottom: 'calc(var(--composer-h, 11rem) + 1.5rem)' }}
                >
                  {/* The observed list holds the messages and nothing else. The
              anchor spacer below is its sibling: the observer refits the spacer,
              and a spacer inside the observed box resized it again at the same
              depth, a "ResizeObserver loop" error once per frame. */}
                  <div ref={contentRef} className="flex flex-col gap-4">
                    {/* `presenceAffectsLayout={false}`: nothing in the list uses
                        layout animation, and with the default each row got a new
                        PresenceContext on every render, which re-rendered every
                        `motion.*` inside every earlier answer through context,
                        past MessageRenderer's memo: 920 fibers and 69 ms per delta
                        flush in a 40-message thread on a 4× throttled phone
                        (React performance audit, 2026-09). */}
                    {/* Keyed by the conversation: a thread swap replaces the whole
                        presence, so the rows of the thread left are gone in the
                        same commit. Keyed per row only, they all played their exit
                        for 180 ms beside the new thread's rows. */}
                    <AnimatePresence
                      key={currentConversation?.id ?? 'draft'}
                      initial={false}
                      presenceAffectsLayout={false}
                    >
                      {displayableMessages.map((message) => {
                        const isUserMessage =
                          message.messageType === 'user' || message.role === 'user'
                        const messageSteps = isUserMessage ? getStepsForUserMessage(message.id) : []
                        const hasThinkingSteps = messageSteps.length > 0

                        // The asker's live turn shows its Herleitung FROM THE SEND:
                        // its header is the working cue, and the reasoning grows
                        // into the same object. One object from send to settle,
                        // never a typing bubble swapped for a panel.
                        const isCurrentlyStreaming =
                          isUserMessage && turnLive && message.id === currentUserMessageId
                        if (isCurrentlyStreaming) liveShownIdsRef.current.add(message.id)
                        const showHerleitung =
                          isUserMessage &&
                          (hasThinkingSteps || liveShownIdsRef.current.has(message.id))

                        // This question's turn: the messages up to the next question.
                        const turnMessages = (isUserMessage && threadLayout.turnOf.get(message.id)) || NO_MESSAGES

                        // Derive post-thinking state. Priority: isThinking (active) >
                        // isWaiting (HITL) > isInterrupted > stopped > done.
                        const shouldCheckPostState = isUserMessage && !isCurrentlyStreaming

                        // Waiting: an unresponded HITL prompt follows this user message
                        const isWaiting =
                          shouldCheckPostState &&
                          turnMessages.some(
                            (m) => m.messageType === 'prompt' && !m.isPromptResponded
                          )

                        // Real data threaded into the Herleitung's assessment node:
                        // the turn's answer (confidence + citations). The live turn's
                        // answer is left out: that node describes a finished answer.
                        const agentMsg = shouldCheckPostState
                          ? turnMessages.find(
                              (m) => m.messageType === 'assistant' || m.messageType === 'agent_response'
                            )
                          : undefined

                        // Interrupted means LOST: the turn ended with no answer and
                        // nothing that explains why. The turn's own ending decides
                        // when this client saw it — any outcome it recorded
                        // (answered, refused, handed off to a run, stopped, a queue
                        // rejection) or a failure, which has its own error card. Only
                        // a turn this client lost track of (it drops those) falls back
                        // to the thread: a run's message is a response, and an error
                        // card other than the "connection lost" one already says what
                        // went wrong.
                        const turnView = turns?.[message.id]
                        const explainedByError = turnMessages.some(
                          (m) =>
                            m.messageType === 'error' &&
                            m.errorData?.errorCode !== 'agent.response_interrupted'
                        )
                        const hasResponse =
                          agentMsg !== undefined || turnMessages.some((m) => m.runLedger)
                        // A failed answer (or a failed phase) is a failure, never
                        // an interruption: the fold drops a failed turn's view, and
                        // until the error card landed the header read
                        // „Unterbrochen" with a recovery spinner, the wrong cause.
                        const failedHere =
                          Boolean(agentMsg?.failed) ||
                          turnView?.phase === 'failed' ||
                          failedTurnIdsRef.current.has(message.id)
                        const isInterrupted =
                          shouldCheckPostState &&
                          !isWaiting &&
                          !hasResponse &&
                          turnView === undefined &&
                          !explainedByError &&
                          !failedHere
                        const isStopped =
                          shouldCheckPostState &&
                          (agentMsg?.stopped === true || turnView?.outcome === 'cancelled')
                        // A turn that ended without an answer of its own is not
                        // „Fertig": a failed one has its error card below, one
                        // handed to a run has only started that run's work, and
                        // a refused one did none.
                        const endedAs = shouldCheckPostState
                          ? turnEnding(turnView, turnMessages, failedHere || explainedByError)
                          : undefined

                        // The answer has begun on the live turn: the Herleitung folds
                        // to its header, which stays live until the settle.
                        const answering = isCurrentlyStreaming && answerHasBegun

                        // Whether this ANSWER earns the „Als Aktenvermerk schreiben"
                        // chip — a walkthrough or a ruling, in a project, long enough
                        // that the reader is already thinking about where to put it
                        // (`features/chat/lib/aktenvermerk-chip`). Decided in the
                        // answer's own row, once it has settled: decided in the
                        // question's row, the chip's rail mounted BETWEEN the
                        // Herleitung and the answer at the settle and pushed the
                        // answer down by its height.
                        const answerSettled =
                          message.messageType === 'agent_response' &&
                          !message.isStreaming &&
                          revealingId !== message.id
                        const aktenvermerk =
                          answerSettled &&
                          offersAktenvermerk({
                            kind: message.answerMeta?.kind,
                            projectId: activeProjectId,
                            body: message.content,
                          })

                        // Withheld while the Herleitung above it folds (`heldAnswerId`).
                        if (message.id === heldAnswerId) return null
                        renderedIdsRef.current.add(message.id)

                        // The just-sent question's turn is the top-anchor target on send.
                        const isAnchorTarget = isUserMessage && message.id === anchorId

                        const messageAuthorship = authorship.get(message.id)

                        return (
                          <motion.div
                            key={threadLayout.rowKeyOf.get(message.id) ?? message.id}
                            // The deep-link target (`#message-<id>`). Every message carries
                            // it, not just mentions: an inbox item can point at any message,
                            // and a link that resolves for some rows and not others is worse
                            // than none.
                            id={`message-${message.id}`}
                            data-chat-anchor={isAnchorTarget ? 'true' : undefined}
                            className={cn(
                              'flex scroll-mt-20 flex-col gap-4 sm:scroll-mt-14',
                              // The arrival mark: says "this is the one" for a beat, then
                              // fades. A ring rather than a background, so it reads on the
                              // user bubble and the answer card alike. The transition is
                              // on every row and only the ring toggles: carried by the
                              // marked state alone, the transition left with the mark,
                              // and the ring vanished in one frame instead of fading.
                              'ring-offset-background duration-quick rounded-xl ring-offset-4 transition-shadow ease-out motion-reduce:transition-none',
                              highlightedMessageId === message.id && 'ring-warning/50 ring-2'
                            )}
                            // The row OWNS the turn's entrance: a fade and a 4px rise on
                            // the entrance pair, for genuinely new messages only —
                            // hydrated ones render in place. Its children carry none: a
                            // CSS `animate-in` plays on every mount, so a restored
                            // thread replayed every bubble's entrance, and on a new
                            // message it stacked with this one.
                            custom={message.id}
                            variants={rowVariants}
                            initial={hydratedIds.has(message.id) ? false : 'hidden'}
                            animate="shown"
                            exit="leave"
                          >
                            {/* Where the reader left off, in a shared thread (spec CC-19). */}
                            {unreadDividerBeforeId === message.id && (
                              <UnreadDivider label={tCollaboration('thread.unreadDivider')} />
                            )}

                            {/* Render the message */}
                            <MessageRenderer
                              message={message}
                              conversationId={currentConversation?.id}
                              projectId={activeProjectId}
                              previousFindings={
                                message.runLedger
                                  ? previousRunFindings(messages ?? [], message.id)
                                  : undefined
                              }
                              onCommissionFinding={
                                commissionRun ? commissionFromFinding : undefined
                              }
                              onContinueRun={commissionRun ? continueRun : undefined}
                              onErrorDismiss={dismissErrorCard}
                              onErrorRetry={handleErrorRetry}
                              showConfidenceChip={showConfidenceChip}
                              showAnswerFeedback={showAnswerFeedback}
                              showReasoning={showReasoningSkills}
                              author={messageAuthorship?.author}
                              grouped={messageAuthorship?.grouped}
                              currentUserId={currentUserId}
                              promptAddresseeName={
                                message.promptFor
                                  ? (authorOf(message.promptFor)?.name ?? null)
                                  : null
                              }
                            />

                            {/* Assistant-side thread spine: the Herleitung shares the
                        answer card's width and left alignment, so the reasoning and
                        the answer stack as ONE left column (the user bubble stays
                        right-aligned). Shown from the send, open while the turn
                        works, folded to its one-line bar when the answer's first
                        words arrive; the bar stays live until the settle, which
                        then changes only its status. */}
                            {showHerleitung && (
                              <div className="w-full">
                                <ChatThinking
                                  steps={messageSteps}
                                  isThinking={isCurrentlyStreaming}
                                  // Open while the turn works and has steps to show;
                                  // folded the moment the answer begins.
                                  autoOpen={isCurrentlyStreaming && hasThinkingSteps && !answering}
                                  answering={answering}
                                  since={message.timestamp}
                                  answerDurationMs={agentMsg?.answerDurationMs}
                                  isWaiting={isWaiting}
                                  isInterrupted={isInterrupted}
                                  isStopped={isStopped}
                                  endedAs={endedAs}
                                  isRecoveryPending={isRecoveryPending}
                                  enabledDataSources={message.enabledDataSources}
                                  messageFiles={message.messageFiles}
                                  userQuestion={message.content}
                                  answerConfidence={agentMsg?.answerConfidence}
                                  citations={agentMsg?.citations}
                                  escalationReason={agentMsg?.escalationReason}
                                  retrievalLedger={agentMsg?.retrievalLedger}
                                />
                              </div>
                            )}

                            {/* The questions this answer made askable, BELOW the
                        answer and outside its surface — the product owner's
                        ruling, and §6 of docs/architecture/post-answer-stages.md.
                        Same column, same edges, same full width as the answer and
                        the Herleitung; no new layout concept.

                        LAST in the message column on purpose. A stage delivers
                        this seconds after the answer, so it appears under a
                        reader who is already reading — and it may do that without
                        reserving space only because nothing sits below it to
                        move. The other half of that guarantee (nothing below it
                        in the THREAD either, the answer no longer streaming, the
                        reader not already typing) is enforced where the stage
                        arrives, in `lib/turn-projection.ts`. */}
                            {/* One more chip beside them, decided in the browser: the
                        offer to file this answer as an Aktenvermerk. It rides the
                        rail rather than getting a surface of its own, because it
                        is the same gesture the questions are (fill the composer,
                        the reader presses send) and a second block under the
                        answer would be a second thing to learn. Decided in the
                        answer's row once it has settled, so the chip cannot
                        appear mid-stream, and appears below the answer. */}
                            {(message.stages?.followUps || aktenvermerk) && (
                              <FollowUpsRail
                                items={message.stages?.followUps?.items}
                                offerAktenvermerk={aktenvermerk}
                                // Only a rail that arrives under the reader fades in:
                                // on a restored or reopened thread it is simply there.
                                animateIn={
                                  !hydratedIds.has(message.id) ||
                                  (Boolean(message.stages?.followUps) && !hydratedRailIdsRef.current.has(message.id))
                                }
                              />
                            )}
                          </motion.div>
                        )
                      })}
                    </AnimatePresence>

                    {/* The routing rule for a message that tags nobody (ADR-0036).
                In `mention` mode it states the rule where the question occurs —
                "why didn't Piloti answer that?" — and offers the way back. In `ask`
                mode, which is the default and stays the default, it is silent unless
                the server suggests otherwise, and then it OFFERS rather than
                announces: a thread must not rewire who answers next on its own.
                Above the banner because this is the standing rule while the banner
                is a transient state. */}
                    {shared && (
                      <EngagementNotice
                        mode={engagement}
                        suggestion={engagementSuggestion}
                        onChange={setEngagement}
                        canChange={myRole !== 'viewer'}
                      />
                    )}

                    {/* The thread is WAITING on a named person (spec MN-8). Without this
                mounted, the agent's silence has no explanation on screen, and
                "Ohne Antwort weitermachen" — the release that ADR-0034 names as the
                mitigation for its own worst risk, a wait nobody ever answers — has no
                affordance at all. The component existed, was tested and was
                screenshotted for a while before anything rendered it; unit-green is
                not reachable.

                Mutually exclusive with the hand-back offer by construction: this
                returns null once `pending` is empty, which is exactly when the offer
                becomes eligible. */}
                    {/* Entrance owned here, like a thread row's: only a wait that
                        begins while the thread is open arrives; one already
                        pending when it opens is simply there. */}
                    <AnimatePresence initial={false}>
                      {shared && threadAwaitsHuman && (
                        <motion.div
                          key="awaiting"
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0, transition: rowEnter }}
                          exit={{ opacity: 0, transition: rowLeave }}
                        >
                          <AwaitingBanner
                            awaiting={awaiting}
                            onRelease={release}
                            onAskAgent={handleAskAgent}
                            onAskBack={handleAskBack}
                          />
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* The colleague has answered and Piloti is out of the loop — the one
                moment the thread is worth handing on, and until now the only
                transition with no affordance on screen (see HandbackOffer). Anchored
                here, directly under the answer it is about. */}
                    <AnimatePresence initial={false}>
                      {showHandback && handback && (
                        <motion.div
                          key="handback"
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0, transition: rowEnter }}
                          exit={{ opacity: 0, transition: rowLeave }}
                        >
                          <HandbackOffer
                            people={handback.people}
                            onAccept={handleHandback}
                            onDismiss={() => setHandbackDismissedFor(handback.anchorId)}
                          />
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Latency-gap typing indicator (before the first token arrives) */}
                    {showTypingPlaceholder && <TypingIndicator />}

                    {/* The agent is working for SOMEONE in this thread (spec CC-13). Without
                this an observer sees a thread where nothing appears to be happening
                and a composer that will not take their question. Suppressed while
                this client is itself streaming — the asker already has the typing
                indicator and the Herleitung.

                Two renderings of the same fact, and the LIVE one is preferred: when
                the agent's frames are reaching this observer (ADR-0039) they watch
                the answer being written, and the banner is what remains when they
                are not — a gated org, no shared cache tier, a dropped stream, or the
                first moments before the first token. `spectatingLive` is the switch,
                and it only turns on once there is something to show, so the banner is
                never replaced by an empty box. */}
                    {shared &&
                      turnInFlight &&
                      !isStreaming &&
                      !showTypingPlaceholder &&
                      (spectatingLive && spectatedTurn ? (
                        <SpectatedTurn
                          turn={spectatedTurn}
                          label={turnInFlightLabel}
                          // The turn's id is its question's: the observer's
                          // timer counts from the question, as the asker's does.
                          since={messages?.find((m) => m.id === spectatedTurn.turnId)?.timestamp}
                        />
                      ) : (
                        <TurnInFlightBanner label={turnInFlightLabel} />
                      ))}

                    {/* A colleague writing while you are reading is a change you must be able
                to learn about without eyes. Polite, so it never interrupts. Keyed on
                the message id so a SECOND arrival from the same person is a fresh
                node — identical text in a mutated region is not re-announced. */}
                    <div
                      key={lastArrival?.messageId ?? 'none'}
                      className="sr-only"
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      {shared && lastArrival
                        ? tCollaboration('thread.authorAria', {
                            name:
                              lastArrival.authorName ??
                              authorOf(lastArrival.authorUserId)?.name ??
                              tCollaboration('inbox.unknownActor'),
                          })
                        : ''}
                    </div>

                    {/* This client's own turn ending, said once (`turnNote`). */}
                    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                      {turnNote.text}
                    </div>
                  </div>

                  {/* Top-anchor spacer: invisible, zero-height by default. While a
              sent question is anchored to the top it holds exactly the room the
              answer has not filled yet (`fitAnchorSpacer`), shrinking as the
              answer grows. It is kept, fitted, when the stream ends; the next
              question or a thread swap takes it. */}
                  {/* `overflow-anchor: none`: the browser must never pick the
              spacer as its scroll anchor. It is resized every frame of a live
              answer, and an anchor on it scrolled the page to follow it. */}
                  <div
                    ref={anchorSpacerRef}
                    aria-hidden="true"
                    style={{ minHeight: 0, overflowAnchor: 'none' }}
                  />
                </motion.div>
              )}
            </>
          )}
        </div>

        {/* The status dock: one quiet line just above the composer, in the gap
            the list always keeps there (its bottom padding is the composer's
            height plus 1.5rem). Out of the thread's flow, so nothing in it moves
            the thread: a colleague at a keyboard (the line used to sit at the
            end of the list and bobbed it by its height every time someone
            started or stopped typing) and the connection's state (the card it
            replaces collapsed out of the thread on reconnect). */}
        <div
          className="pointer-events-none absolute inset-x-0 z-10 mx-auto flex w-full max-w-5xl items-end pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))]"
          style={{ bottom: 'calc(var(--composer-h, 11rem) + 0.125rem)' }}
          data-testid="thread-status-dock"
        >
          <AnimatePresence initial={false} mode="popLayout">
            {connectionNote ? (
              <motion.div
                key={connectionNote}
                className="bg-background/85 text-muted-foreground flex h-6 items-center gap-1.5 rounded-md px-2 text-xs"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: rowEnter }}
                exit={{ opacity: 0, transition: rowLeave }}
              >
                {connectionNote === 'restored' ? (
                  <Check className="text-success size-3.5" aria-hidden="true" />
                ) : (
                  <WifiOff className="size-3.5" aria-hidden="true" />
                )}
                {connectionNote === 'restored'
                  ? t('chatArea.connection.restored')
                  : t('chatArea.connection.lost')}
              </motion.div>
            ) : (
              shared &&
              typists.length > 0 && (
                <motion.div
                  key="typing"
                  className="bg-background/85 rounded-md px-2"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: rowEnter }}
                  exit={{ opacity: 0, transition: rowLeave }}
                >
                  {/* A colleague at a keyboard. Distinct vocabulary from the
                      agent's banner (see TypingPresence), and independent of it:
                      somebody may well start writing while Piloti is answering. */}
                  <TypingPresence typists={typists} className="py-0" />
                </motion.div>
              )
            )}
          </AnimatePresence>
          {/* Said once per change, politely; mounted for the thread's life so
              a change is announced (a region that mounts with its text is not).
              A live region, not a `status` role: it says nothing about the
              thread's content and must not read as one of its messages. */}
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {connectionNote === 'restored'
              ? t('chatArea.connection.restored')
              : connectionNote === 'lost'
                ? t('chatArea.connection.lost')
                : ''}
          </span>
        </div>

        {/* Floating "scroll to latest" button — appears when the user has scrolled
          up and newer content is below. Pinned to the wrapper (not the scroll
          content) so it stays put while the thread scrolls behind it. Above the
          status dock while it speaks. */}
        <AnimatePresence>
          {showScrollButton && (
            <motion.div
              className="pointer-events-none absolute inset-x-0 z-10 flex justify-center"
              style={{
                bottom: `calc(var(--composer-h, 11rem) + ${connectionNote || (shared && typists.length > 0) ? '2.25rem' : '1rem'})`,
              }}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={prefersReducedMotion ? motionInstant : motionQuick}
            >
              <button
                type="button"
                onClick={handleScrollToLatest}
                aria-label={t('chatArea.scrollToLatest')}
                className="bg-card text-muted-foreground hover:text-foreground duration-snap pointer-events-auto flex size-9 items-center justify-center rounded-lg border shadow-md transition-colors ease-out motion-reduce:transition-none"
              >
                <ArrowDown className="size-4" aria-hidden="true" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MentionPeopleProvider>
  )
})

/**
 * Message renderer that dispatches to the correct component based on message type
 */
interface MessageRendererProps {
  message: ChatMessage
  /** Id of the conversation these messages belong to (for the memory chip). */
  conversationId?: string | null
  /** The active project — the run block reads its live ledger through it. */
  projectId?: string | null
  onErrorDismiss?: (messageId: string) => void
  /** Resend the last user message + dismiss this error card (retry affordance). */
  onErrorRetry?: (messageId: string) => void
  /** Whether the AgentResponse confidence chip renders (feature-flagged). */
  showConfidenceChip?: boolean
  /** Whether the AgentResponse thumbs feedback row renders (feature-flagged). */
  showAnswerFeedback?: boolean
  /** The reader's showReasoningSkills preference (fetched once by ChatArea). */
  showReasoning?: boolean
  /**
   * Who wrote this message. Present ONLY in a shared thread — absent means "render
   * exactly as before", which is what keeps a solo thread unchanged.
   */
  author?: UserMessageAuthor
  /** This message continues a run by the same author (no repeated header). */
  grouped?: boolean
  /** The reader, so a mention of them can be marked in the text. */
  currentUserId?: string | null
  /** Who a restored prompt was addressed to, for the read-only line (ADR-0037). */
  promptAddresseeName?: string | null
  /** The previous run's findings in this thread, for a report's change marks. */
  previousFindings?: Findings
  /** Commission a run to clear an open finding; absent when the thread cannot. */
  onCommissionFinding?: (finding: Finding) => Promise<boolean>
  /** „Bericht fortschreiben" for a finished run's message. */
  onContinueRun?: (message: ChatMessage) => Promise<void>
}

const MessageRendererComponent: FC<MessageRendererProps> = ({
  message,
  conversationId,
  projectId,
  onErrorDismiss,
  onErrorRetry,
  showConfidenceChip = true,
  showAnswerFeedback = true,
  showReasoning = false,
  author,
  grouped,
  currentUserId,
  promptAddresseeName,
  previousFindings,
  onCommissionFinding,
  onContinueRun,
}) => {
  const tFileStatus = useTranslations('research')
  const messageType = message.messageType || (message.role === 'user' ? 'user' : 'assistant')

  switch (messageType) {
    case 'user':
      return (
        <UserMessage
          content={message.content}
          timestamp={message.timestamp}
          author={author}
          grouped={grouped}
          mentions={message.mentions}
          currentUserId={currentUserId}
        />
      )

    case 'prompt':
      return (
        <AgentPrompt
          content={message.content}
          options={message.promptOptions}
          isResponded={message.isPromptResponded}
          response={message.promptResponse}
          timestamp={message.timestamp}
          // `promptFor` is present only on a prompt restored from the server
          // (ADR-0037). Absent means a live prompt, where this browser holds the
          // socket and IS the addressee. Present and not us means a colleague's
          // question: read-only, because the agent tier refuses our answer anyway.
          isAddressee={!message.promptFor || message.promptFor === currentUserId}
          addresseeName={promptAddresseeName}
        />
      )

    case 'agent_response': {
      // Short answers from the agent displayed in the chat area. Built once,
      // here, because a RUN's message renders the same card beneath its block
      // once the run has a report — and the prop mapping must exist in one place.
      const answer = (
        <AgentResponse
          content={message.content}
          timestamp={message.timestamp}
          answerDurationMs={message.answerDurationMs}
          cards={message.cards}
          citations={message.citations}
          conversationId={conversationId}
          // Both feed the „Piloti hat sich gemerkt" chip, which is now a fact
          // about THIS TURN rather than a poll of the conversation's memory:
          // the reflection stage's frame lands on `stages`, and a
          // `memory_proposal` counts only once `cardInteractions` says the
          // reader said yes.
          cardInteractions={message.cardInteractions}
          stages={message.stages}
          answerMeta={message.answerMeta}
          findings={message.findings}
          previousFindings={previousFindings}
          onCommissionFinding={onCommissionFinding}
          answerConfidence={message.answerConfidence}
          answerConfidenceCappedReason={message.answerConfidenceCappedReason}
          answerConfidenceReason={message.answerConfidenceReason}
          citationsRemoved={message.citationsRemoved}
          readSources={message.readSources}
          researchTruncated={message.researchTruncated}
          truncationReason={message.truncationReason}
          degradedReasons={message.degradedReasons}
          skillsActivated={message.skillsActivated}
          skillsHidden={message.skillsHidden}
          showReasoning={showReasoning}
          showConfidenceChip={showConfidenceChip}
          messageId={message.id}
          showAnswerFeedback={showAnswerFeedback}
          isStreaming={message.isStreaming}
          stopped={message.stopped === true}
          // A turn that failed under a written answer: the words stay, marked
          // as cut off, and stop typing at the failure.
          failed={message.failed === true}
          routingDecision={message.routingDecision}
          retrievalLedger={message.retrievalLedger}
          quoteStamps={message.quoteStamps}
        />
      )
      // A message that carries a run ledger IS a run (ADR-0062): the block
      // renders from the ledger, and the answer card above becomes the report
      // beneath it once the run has one. Nothing else about the message
      // changes — same row, same id, same deep-link target.
      //
      // The answer card is now the whole of it. The Python worker still stamps
      // `deep_research_job_id` into every run message's metadata, and that used
      // to reach `AgentResponse` as `jobId` and grow a "Bericht anzeigen"
      // button on the finished block — a door that opened the legacy research
      // panel OVER the run it belongs to. `AgentResponse` no longer takes those
      // props, so the report is read where the reader already is.
      if (message.runLedger) {
        return (
          <RunBlockMessage
            message={message}
            projectId={projectId}
            conversationId={conversationId}
            answer={answer}
            onContinue={onContinueRun ? () => onContinueRun(message) : null}
          />
        )
      }
      return answer
    }

    case 'file':
      // File operation messages show upload/ingest status. The wire status is
      // never shown raw: anything this build cannot word falls back to
      // "Available" rather than leaking `success`/`deleted` into the thread.
      if (!message.fileData) {
        return null
      }
      // FileCard was removed in an earlier refactor — file display is handled
      // by FileSourceCard in the panel; the thread keeps this status line.
      const fileStatus = message.fileData.fileStatus
      const fileStatusLabel =
        fileStatus === 'uploading'
          ? tFileStatus('fileSourceCard.statusUploading')
          : fileStatus === 'ingesting'
            ? tFileStatus('fileSourceCard.statusIngesting')
            : fileStatus === 'success'
              ? tFileStatus('fileSourceCard.statusAvailable')
              : fileStatus === 'error'
                ? tFileStatus('fileSourceCard.statusError')
                : tFileStatus('fileSourceCard.statusAvailable')
      return (
        <div
          className="bg-muted shadow-xs flex items-center gap-2 rounded-xl px-4 py-2"
          role="status"
        >
          <FileText className="text-muted-foreground size-4" aria-hidden="true" />
          <span className="text-muted-foreground text-sm">
            {message.fileData.fileName} ({fileStatusLabel})
          </span>
        </div>
      )

    case 'error':
      // Error banners (dismissable)
      if (!message.errorData) {
        return null
      }
      return (
        <ErrorBanner
          code={message.errorData.errorCode}
          message={message.errorData.errorMessage}
          details={message.errorData.errorDetails}
          timestamp={message.timestamp}
          onDismiss={onErrorDismiss ? () => onErrorDismiss(message.id) : undefined}
          onRetry={onErrorRetry ? () => onErrorRetry(message.id) : undefined}
        />
      )

    case 'assistant':
      // Assistant messages (full reports) are not shown in chat area
      // They are displayed in the Details Panel instead
      return null

    default:
      return null
  }
}

/**
 * Memoized so a per-token store update (which streams into ONE message) only
 * re-renders that one bubble, not every message in the thread.
 *
 * The messages store rebuilds only the object of the message it mutates and
 * preserves references for all others (`[...messages.slice(0, -1), updated]`),
 * so message-object identity is an exact, load-bearing signal that this
 * message's id/content/isStreaming (and every other field) is unchanged. We
 * pair it with the small set of scalar/callback props the renderer actually
 * uses — all of which are stable across renders.
 */
const areMessageRendererPropsEqual = (
  prev: MessageRendererProps,
  next: MessageRendererProps
): boolean =>
  prev.message === next.message &&
  prev.message.id === next.message.id &&
  prev.message.content === next.message.content &&
  prev.message.isStreaming === next.message.isStreaming &&
  prev.conversationId === next.conversationId &&
  prev.projectId === next.projectId &&
  prev.previousFindings === next.previousFindings &&
  prev.onCommissionFinding === next.onCommissionFinding &&
  prev.onContinueRun === next.onContinueRun &&
  prev.showConfidenceChip === next.showConfidenceChip &&
  prev.showAnswerFeedback === next.showAnswerFeedback &&
  prev.showReasoning === next.showReasoning &&
  // Authorship is derived per render (from the roster + the reader), so compare
  // its fields rather than the object — otherwise every roster refresh would
  // re-render every bubble in the thread.
  prev.grouped === next.grouped &&
  prev.currentUserId === next.currentUserId &&
  Boolean(prev.author) === Boolean(next.author) &&
  prev.author?.userId === next.author?.userId &&
  prev.author?.name === next.author?.name &&
  prev.author?.avatarUrl === next.author?.avatarUrl &&
  prev.author?.isYou === next.author?.isYou &&
  prev.onErrorDismiss === next.onErrorDismiss &&
  prev.onErrorRetry === next.onErrorRetry

const MessageRenderer = memo(MessageRendererComponent, areMessageRendererPropsEqual)
MessageRenderer.displayName = 'MessageRenderer'

/**
 * "New" separator marking where the reader left off in a shared thread (spec
 * CC-19). A rule with a centred label rather than a coloured band: it has to be
 * findable when scrolling a long thread without competing with the messages, and
 * it must not read as an error state.
 *
 * Deliberately the house eyebrow (hairline border + uppercase muted label), not
 * full-strength ink: this is a *reading-position* marker, and at ink weight it was
 * the loudest thing in the column — out-shouting the agent's answer, which is the
 * one element that must stay dominant. The two full-width rules are what make it
 * findable; the label does not have to shout to be one.
 */
const UnreadDivider: FC<{ label: string }> = ({ label }) => (
  <div
    className="flex items-center gap-3"
    role="separator"
    aria-label={label}
    data-testid="unread-divider"
  >
    <span className="bg-border h-px flex-1" aria-hidden="true" />
    <SectionLabel>{label}</SectionLabel>
    <span className="bg-border h-px flex-1" aria-hidden="true" />
  </div>
)

/**
 * "Piloti is answering <name>'s question" — the observer's view of a turn that is
 * not theirs (spec CC-13).
 *
 * This is now the FALLBACK rather than the whole story: with the frame relay in
 * place (ADR-0039) an observer watches the answer being written, and `SpectatedTurn`
 * renders it. The banner is what remains when the frames cannot reach them — no
 * shared cache tier, a dropped stream, or simply the first moments before the first
 * token. It is not a lesser version of the feature: what matters most is that the
 * wait is explained, because without it a second participant sees a thread where
 * nothing is happening and a composer that will not take their question, which reads
 * as a broken product rather than a busy one.
 *
 * It says *the assistant is working*, not *somebody is typing*: the Piloti glyph
 * plus the shimmering label — this app's own vocabulary for a turn in progress
 * (`TypingIndicator`, the Herleitung spine) — rather than the three bouncing dots
 * of a messenger, which describe a human at a keyboard and would frame Piloti as
 * one more participant in a group chat. A status strip at the house radius, not a
 * chat bubble.
 */
const TurnInFlightBanner: FC<{ label: string }> = ({ label }) => (
  <div
    className="bg-card shadow-xs flex min-h-9 w-fit items-center gap-2 rounded-lg border px-3.5 py-2"
    role="status"
    data-testid="turn-in-flight"
  >
    <ShimmerText className="text-xs font-medium">{label}</ShimmerText>
  </div>
)

/**
 * Latency-gap typing indicator (three pulsing dots) shown under an answered
 * HITL prompt until the turn resumes. Left-aligned to match assistant bubbles.
 */
const TypingIndicator: FC = () => {
  const t = useTranslations('research')
  const label = t('chatArea.status.thinking')
  // Mounted when the reader answers the prompt, so counting from mount is the
  // true time since that answer.
  const elapsed = useElapsedSeconds(true)
  return (
    <div
      className="animate-in fade-in-0 bg-muted duration-base flex min-h-9 w-fit items-center gap-2 rounded-2xl px-3.5 py-2.5 ease-out motion-reduce:animate-none"
      role="status"
      aria-label={label}
    >
      <span className="flex items-center gap-1 motion-reduce:hidden" aria-hidden="true">
        {/* CSS, not a JS loop: transform and opacity run on the compositor,
            so the dots cost the main thread nothing while a phone waits. */}
        <span className="animate-typing-dot bg-muted-foreground/70 size-1.5 rounded-full" />
        <span className="animate-typing-dot bg-muted-foreground/70 size-1.5 rounded-full" />
        <span className="animate-typing-dot bg-muted-foreground/70 size-1.5 rounded-full" />
      </span>
      <span
        className="text-muted-foreground hidden text-xs motion-reduce:inline"
        aria-hidden="true"
      >
        …
      </span>
      {/* Always word the wait (shimmering), and surface elapsed seconds once
          past a couple of seconds so a slow first token never feels stalled. */}
      <ShimmerText className="text-xs font-medium">{label}</ShimmerText>
      {/* aria-hidden: inside a status region, a figure that changes every
          second was re-announced every second. */}
      {elapsed > 2 && (
        <span className="text-muted-foreground text-xs tabular-nums" aria-hidden="true">
          {formatElapsed(elapsed)}
        </span>
      )}
    </div>
  )
}

/**
 * Hydration skeleton (C5): a few grey bubbles sized to the message area, shown
 * only while the persisted chat store rehydrates so a returning user never sees
 * a WelcomeState flash before their thread loads in.
 */
const MessageListSkeleton: FC = () => {
  const t = useTranslations('research')
  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 pt-20 sm:px-6 sm:pt-14"
      style={{ paddingBottom: 'calc(var(--composer-h, 11rem) + 1.5rem)' }}
      role="status"
      aria-label={t('chatArea.loading')}
      aria-busy="true"
    >
      {/* user bubble (right) */}
      <div className="flex justify-end">
        <Skeleton className="h-10 w-1/2 rounded-lg" />
      </div>
      {/* assistant answer card (left): a tab-width bar and a footer line around
          the body, mirroring the answer card's shape rather than a bare slab */}
      <div className="flex justify-start">
        <div className="flex w-4/5 flex-col gap-2">
          <Skeleton className="h-4 w-20 rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-3 w-1/3 rounded-lg" />
        </div>
      </div>
      {/* user bubble (right) */}
      <div className="flex justify-end">
        <Skeleton className="h-10 w-1/3 rounded-lg" />
      </div>
    </div>
  )
}

/**
 * Welcome state shown when no messages exist.
 *
 * Signed in: a time-of-day greeting (with the user's first name when known),
 * hero-sized per the click dummy, and nothing else unless the thread is about a
 * named file. It used to carry a subtitle and a row of example questions too;
 * both were addressed to a first-timer and were paid for by every user on every
 * new thread forever. What replaces them is the composer itself, lifted off the
 * floor to sit with the greeting as one group in the middle of the screen (see
 * `useComposerMetrics`) — an empty canvas that offers the one thing there is to
 * do, rather than explaining it.
 *
 * Signed out: a compact sign-in prompt. Bottom padding in both keeps the
 * centered content clear of the floating composer, and is what the lift is
 * calculated against — do not change one without the other.
 */
interface WelcomeStateProps {
  isAuthenticated?: boolean
  onSignIn?: () => void
  /**
   * The canvas belongs to a project, so the one sentence about what Piloti can
   * do with it is true here. Outside a project there is nowhere for a draft to
   * be filed, and the sentence would be an offer the surface cannot keep.
   */
  inProject?: boolean
}

/** Time-of-day bucket for the greeting (morning / afternoon / evening). */
const greetingKeyForHour = (hour: number): 'morning' | 'afternoon' | 'evening' => {
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
}

const WelcomeState: FC<WelcomeStateProps> = ({
  isAuthenticated = false,
  onSignIn,
  inProject = false,
}) => {
  const t = useTranslations('research')
  const tChat = useTranslations('chat')
  const { user } = useAuth()
  const composerSubject = useChatStore((s) => s.composerSubject)
  const tFiles = useTranslations('files')

  if (!isAuthenticated) {
    return (
      <div
        className="flex flex-1 items-end justify-center px-4 pt-20 sm:pt-16"
        style={{ paddingBottom: `var(--welcome-offset, ${WELCOME_OFFSET_FALLBACK})` }}
      >
        <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
          <div className="bg-muted text-brand flex size-12 items-center justify-center rounded-xl border">
            <Lock className="size-5" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{t('chatArea.loggedOutTitle')}</h1>
          <p className="text-muted-foreground text-sm">{t('chatArea.loggedOutBody')}</p>
          <Button onClick={onSignIn} aria-label={t('chatArea.signInSso')}>
            {t('chatArea.signInSso')}
          </Button>
        </div>
      </div>
    )
  }

  const greeting = tChat(`greeting.${greetingKeyForHour(new Date().getHours())}`)
  const firstName = user?.name?.trim().split(/\s+/)[0]
  const heading = firstName ? tChat('greeting.withName', { greeting, name: firstName }) : greeting

  return (
    <div
      // Bottom-aligned against the composer's ACTUAL top edge — its height plus
      // however far it has been lifted off the floor, plus a gap, all published
      // as one measured number (`--welcome-offset`). That leaves the greeting
      // exactly one gap above the input by construction, whatever the lift
      // turns out to be and whatever this column's own top padding is. Both of
      // those defeated an earlier version that centred here and worked the
      // clearance out arithmetically: it omitted the `pt-20`, and the composer
      // landed on the greeting on a phone.
      className="flex flex-1 flex-col items-center justify-end px-6 pt-20 sm:pt-16"
      style={{ paddingBottom: `var(--welcome-offset, ${WELCOME_OFFSET_FALLBACK})` }}
    >
      {/* Hero greeting — the one larger moment in the app, and the only place
          the ramp's 23px step is used (design language, "Type ramp"). The
          project-grounded starters live in their own plan (categorized,
          backend-driven) — until they land, the canvas stays quiet rather
          than showing static examples. */}
      <h1 className="text-foreground text-center text-[23px] font-semibold tracking-tight">
        {heading}
      </h1>

      {/* The chat is about one file: say which. A named file is the state of
          THIS canvas, and it is not recoverable from anything else on
          screen. */}
      {composerSubject && (
        <p className="text-muted-foreground mt-2 max-w-md text-center text-sm leading-relaxed">
          {tFiles('assignment.welcomeAbout', {
            name: composerSubject.title?.trim() || tFiles('assignment.thisFile'),
          })}
        </p>
      )}

      {/* One sentence, and only in a project: that Piloti WRITES. The canvas is
          otherwise deliberately quiet (the starters were cut for costing every
          user on every new thread), and this earns its place because it is the
          product's least discoverable capability — today it is found only by
          someone who happens to phrase a request as a commission (ledger 23).
          Below the file line, because a named subject is the state of THIS
          canvas and this is a standing fact about the project.

          Not shown when the thread is about one file: that reader has already
          been told what this canvas is for, and two grey sentences under a
          greeting is a paragraph. */}
      {inProject && !composerSubject && (
        <p className="text-muted-foreground mt-3 max-w-md text-center text-sm leading-relaxed">
          {tChat('greeting.projectWrites')}
        </p>
      )}
    </div>
  )
}
