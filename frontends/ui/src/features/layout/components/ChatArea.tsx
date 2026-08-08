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
import { ArrowDown, FileText, Lock, Sparkles } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import {
  useChatStore,
  AgentPrompt,
  AgentResponse,
  ErrorBanner,
  DeepResearchBanner,
  UserMessage,
  ChatThinking,
  useElapsedSeconds,
  formatElapsed,
} from '@/features/chat'
import type { ChatMessage, StatusType } from '@/features/chat'
// Imported from its own module rather than the `@/features/chat` barrel so the
// shared-thread additions do not depend on that barrel's mock in existing specs.
import type { UserMessageAuthor } from '@/features/chat/components/UserMessage'
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
import { AnimatePresence, motion, fadeRise, springGentle } from '@/components/motion'
import { useAuth } from '@/adapters/auth'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useTranslations } from '@/i18n'

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
    currentStatus,
    hasHydrated,
    isRecoveryPending,
  } = useChatStore(
    useShallow((s) => ({
      currentConversation: s.currentConversation,
      isStreaming: s.isStreaming,
      currentUserMessageId: s.currentUserMessageId,
      currentStatus: s.currentStatus,
      hasHydrated: s.hasHydrated,
      isRecoveryPending: s.isRecoveryPending,
    }))
  )

  const respondToPrompt = useChatStore((s) => s.respondToPrompt)
  const setComposerPrefill = useChatStore((s) => s.setComposerPrefill)
  const getThinkingStepsForMessage = useChatStore((s) => s.getThinkingStepsForMessage)
  const dismissErrorCard = useChatStore((s) => s.dismissErrorCard)
  const retryLastUserMessage = useChatStore((s) => s.retryLastUserMessage)
  const t = useTranslations('research')
  const tCollaboration = useTranslations('collaboration')
  const { user } = useAuth()
  const currentUserId = user?.id ?? null

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
    if (isForeignTurn && spectatedTurn?.failed) clearTurnInFlight()
  }, [isForeignTurn, spectatedTurn?.failed, clearTurnInFlight])

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
  // is the growing message list we observe for height changes.
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // Kept in a ref (not just state) so the ResizeObserver callback reads a fresh
  // value without being re-created on every scroll.
  const isAtBottomRef = useRef(true)
  const [showScrollButton, setShowScrollButton] = useState(false)

  // ── New-question top-anchor bookkeeping (ChatGPT/Claude pattern) ────────────
  // When a NEW user message is sent we pin THAT message near the top of the
  // viewport and let the answer stream fill downward, instead of the stick-to-
  // bottom controller chasing the growing answer (which scrolled the question
  // off-screen). The anchored question's turn carries `data-chat-anchor` so the
  // effect can find it in the committed DOM (motion.div doesn't attach a
  // forwarded ref synchronously); `anchorSpacerRef` is an invisible min-height
  // block below the list that guarantees there is always enough scroll room to
  // bring the question to the top (imperatively sized so it needs no extra
  // render); `prevUserMessageIdRef` debounces the anchor so it fires once per
  // newly-sent question (and never on mount / session restore, where the
  // bottom-jump effect below owns scrolling).
  const anchorSpacerRef = useRef<HTMLDivElement>(null)
  const prevUserMessageIdRef = useRef<string | null | undefined>(currentUserMessageId)
  // Latest streaming flag for the deferred spacer-release check below. Kept in a
  // ref so a rAF scheduled while streaming was momentarily false (a send that
  // anchors a turn, then flips streaming true a tick later) sees the up-to-date
  // value and does not release the spacer out from under a live stream.
  const isStreamingRef = useRef(isStreaming)
  isStreamingRef.current = isStreaming
  // Latest reduced-motion preference for the anchor scroll (a JS scrollIntoView
  // overrides the CSS scroll-behavior gate, so honour it explicitly). Ref-held so
  // the anchor effect's deps stay tied to the turn id, not this preference.
  const prefersReducedMotion = useReducedMotion()
  const reducedMotionRef = useRef(prefersReducedMotion)
  reducedMotionRef.current = prefersReducedMotion

  const messages = currentConversation?.messages

  // Filter to only show displayable message types in the chat area
  // Assistant text messages (full reports) are displayed in the Details Panel instead
  const displayableMessages = useMemo(
    () =>
      (messages ?? []).filter((msg) => {
        const messageType = msg.messageType || (msg.role === 'user' ? 'user' : 'assistant')
        return (
          messageType === 'user' ||
          messageType === 'prompt' ||
          messageType === 'agent_response' ||
          messageType === 'file' ||
          messageType === 'error' ||
          messageType === 'deep_research_banner'
        )
      }),
    [messages]
  )

  const isEmpty = displayableMessages.length === 0

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
  const highlightedMessageId = useMessageAnchor(anchoredMessageIds)

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
  const hydratedIdsRef = useRef<Set<string> | null>(null)
  const hydratedConversationIdRef = useRef<string | undefined>(currentConversation?.id)
  if (
    hydratedIdsRef.current === null ||
    hydratedConversationIdRef.current !== currentConversation?.id
  ) {
    hydratedConversationIdRef.current = currentConversation?.id
    hydratedIdsRef.current = new Set(displayableMessages.map((m) => m.id))
  }
  const hydratedIds = hydratedIdsRef.current

  /**
   * Helper to get thinking steps for a user message.
   * First checks ephemeral store (for active session), then falls back
   * to persisted steps embedded in the message (for restored sessions).
   * Filters out deep research steps - they're displayed in the Research Panel.
   */
  const getStepsForUserMessage = (messageId: string) => {
    // First try ephemeral store (for active session)
    // getThinkingStepsForMessage already filters out deep research steps
    const storeSteps = getThinkingStepsForMessage(messageId)
    if (storeSteps.length > 0) return storeSteps

    // Fall back to persisted steps in message (for restored sessions)
    // Filter out deep research steps here as well
    const message = currentConversation?.messages.find((m) => m.id === messageId)
    return (message?.thinkingSteps || []).filter((step) => !step.isDeepResearch)
  }

  // ── Stick-to-bottom scroll controller ──────────────────────────────────────
  // Replaces the old "scroll on message count grew" effect. It keeps the view
  // pinned to the newest content ONLY when the user is already near the bottom,
  // so streaming token growth follows smoothly but a user who scrolled up to
  // read is never yanked back down.

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollContainerRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
  }, [])

  // Recompute "am I near the bottom?" on every scroll. 80px of slack means a
  // small manual nudge (or the composer's reserved padding) still counts as
  // "at bottom" and keeps auto-follow engaged.
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distanceFromBottom <= 80
    isAtBottomRef.current = atBottom
    setShowScrollButton((prev) => (prev !== !atBottom ? !atBottom : prev))
  }, [])

  // Follow height growth (streaming tokens AND newly appended messages) via a
  // ResizeObserver on the list. rAF + behavior:'auto' means we ride the growth
  // frame-by-frame instead of firing competing 'smooth' animations. When the
  // user is scrolled up we don't move them — we just surface the jump button.
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    let raf = 0
    const observer = new ResizeObserver(() => {
      if (isAtBottomRef.current) {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(() => scrollToBottom('auto'))
      } else {
        setShowScrollButton(true)
      }
    })
    observer.observe(content)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
    // Re-attach when the list mounts/unmounts (skeleton ↔ list ↔ welcome).
  }, [scrollToBottom, isEmpty, hasHydrated])

  // On conversation switch, jump straight to the newest message and re-engage
  // auto-follow (no smooth animation across a full thread swap). Also release
  // any stale top-anchor spacer so a swapped-in thread starts flush at bottom.
  useEffect(() => {
    isAtBottomRef.current = true
    setShowScrollButton(false)
    if (anchorSpacerRef.current) anchorSpacerRef.current.style.minHeight = '0px'
    const raf = requestAnimationFrame(() => scrollToBottom('auto'))
    return () => cancelAnimationFrame(raf)
  }, [currentConversation?.id, scrollToBottom])

  // Anchor a NEWLY-sent user question near the TOP of the viewport and DISENGAGE
  // the bottom auto-follow, so the streaming answer fills downward from the
  // question instead of the controller chasing the bottom (which scrolled the
  // question off-screen). Runs only when `currentUserMessageId` transitions to a
  // brand-new id — never on mount / restore (prevUserMessageIdRef is seeded with
  // the mount value). useLayoutEffect so `isAtBottomRef` flips to false BEFORE
  // the ResizeObserver's post-layout callback reads it, so growth never yanks
  // the view down for this turn. Near-bottom auto-follow re-engages naturally
  // the moment the user scrolls back down (handleScroll), the jump-to-latest
  // button still surfaces while scrolled up, and a user reading up-thread is
  // never moved — all preserved.
  useLayoutEffect(() => {
    const id = currentUserMessageId
    if (!id || id === prevUserMessageIdRef.current) return
    prevUserMessageIdRef.current = id
    const container = scrollContainerRef.current
    const target = container?.querySelector<HTMLElement>('[data-chat-anchor="true"]')
    if (!container || !target) return
    isAtBottomRef.current = false
    setShowScrollButton(false)
    // Guarantee the question can actually reach the top: reserve a viewport of
    // scroll room below the list (imperative — no extra render). The streaming
    // answer consumes this room as it grows; the spacer is released once the
    // turn ends (effect below).
    if (anchorSpacerRef.current) {
      anchorSpacerRef.current.style.minHeight = `${container.clientHeight}px`
    }
    // scroll-mt on the anchored turn keeps clearance for the floating toolbar
    // pills so the question lands just below them, not behind them.
    target.scrollIntoView?.({
      behavior: reducedMotionRef.current ? 'auto' : 'smooth',
      block: 'start',
    })
  }, [currentUserMessageId])

  // Release the top-anchor spacer once the answer has landed (turn no longer
  // streaming), so no trailing empty gap lingers below a finished answer. Also
  // keyed on `currentUserMessageId` so a turn that anchors but never streams —
  // e.g. an immediate send failure before the stream starts — still releases the
  // spacer instead of leaving dead scroll space. The rAF re-checks the live
  // streaming flag so a normal turn (streaming true a tick after the id changes)
  // keeps its spacer.
  useEffect(() => {
    if (isStreaming) return
    const raf = requestAnimationFrame(() => {
      if (!isStreamingRef.current && anchorSpacerRef.current) {
        anchorSpacerRef.current.style.minHeight = '0px'
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [isStreaming, currentUserMessageId])

  const handleScrollToLatest = useCallback(() => {
    isAtBottomRef.current = true
    setShowScrollButton(false)
    scrollToBottom('smooth')
  }, [scrollToBottom])

  const handlePromptRespond = useCallback(
    (promptId: string, response: string) => {
      respondToPrompt(promptId, response)
    },
    [respondToPrompt]
  )

  // Retry an errored answer: resend the last user message through the live send
  // path (or prefill the composer as a fallback), then clear the stale error
  // card so the turn reads as freshly retried rather than doubled up.
  const handleErrorRetry = useCallback(
    (messageId: string) => {
      retryLastUserMessage()
      dismissErrorCard(messageId)
    },
    [retryLastUserMessage, dismissErrorCard]
  )

  // TODO: Implement file retry/cancel/delete handlers when file upload is added
  // For now, these are placeholders
  const handleFileRetry = useCallback((_messageId: string) => {
    // Will be implemented with file upload feature
  }, [])

  // Latency-gap typing indicator: while streaming, if the newest message is the
  // just-sent user message with no thinking steps and no answer yet, show a
  // small typing bubble so the send feels acknowledged before the first token.
  const showTypingPlaceholder = useMemo(() => {
    if (!isStreaming || !currentUserMessageId) return false
    const last = displayableMessages[displayableMessages.length - 1]
    if (!last || last.id !== currentUserMessageId) return false
    return getThinkingStepsForMessage(currentUserMessageId).length === 0
  }, [isStreaming, currentUserMessageId, displayableMessages, getThinkingStepsForMessage])

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
          aria-label={t('chatArea.ariaMessages')}
        >
          {/* Access revoked while viewing: the fallback shows the local copy, so
              without this the thread simply freezes with no explanation. */}
          {accessLost && (
            <div
              role="status"
              className="mx-auto mt-3 w-full max-w-3xl px-4 text-sm text-muted-foreground"
            >
              {tCollaboration('thread.accessLost')}
            </div>
          )}
          {!hasHydrated || (shared && sharedLoading && isEmpty) ? (
            // Hydration skeleton (C5): the persisted thread hasn't rehydrated yet.
            // Show a lightweight grey-bubble placeholder — never flash WelcomeState
            // for a returning user whose conversation is about to load in. The same
            // holds for a first-time RECIPIENT of a shared thread: the conversation
            // is materialised empty and the server history lands a moment later, so
            // without the second clause a shared-thread invitee got a flash of the
            // "private workspace" welcome before their colleague's messages snapped in.
            <MessageListSkeleton />
          ) : isEmpty ? (
            <WelcomeState isAuthenticated={isAuthenticated} onSignIn={onSignIn} />
          ) : (
            // Bottom padding tracks the floating composer's REAL height (published
            // as --composer-h by MainLayout's ResizeObserver) plus a breathing gap,
            // so the last message/Herleitung never renders behind the composer no
            // matter how tall it grows. The 11rem fallback matches the old pb-44.
            <div
              ref={contentRef}
              // Top padding reserves clearance for the floating toolbar pills that
              // overlay the top of this scroll plane, so the first message never
              // renders behind them — a little extra on mobile where the pills sit
              // edge-to-edge over the full-width column.
              className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pt-20 sm:pt-16"
              style={{ paddingBottom: 'calc(var(--composer-h, 11rem) + 1.5rem)' }}
            >
              <AnimatePresence initial={false}>
                {displayableMessages.map((message, index) => {
                  const isUserMessage = message.messageType === 'user' || message.role === 'user'
                  const messageSteps = isUserMessage ? getStepsForUserMessage(message.id) : []
                  const hasThinkingSteps = messageSteps.length > 0

                  // Derive post-thinking state for user messages with thinking steps.
                  // Priority: isThinking (active) > isWaiting (HITL) > isInterrupted > done
                  const isCurrentlyStreaming = isStreaming && message.id === currentUserMessageId
                  const shouldCheckPostState =
                    isUserMessage && hasThinkingSteps && !isCurrentlyStreaming
                  const remaining = shouldCheckPostState ? displayableMessages.slice(index + 1) : []
                  const nextUserMessageIndex = remaining.findIndex(
                    (m) => m.messageType === 'user' || m.role === 'user'
                  )
                  // Only evaluate status within this message turn (until next user message).
                  // This prevents later turns from overriding interrupted/waiting state.
                  const turnMessages =
                    nextUserMessageIndex >= 0 ? remaining.slice(0, nextUserMessageIndex) : remaining

                  // Waiting: an unresponded HITL prompt follows this user message
                  const isWaiting =
                    shouldCheckPostState &&
                    turnMessages.some((m) => m.messageType === 'prompt' && !m.isPromptResponded)

                  // Interrupted: no actual response AND not waiting for HITL
                  const hasResponse = turnMessages.some(
                    (m) => m.messageType === 'assistant' || m.messageType === 'agent_response'
                  )
                  const isInterrupted = shouldCheckPostState && !isWaiting && !hasResponse

                  // Real data threaded into the Herleitung assessment/next-steps
                  // nodes: the turn's answer (confidence + citations) and any live
                  // multiple-choice HITL prompt. Absent on streaming/shallow turns —
                  // those nodes then hide themselves.
                  const agentMsg = turnMessages.find(
                    (m) => m.messageType === 'assistant' || m.messageType === 'agent_response'
                  )
                  const choicePromptMsg = turnMessages.find(
                    (m) =>
                      m.messageType === 'prompt' &&
                      m.promptType === 'choice' &&
                      (m.promptOptions?.length ?? 0) > 0
                  )
                  const choicePrompt = choicePromptMsg
                    ? {
                        promptId: choicePromptMsg.promptId ?? choicePromptMsg.id,
                        text: choicePromptMsg.content,
                        options: choicePromptMsg.promptOptions ?? [],
                        isResponded: !!choicePromptMsg.isPromptResponded,
                        selected: choicePromptMsg.promptResponse,
                      }
                    : undefined

                  // The just-sent question's turn is the top-anchor target on send.
                  const isAnchorTarget = isUserMessage && message.id === currentUserMessageId

                  const messageAuthorship = authorship.get(message.id)

                  return (
                    <motion.div
                      key={message.id}
                      // The deep-link target (`#message-<id>`). Every message carries
                      // it, not just mentions: an inbox item can point at any message,
                      // and a link that resolves for some rows and not others is worse
                      // than none.
                      id={`message-${message.id}`}
                      data-chat-anchor={isAnchorTarget ? 'true' : undefined}
                      className={cn(
                        'flex scroll-mt-20 flex-col gap-4 sm:scroll-mt-16',
                        // The arrival mark: says "this is the one" for a beat, then
                        // fades. A ring rather than a background, so it reads on the
                        // user bubble and the answer card alike.
                        highlightedMessageId === message.id &&
                          'ring-warning/50 ring-offset-background rounded-xl ring-2 ring-offset-4 transition-shadow duration-500'
                      )}
                      variants={fadeRise}
                      // Animate only genuinely new messages; hydrated ones render in place.
                      initial={hydratedIds.has(message.id) ? false : 'hidden'}
                      animate="visible"
                      exit={{ opacity: 0, transition: { duration: 0.15 } }}
                      transition={springGentle}
                    >
                      {/* Where the reader left off, in a shared thread (spec CC-19). */}
                      {unreadDividerBeforeId === message.id && (
                        <UnreadDivider label={tCollaboration('thread.unreadDivider')} />
                      )}

                      {/* Render the message */}
                      <MessageRenderer
                        message={message}
                        conversationId={currentConversation?.id}
                        onPromptRespond={handlePromptRespond}
                        onFileRetry={handleFileRetry}
                        onErrorDismiss={dismissErrorCard}
                        onErrorRetry={handleErrorRetry}
                        showConfidenceChip={showConfidenceChip}
                        showAnswerFeedback={showAnswerFeedback}
                        author={messageAuthorship?.author}
                        grouped={messageAuthorship?.grouped}
                        currentUserId={currentUserId}
                        promptAddresseeName={
                          message.promptFor ? (authorOf(message.promptFor)?.name ?? null) : null
                        }
                      />

                      {/* Assistant-side thread spine: the Herleitung shares the
                      answer card's width and left alignment, so the reasoning and
                      the answer stack as ONE left column (the user bubble stays
                      right-aligned). Auto-expanded while the turn is live, it
                      collapses to a one-line bar once the answer lands. */}
                      {isUserMessage && hasThinkingSteps && (
                        <div className="w-[680px] max-w-full">
                          <ChatThinking
                            steps={messageSteps}
                            isThinking={isStreaming && message.id === currentUserMessageId}
                            autoOpen={
                              (isStreaming && message.id === currentUserMessageId) || isWaiting
                            }
                            isWaiting={isWaiting}
                            isInterrupted={isInterrupted}
                            isRecoveryPending={isRecoveryPending}
                            enabledDataSources={message.enabledDataSources}
                            messageFiles={message.messageFiles}
                            userQuestion={message.content}
                            answerConfidence={agentMsg?.answerConfidence}
                            citations={agentMsg?.citations}
                            choicePrompt={choicePrompt}
                            onChoiceRespond={handlePromptRespond}
                            routingDecision={agentMsg?.routingDecision}
                            routingReason={agentMsg?.routingReason}
                            escalationReason={agentMsg?.escalationReason}
                          />
                        </div>
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
              {shared && (
                <AwaitingBanner
                  awaiting={awaiting}
                  onRelease={release}
                  onAskAgent={handleAskAgent}
                  onAskBack={handleAskBack}
                />
              )}

              {/* The colleague has answered and Piloti is out of the loop — the one
              moment the thread is worth handing on, and until now the only
              transition with no affordance on screen (see HandbackOffer). Anchored
              here, directly under the answer it is about. */}
              {showHandback && handback && (
                <HandbackOffer
                  people={handback.people}
                  onAccept={handleHandback}
                  onDismiss={() => setHandbackDismissedFor(handback.anchorId)}
                />
              )}

              {/* Latency-gap typing indicator (before the first token arrives) */}
              {showTypingPlaceholder && <TypingIndicator status={currentStatus} />}

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
              {shared && turnInFlight && !isStreaming && !showTypingPlaceholder && (
                spectatingLive && spectatedTurn ? (
                  <SpectatedTurn
                    turn={spectatedTurn}
                    label={turnInFlightLabel}
                  />
                ) : (
                  <TurnInFlightBanner label={turnInFlightLabel} />
                )
              )}

              {/* A colleague at a keyboard. Distinct vocabulary from the agent's
              banner above (see TypingPresence), and independent of it: somebody may
              well start writing while Piloti is still answering. */}
              {shared && <TypingPresence typists={typists} />}

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

              {/* Top-anchor spacer: invisible, zero-height by default, sized to a
              viewport only while a just-sent question is anchored to the top so
              it can reach the top and the answer streams downward. Released when
              the turn ends. */}
              <div ref={anchorSpacerRef} aria-hidden="true" style={{ minHeight: 0 }} />
            </div>
          )}
        </div>

        {/* Floating "scroll to latest" button — appears when the user has scrolled
          up and newer content is below. Pinned to the wrapper (not the scroll
          content) so it stays put while the thread scrolls behind it. */}
        <AnimatePresence>
          {showScrollButton && (
            <motion.div
              className="pointer-events-none absolute inset-x-0 z-10 flex justify-center"
              style={{ bottom: 'calc(var(--composer-h, 11rem) + 1rem)' }}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.15 }}
            >
              <button
                type="button"
                onClick={handleScrollToLatest}
                aria-label={t('chatArea.scrollToLatest')}
                className="bg-card text-muted-foreground hover:text-foreground active:scale-press pointer-events-auto flex h-9 w-9 items-center justify-center rounded-lg border shadow-md transition"
              >
                <ArrowDown className="h-4 w-4" aria-hidden="true" />
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
  onPromptRespond: (promptId: string, response: string) => void
  onFileRetry?: (messageId: string) => void
  onFileCancel?: (messageId: string) => void
  onFileDelete?: (messageId: string) => void
  onErrorDismiss?: (messageId: string) => void
  /** Resend the last user message + dismiss this error card (retry affordance). */
  onErrorRetry?: (messageId: string) => void
  /** Whether the AgentResponse confidence chip renders (feature-flagged). */
  showConfidenceChip?: boolean
  /** Whether the AgentResponse thumbs feedback row renders (feature-flagged). */
  showAnswerFeedback?: boolean
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
}

const MessageRendererComponent: FC<MessageRendererProps> = ({
  message,
  conversationId,
  onPromptRespond,
  onFileRetry: _onFileRetry,
  onFileCancel: _onFileCancel,
  onFileDelete: _onFileDelete,
  onErrorDismiss,
  onErrorRetry,
  showConfidenceChip = true,
  showAnswerFeedback = true,
  author,
  grouped,
  currentUserId,
  promptAddresseeName,
}) => {
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
      // Guard against missing promptType
      if (!message.promptType) {
        return null
      }
      return (
        <AgentPrompt
          id={message.id}
          type={message.promptType}
          content={message.content}
          options={message.promptOptions}
          placeholder={message.promptPlaceholder}
          isResponded={message.isPromptResponded}
          response={message.promptResponse}
          onRespond={onPromptRespond}
          timestamp={message.timestamp}
          // `promptFor` is present only on a prompt restored from the server
          // (ADR-0037). Absent means a live prompt, where this browser holds the
          // socket and IS the addressee. Present and not us means a colleague's
          // question: read-only, because the agent tier refuses our answer anyway.
          isAddressee={!message.promptFor || message.promptFor === currentUserId}
          addresseeName={promptAddresseeName}
        />
      )

    case 'agent_response':
      // Short answers from the agent displayed in the chat area
      return (
        <AgentResponse
          content={message.content}
          timestamp={message.timestamp}
          showViewReport={message.showViewReport}
          jobId={message.deepResearchJobId}
          isDeepResearchActive={message.isDeepResearchActive}
          deepResearchJobStatus={message.deepResearchJobStatus}
          cards={message.cards}
          citations={message.citations}
          conversationId={conversationId}
          answerConfidence={message.answerConfidence}
          answerConfidenceCappedReason={message.answerConfidenceCappedReason}
          answerConfidenceReason={message.answerConfidenceReason}
          citationsRemoved={message.citationsRemoved}
          showConfidenceChip={showConfidenceChip}
          messageId={message.id}
          showAnswerFeedback={showAnswerFeedback}
          isStreaming={message.isStreaming}
          routingDecision={message.routingDecision}
        />
      )

    case 'file':
      // TODO: FileCard was removed in refactor - file display handled by FileSourceCard in panel
      // File operation messages show upload/ingest status
      if (!message.fileData) {
        return null
      }
      return (
        <div
          className="bg-muted/50 shadow-xs flex items-center gap-2 rounded-xl px-4 py-2"
          role="status"
        >
          <FileText className="text-muted-foreground h-4 w-4" aria-hidden="true" />
          <span className="text-muted-foreground text-sm">
            {message.fileData.fileName} ({message.fileData.fileStatus})
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

    case 'deep_research_banner':
      // Deep research status banners (success/failure)
      if (!message.deepResearchBannerData) {
        return null
      }
      return (
        <DeepResearchBanner
          bannerType={message.deepResearchBannerData.bannerType}
          jobId={message.deepResearchBannerData.jobId}
          totalTokens={message.deepResearchBannerData.totalTokens}
          toolCallCount={message.deepResearchBannerData.toolCallCount}
          timestamp={message.timestamp}
          escalationReason={message.deepResearchBannerData.escalationReason}
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
  prev.showConfidenceChip === next.showConfidenceChip &&
  prev.showAnswerFeedback === next.showAnswerFeedback &&
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
  prev.onPromptRespond === next.onPromptRespond &&
  prev.onErrorDismiss === next.onErrorDismiss &&
  prev.onErrorRetry === next.onErrorRetry &&
  prev.onFileRetry === next.onFileRetry

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
    <span className="text-muted-foreground text-[10.5px] font-semibold uppercase tracking-[0.06em]">
      {label}
    </span>
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
    className="bg-card shadow-xs flex w-fit items-center gap-2 rounded-lg border px-3.5 py-2"
    role="status"
    data-testid="turn-in-flight"
  >
    <Sparkles className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
    <span className="animate-text-shimmer text-foreground text-xs font-medium">{label}</span>
  </div>
)

/**
 * Latency-gap typing indicator (three pulsing dots) shown after the just-sent
 * user message until the first token / thinking step arrives. Left-aligned to
 * match assistant bubbles.
 */
// Streaming statuses that have a human label; other StatusType values fall back
// to the generic "typing" copy.
const TYPING_STATUS_KEYS: Partial<Record<StatusType, string>> = {
  thinking: 'thinking',
  searching: 'searching',
  planning: 'planning',
  researching: 'researching',
  writing: 'writing',
}

const TypingIndicator: FC<{ status?: StatusType | null }> = ({ status }) => {
  const t = useTranslations('research')
  const statusKey = status ? TYPING_STATUS_KEYS[status] : undefined
  const label = statusKey ? t(`chatArea.status.${statusKey}`) : t('chatArea.typing')
  // This bubble is only mounted before the first step arrives, so counting from
  // mount gives the true "time since send" for the earliest, quietest wait.
  const elapsed = useElapsedSeconds(true)
  return (
    <div
      className="animate-in fade-in-0 bg-muted/60 flex w-fit items-center gap-2 rounded-2xl px-3.5 py-2.5 duration-200"
      role="status"
      aria-label={label}
    >
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="bg-muted-foreground/70 h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:-0.3s]" />
        <span className="bg-muted-foreground/70 h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:-0.15s]" />
        <span className="bg-muted-foreground/70 h-1.5 w-1.5 animate-bounce rounded-full" />
      </span>
      {/* Always word the wait (shimmering), and surface elapsed seconds once
          past a couple of seconds so a slow first token never feels stalled. */}
      <span className="animate-text-shimmer text-xs font-medium">{label}</span>
      {elapsed > 2 && (
        <span className="text-muted-foreground/80 text-[11px] tabular-nums">
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
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pt-16"
      style={{ paddingBottom: 'calc(var(--composer-h, 11rem) + 1.5rem)' }}
      role="status"
      aria-label={t('chatArea.loading')}
      aria-busy="true"
    >
      {/* user bubble (right) */}
      <div className="flex justify-end">
        <div className="bg-muted/70 h-10 w-1/2 animate-pulse rounded-2xl" />
      </div>
      {/* assistant bubble (left, taller) */}
      <div className="flex justify-start">
        <div className="bg-muted/50 h-24 w-4/5 animate-pulse rounded-2xl" />
      </div>
      {/* user bubble (right) */}
      <div className="flex justify-end">
        <div className="bg-muted/70 h-10 w-1/3 animate-pulse rounded-2xl" />
      </div>
    </div>
  )
}

/**
 * Welcome state shown when no messages exist.
 *
 * Signed in: a time-of-day greeting (with the user's first name when known),
 * hero-sized per the click dummy, centered above the floating composer — the
 * source-preset shortcut chips render with the composer itself (InputArea).
 * Signed out: a compact sign-in prompt. Bottom padding keeps the centered
 * content clear of the floating composer.
 */
interface WelcomeStateProps {
  isAuthenticated?: boolean
  onSignIn?: () => void
}

/** Time-of-day bucket for the greeting (morning / afternoon / evening). */
const greetingKeyForHour = (hour: number): 'morning' | 'afternoon' | 'evening' => {
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
}

/**
 * Example Austrian Baurecht questions offered on the empty chat state. Clicking
 * one PREFILLS the composer (never auto-sends) via the store's composer-prefill
 * path — the same one used by `?ask=` deep links — so a blank canvas offers an
 * obvious first move instead of paralysis.
 */
const EXAMPLE_QUESTION_KEYS = ['fluchtweg', 'barrierefreiheit', 'brandabschnitte'] as const

const WelcomeState: FC<WelcomeStateProps> = ({ isAuthenticated = false, onSignIn }) => {
  const t = useTranslations('research')
  const tChat = useTranslations('chat')
  const { user } = useAuth()
  const setComposerPrefill = useChatStore((s) => s.setComposerPrefill)

  if (!isAuthenticated) {
    return (
      <div
        className="flex flex-1 items-center justify-center px-4 pt-6"
        style={{ paddingBottom: 'calc(var(--composer-h, 11rem) + 1.5rem)' }}
      >
        <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
          <div className="bg-muted text-brand flex h-12 w-12 items-center justify-center rounded-xl border">
            <Lock className="h-5 w-5" aria-hidden="true" />
          </div>
          <h1 className="tracking-display text-2xl font-semibold">
            {t('chatArea.loggedOutTitle')}
          </h1>
          <p className="text-muted-foreground text-sm">{t('chatArea.loggedOutBody')}</p>
          <Button
            onClick={onSignIn}
            aria-label={t('chatArea.signInSso')}
            className="active:scale-press transition"
          >
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
      className="flex flex-1 flex-col items-center justify-center px-6 pt-6"
      style={{ paddingBottom: 'calc(var(--composer-h, 11rem) + 1.5rem)' }}
    >
      {/* "Privater Workspace" lock chip — h28, radius8, hairline, raised */}
      <div className="bg-card shadow-xs mb-4 inline-flex h-7 items-center gap-[7px] rounded-md border px-[11px]">
        <Lock className="text-subtle size-3 shrink-0" aria-hidden="true" />
        <span className="text-muted-foreground text-[12px] font-medium">
          {tChat('workspace.private')}
        </span>
      </div>

      {/* Hero greeting — 23px/500 ink, tight tracking */}
      <h1 className="tracking-display text-foreground text-center text-[23px] font-medium">
        {heading}
      </h1>

      {/* One-line subtitle under the greeting: tells a first-timer that answers
          cite their sources (copy already in both locales — chat.greeting.subtitle). */}
      <p className="text-muted-foreground mt-2 max-w-md text-center text-[13.5px] leading-relaxed">
        {tChat('greeting.subtitle')}
      </p>

      {/* Example question chips — quiet bg-card hairline chips that prefill the
          composer (do not auto-send), so the empty canvas offers a first move. */}
      <div
        className="mt-6 flex max-w-xl flex-wrap items-center justify-center gap-2"
        role="group"
        aria-label={tChat('examples.label')}
      >
        {EXAMPLE_QUESTION_KEYS.map((key) => {
          const question = tChat(`examples.questions.${key}`)
          return (
            <button
              key={key}
              type="button"
              onClick={() => setComposerPrefill(question)}
              className="bg-card text-foreground/85 shadow-xs hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 inline-flex h-8 items-center rounded-md border px-[13px] text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 pointer-coarse:h-11"
            >
              {question}
            </button>
          )
        })}
      </div>
    </div>
  )
}
