/**
 * useWebSocketChat Hook
 *
 * Custom hook for managing chat interactions via WebSocket.
 * Uses NAT WebSocket protocol for full HITL (human-in-the-loop) support.
 *
 * Routes messages to appropriate UI elements:
 * - system_response -> Chat Area (agent_response)
 * - system_intermediate -> Details Panel (Thinking tab)
 * - system_interaction -> Chat Area (AgentPrompt for user response)
 * - error -> Error handling
 *
 * Note: Research Panel (reportContent) is only populated by deep research
 * SSE events via use-deep-research.ts, not by WebSocket responses.
 */

'use client'

import { useCallback, useRef, useEffect, useState, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTranslations } from '@/i18n'
import { useAuth } from '@/adapters/auth'
import { getTokenExpiration } from '@/adapters/auth/token'
import {
  NATWebSocketClient,
  createNATWebSocketClient,
  type NATWebSocketClientCallbacks,
  type ConnectionChangeContext,
  type NATHumanPrompt,
  type NATIntermediateStepContent,
  type NATErrorContent,
  HumanPromptType,
} from '@/adapters/api/websocket-client'
import { checkBackendHealthCached, invalidateHealthCache } from '@/shared/hooks/use-backend-health'
import { useChatStore } from '../store'
import { registerStopStreamingHandler } from '../stores/messages-store'
import { useConnectionRecovery } from './use-connection-recovery'
import { useLayoutStore } from '@/features/layout/store'
import { useDocumentsStore } from '@/features/documents/store'
import { isLikelyAuthRelatedTransportError } from '../lib/transport-auth-signals'
import { validateGridCards } from '@/shared/cards/schemas'
import { citationsFromWireList } from '../lib/wire-citation'
import type { GridCard } from '@/shared/cards/schemas'
import type {
  ChatMessage,
  Conversation,
  PromptType,
  PendingInteraction,
  StatusType,
  ThinkingStep,
  ErrorCode,
} from '../types'
import {
  parseFunctionName,
  mapFunctionToCategory,
  getDisplayName,
  getWorkflowDisplayName,
  isFunctionStepName,
  formatPayload,
} from '../lib/intermediate-step-parser'

const EMPTY_MESSAGES: ChatMessage[] = []
const EMPTY_CONVERSATIONS: Conversation[] = []

/**
 * Buffer entry for an outgoing payload that has to bridge a socket
 * rotation. Discriminated by `kind` because both chat messages and HITL
 * interaction responses can hit `auth_expired` at the backend, and the
 * drain on the freshly-handshaken socket has to dispatch back to the
 * right `NATWebSocketClient` method.
 */
type PendingOutgoing =
  | { kind: 'message'; content: string; dataSources: string[]; deliveryRetryCount?: number }
  | { kind: 'interaction'; interactionId: string; parentId: string; response: string; deliveryRetryCount?: number }

type UnacknowledgedOutgoing = {
  payload: PendingOutgoing
  outboundId: string
  ackParentId: string
  conversationId?: string
  retryCount: number
}

/**
 * Seconds before token expiry to proactively rotate the WebSocket. The
 * backend only validates the JWT at the WS upgrade, so an open socket
 * keeps trusting an expired token until we close + reopen it.
 *
 * If the timer fires mid-stream, rotation is deferred until `isStreaming`
 * returns to false so long-running responses are never cut short.
 *
 * INVARIANT: must be smaller than the access token lifetime (WorkOS
 * access tokens are 15 minutes by default) so AuthKit has already
 * refreshed the session by the time we upgrade with a fresh cookie.
 */
const WS_REFRESH_SOFT_GUARD_SECONDS = 60

/**
 * Hard cap on consecutive `auth_expired` rotations before we surface a
 * `session_expired` banner instead of silently rotating again.
 *
 * Why a cap is necessary: each `auth_expired` response from the backend
 * goes through `rotate()`, which resets `reconnectCount` to 0. That means
 * the WS client's own retry safety net (CONNECTION_FAILED after N
 * exhausted reconnect attempts) never trips on the auth_expired path --
 * the counter is wiped on every rotation. Without an upper bound here,
 * a stale token or clock-skew condition where `getAccessToken()` keeps
 * handing us the same already-expired JWT can produce dozens of
 * silent rotations per minute (one per `auth_expired` round-trip) until
 * the refresh-token itself expires. That's invisible to the user (just a
 * spinner that never stops), wasteful for server connection slots, and
 * indistinguishable from a DDoS at the rate-limit layer.
 *
 * 1 is normal (the whole point of the silent reconnect path). 2 is the
 * documented preflight-then-second-auth_expired chain (we have a test).
 * >= 4 is a loop -- bail out, clear buffers, ask the user to sign in
 * again. Counter is reset on any successful response/intermediate step
 * because a single passing message proves the post-rotation auth is alive.
 */
const MAX_CONSECUTIVE_AUTH_EXPIRED = 3

/**
 * One silent replay is enough to cover the stale-open socket race observed in
 * staging: the browser reported OPEN, the UI wrote the prompt, and the socket
 * closed before the backend emitted any frame. More than one replay risks
 * duplicate workflows if the backend accepted the earlier send but was slow to
 * answer, so a second unacknowledged close falls back to the normal connection
 * failure path.
 */
const MAX_UNACKNOWLEDGED_OUTGOING_REPLAYS = 1

/**
 * If the browser accepts a WebSocket send but the server never emits any
 * response frame, `onclose` may also never fire on half-open network paths.
 * This timeout closes that remaining gap: no backend contact within the
 * window is treated like an unacknowledged stale send.
 */
const UNACKNOWLEDGED_OUTGOING_ACK_TIMEOUT_MS = 7_000

/**
 * Overall turn watchdog. The 7s delivery timeout above only covers the gap
 * before the FIRST backend frame; it is cleared once any frame arrives. After
 * that, a backend that stalls mid-stream (or dies without sending a terminal
 * frame) would leave `isStreaming=true` forever -- a spinner that never stops
 * with the composer and session list locked.
 *
 * This watchdog fires when NO frame has arrived for this long while streaming.
 * It is (re)armed on send and reset on every incoming frame, and cleared on
 * completion / error / disconnect / HITL pause / unmount. On fire it ends the
 * turn, marks it interrupted, and surfaces a retryable timeout banner.
 */
const STREAMING_INACTIVITY_TIMEOUT_MS = 180_000

/**
 * Map NAT/backend error codes to frontend ErrorCode for consistent UI display.
 * This provides a generic mapping for any backend error.
 */
const mapNATErrorToErrorCode = (natErrorCode: string): ErrorCode => {
  // Map known NAT error types
  switch (natErrorCode) {
    case 'invalid_message':
    case 'invalid_message_type':
    case 'invalid_user_message_content':
    case 'invalid_data_content':
      return 'agent.response_failed'
    case 'CONNECTION_FAILED':
      return 'connection.failed'
    // Backend catch-all: a workflow raised mid-turn. See
    // websocket_reconnect.py `_run_workflow`.
    case 'workflow_error':
      return 'agent.workflow_error'
    case 'unknown_error':
    default:
      return 'system.unknown'
  }
}

interface UseWebSocketChatOptions {
  /** Auto-connect on mount (default: true) */
  autoConnect?: boolean
}

interface UseWebSocketChatReturn {
  /** Send a message via WebSocket. Returns false when the message could not
   * be sent or queued (so the caller can preserve the user's input). */
  sendMessage: (content: string) => boolean
  /** Respond to a pending interaction (clarification, approval, etc.) */
  respondToInteraction: (response: string) => void
  /** Disconnect from the WebSocket server */
  disconnect: () => void
  /** Reconnect the WebSocket */
  connect: () => void
  /** Whether WebSocket is connected */
  isConnected: boolean
  /** Whether a response is currently being received */
  isStreaming: boolean
  /** Whether we're waiting for the first response */
  isLoading: boolean
  /** All messages in the current conversation */
  messages: Conversation['messages'] | undefined
  /** Current conversation */
  conversation: Conversation | null
  /** Create a new conversation */
  createConversation: () => void
  /** Conversations filtered by current user */
  userConversations: Conversation[]
  /** Select a conversation by ID */
  selectConversation: (conversationId: string) => void
  /** Thinking steps from Details Panel */
  thinkingSteps: ThinkingStep[]
  /** Report content from Details Panel */
  reportContent: string
  /** Current status type */
  currentStatus: StatusType | null
  /** Pending interaction requiring user response */
  pendingInteraction: PendingInteraction | null
}

/**
 * Map NAT human prompt types to our PromptType
 */
const mapHumanPromptType = (natType: string): PromptType => {
  switch (natType) {
    case HumanPromptType.TEXT:
      return 'text-input'
    case HumanPromptType.MULTIPLE_CHOICE:
      return 'choice'
    case HumanPromptType.BINARY_CHOICE:
      return 'approval'
    case HumanPromptType.APPROVAL:
      return 'approval'
    default:
      return 'clarification'
  }
}

/**
 * Hook for managing chat with WebSocket connection
 *
 * Uses NAT WebSocket protocol for bidirectional communication,
 * enabling full HITL support including clarification prompts
 * and approval flows.
 */
export const useWebSocketChat = (options: UseWebSocketChatOptions = {}): UseWebSocketChatReturn => {
  const { autoConnect = true } = options

  // WebSocket client ref
  const wsClientRef = useRef<NATWebSocketClient | null>(null)

  // Connection state
  const [isConnected, setIsConnected] = useState(false)

  // Ref to track the current thinking step ID for appending content
  const currentThinkingStepIdRef = useRef<string | null>(null)
  // Ref to track the current status for detecting status changes
  const currentStatusRef = useRef<StatusType | null>(null)

  /**
   * Single-slot buffer for an outgoing payload deferred by a socket
   * rotation (stale token pre-flight or `auth_expired` from backend).
   * Drained inside `onConnectionChange('connected')`. Single-slot is
   * sufficient because `setStreaming(true)` gates new sends during rotation.
   *
   * Tagged by `kind` because the drain has to dispatch back to either
   * `sendMessage` (chat) or `sendInteractionResponse` (HITL). The backend
   * applies the same per-message JWT expiry gate to both; without the kind
   * tag a HITL response sent right after token expiry would either be
   * dropped (no buffer) or wrongly replayed as the previous chat message.
   */
  const pendingOutgoingRef = useRef<PendingOutgoing | null>(null)

  /**
   * Last payload written to the socket, kept until the workflow completes
   * or hits a non-auth error. Lets us auto-resend on `auth_expired` without
   * losing the user's payload. Distinct from `pendingOutgoingRef` so a
   * routine soft rotation doesn't replay an already-completed payload.
   */
  const lastSentOutgoingRef = useRef<PendingOutgoing | null>(null)

  /**
   * Payload that has been written to a WebSocket but has not yet produced any
   * backend frame. Browser `readyState === OPEN` is not a delivery guarantee:
   * a proxy/backend close can arrive immediately after `send()`. This ref lets
   * an unintentional close before first backend contact replay the payload once
   * on the reconnected socket.
   */
  const unacknowledgedOutgoingRef = useRef<UnacknowledgedOutgoing | null>(null)
  const unacknowledgedOutgoingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Overall streaming-inactivity watchdog timer. Armed while a turn is in
   * flight, reset on every inbound frame, and cleared on any terminal state.
   * See `STREAMING_INACTIVITY_TIMEOUT_MS`.
   */
  const streamingWatchdogTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Set by the soft timer when it fires while streaming; consumed by the
   * deferred-rotation effect once `isStreaming` returns to false. Ref (not
   * state) so flipping the flag doesn't re-run the timer effect.
   */
  const pendingRotationRef = useRef(false)

  /**
   * Consecutive `auth_expired` rotations without a successful response in
   * between. Incremented in `onError(auth_expired)`, reset to 0 by any
   * `onResponse` / `onIntermediateStep` (a passing message proves auth is
   * alive on the rotated socket). When it exceeds
   * `MAX_CONSECUTIVE_AUTH_EXPIRED` we stop silently rotating and surface
   * `auth.session_expired` so the user can re-sign-in. See the docstring
   * on `MAX_CONSECUTIVE_AUTH_EXPIRED` for why this safety net is required.
   */
  const consecutiveAuthExpiredRef = useRef(0)

  /**
   * Guards budget-reason discovery to a single query per failure episode. The
   * browser cannot read the 403 body the gateway collapses into a bare failed
   * WS upgrade, so on CONNECTION_FAILED we ask a same-origin BFF endpoint
   * whether the real cause was budget exhaustion. Set once when we run that
   * check; reset on a successful `connected` (a new episode) and on unmount so
   * the diagnostics call can never loop or spam while connection-recovery keeps
   * re-firing CONNECTION_FAILED.
   */
  const budgetDiagnosticsCheckedRef = useRef(false)

  /**
   * Single rotation primitive. Delegates to `client.rotate()` -- an atomic
   * client-side swap that detaches handlers from the old socket before
   * closing it, eliminating the `onclose` race where a late close from
   * the rotated-out socket would be misclassified as an unintentional
   * disconnect on the freshly-opened one.
   *
   * `client.connect()` (invoked inside `rotate()`) runs `onBeforeReconnect`,
   * which is the only call site for `getAccessToken()` -- routing all
   * refreshes through one path avoids racing AuthKit's own refresh.
   */
  const rotateSocket = useCallback((reason: string): void => {
    const client = wsClientRef.current
    if (!client) return
    console.warn(`[WS] Rotating connection (${reason})`)
    void client.rotate()
  }, [])

  const { user, authRequired, isLoading: authLoading, getAccessToken } = useAuth()
  const tChat = useTranslations('chat')

  /**
   * Ask the same-origin diagnostics endpoint whether the WS failure was
   * actually a budget block the browser couldn't read from the collapsed
   * upgrade. Returns the localized banner message (admin vs member copy) when
   * budget-exhausted, or null for any other cause / on error (so the caller
   * falls back to the generic connection-failed banner). Never throws.
   */
  const discoverBudgetFailureMessage = useCallback(async (): Promise<string | null> => {
    try {
      const activeProjectId = useChatStore.getState().projectId
      const query = activeProjectId ? `?projectId=${encodeURIComponent(activeProjectId)}` : ''
      const res = await fetch(`/api/auth/connection-diagnostics${query}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) return null
      const body = (await res.json()) as { budgetExhausted?: boolean; canManageBudgets?: boolean }
      if (!body.budgetExhausted) return null
      return body.canManageBudgets
        ? tChat('budgetExhausted.adminMessage')
        : tChat('budgetExhausted.memberMessage')
    } catch {
      return null
    }
  }, [tChat])

  /**
   * Token expiry (seconds since epoch) that authenticates the *current*
   * socket. Captured from the fresh `getAccessToken()` call that primes the
   * cookie for the upcoming upgrade. Intentionally decoupled from the live
   * `useAccessToken()` value: AuthKit may refresh the live token but that
   * does NOT re-authenticate an already-open socket, so binding the timer
   * to it would let refreshes clear it before it fires.
   */
  const [activeSocketTokenExpiresAt, setActiveSocketTokenExpiresAt] =
    useState<number | undefined>(undefined)

  /**
   * Refresh the AuthKit session before opening a new WebSocket so the
   * upgrade request carries an up-to-date access token cookie, and anchor
   * the rotation deadline to the expiry returned by that same call.
   */
  const refreshAuthBeforeReconnect = useCallback(async (): Promise<void> => {
    if (!authRequired || !getAccessToken) return
    try {
      const token = await getAccessToken()
      if (token) {
        const exp = getTokenExpiration(token)
        if (exp) {
          setActiveSocketTokenExpiresAt(exp)
        }
      }
    } catch (err) {
      console.warn('[useWebSocketChat] getAccessToken before WS reconnect failed', err)
    }
  }, [authRequired, getAccessToken])

  // Chat store — reactive state only
  const {
    currentConversation,
    conversations,
    currentUserId,
    isStreaming,
    isLoading,
    thinkingSteps,
    reportContent,
    currentStatus,
    pendingInteraction,
  } = useChatStore(useShallow((s) => ({
    currentConversation: s.currentConversation,
    conversations: s.conversations,
    currentUserId: s.currentUserId,
    isStreaming: s.isStreaming,
    isLoading: s.isLoading,
    thinkingSteps: s.thinkingSteps,
    reportContent: s.reportContent,
    currentStatus: s.currentStatus,
    pendingInteraction: s.pendingInteraction,
  })))
  const currentConversationId = currentConversation?.id
  // Subscribe reactively so the connect effect re-runs when the project store
  // resolves after the socket was first created (fixes the first-load race
  // where the WS connected with projectId: undefined and never carried
  // project context -- the agent then had no knowledge of the project).
  const projectId = useChatStore((s) => s.projectId)

  // Actions — stable references, individual selectors won't cause re-renders
  const addUserMessage = useChatStore((s) => s.addUserMessage)
  const appendAgentResponseDelta = useChatStore((s) => s.appendAgentResponseDelta)
  const finalizeAgentResponse = useChatStore((s) => s.finalizeAgentResponse)
  const addAgentResponseWithMeta = useChatStore((s) => s.addAgentResponseWithMeta)
  const addThinkingStep = useChatStore((s) => s.addThinkingStep)
  const appendToThinkingStep = useChatStore((s) => s.appendToThinkingStep)
  const completeThinkingStep = useChatStore((s) => s.completeThinkingStep)
  const updateThinkingStepByFunctionName = useChatStore((s) => s.updateThinkingStepByFunctionName)
  const findThinkingStepByFunctionName = useChatStore((s) => s.findThinkingStepByFunctionName)
  const addAgentPrompt = useChatStore((s) => s.addAgentPrompt)
  const addErrorCard = useChatStore((s) => s.addErrorCard)
  const dismissConnectionErrors = useChatStore((s) => s.dismissConnectionErrors)
  const setCurrentStatus = useChatStore((s) => s.setCurrentStatus)
  const setPendingInteraction = useChatStore((s) => s.setPendingInteraction)
  const clearPendingInteraction = useChatStore((s) => s.clearPendingInteraction)
  const setLoading = useChatStore((s) => s.setLoading)
  const setStreaming = useChatStore((s) => s.setStreaming)
  const clearReportContent = useChatStore((s) => s.clearReportContent)
  const storeCreateConversation = useChatStore((s) => s.createConversation)
  const setCurrentUser = useChatStore((s) => s.setCurrentUser)
  const storeSelectConversation = useChatStore((s) => s.selectConversation)
  const respondToPrompt = useChatStore((s) => s.respondToPrompt)
  const startDeepResearch = useChatStore((s) => s.startDeepResearch)
  const addDeepResearchBanner = useChatStore((s) => s.addDeepResearchBanner)
  const addPlanMessage = useChatStore((s) => s.addPlanMessage)
  const updatePlanMessageResponse = useChatStore((s) => s.updatePlanMessageResponse)
  const updateConversationTitle = useChatStore((s) => s.updateConversationTitle)

  // Sync authenticated user ID to store when auth state changes
  useEffect(() => {
    const userId = user?.id ?? null
    setCurrentUser(userId)
  }, [user?.id, setCurrentUser])

  /**
   * Classify a transport failure as auth-related or generic connection error.
   * Used when the backend is healthy but the WebSocket/SSE connection failed,
   * which typically means the auth cookie or token drifted.
   */
  const isSessionExpired = !authRequired ? false : !user && !authLoading

  const getTransportFailure = useCallback(
    (message: string, details?: string): { code: ErrorCode; message: string; details?: string } => {
      if (!authRequired) {
        return { code: 'connection.failed', message, details }
      }
      if (isSessionExpired || isLikelyAuthRelatedTransportError(message)) {
        return {
          code: 'auth.session_expired' as ErrorCode,
          message: 'Your session has expired. Please sign in again to continue.',
          details,
        }
      }
      return { code: 'connection.failed', message, details }
    },
    [authRequired, isSessionExpired]
  )

  const clearUnacknowledgedOutgoingTimeout = useCallback((): void => {
    if (unacknowledgedOutgoingTimeoutRef.current) {
      clearTimeout(unacknowledgedOutgoingTimeoutRef.current)
      unacknowledgedOutgoingTimeoutRef.current = null
    }
  }, [])

  const clearUnacknowledgedOutgoing = useCallback((): void => {
    unacknowledgedOutgoingRef.current = null
    clearUnacknowledgedOutgoingTimeout()
  }, [clearUnacknowledgedOutgoingTimeout])

  const failUnacknowledgedOutgoing = useCallback((): void => {
    if (currentThinkingStepIdRef.current) {
      completeThinkingStep(currentThinkingStepIdRef.current)
      currentThinkingStepIdRef.current = null
      currentStatusRef.current = null
    }

    addErrorCard(
      'connection.failed',
      'No response received from the server. Please try again.',
    )
    setCurrentStatus(null)
    setStreaming(false)
    setLoading(false)
    clearPendingInteraction()
    lastSentOutgoingRef.current = null
    pendingOutgoingRef.current = null
    clearUnacknowledgedOutgoing()
  }, [
    addErrorCard,
    clearPendingInteraction,
    clearUnacknowledgedOutgoing,
    completeThinkingStep,
    setCurrentStatus,
    setLoading,
    setStreaming,
  ])

  const clearStreamingWatchdog = useCallback((): void => {
    if (streamingWatchdogTimeoutRef.current) {
      clearTimeout(streamingWatchdogTimeoutRef.current)
      streamingWatchdogTimeoutRef.current = null
    }
  }, [])

  /**
   * Fired when a streaming turn goes silent for too long. End the turn the
   * same way an interrupt does (complete the open thinking step, reset
   * streaming/loading/status, clear any HITL prompt), drop the resend buffers
   * so nothing replays behind the user's back, and surface the existing
   * timeout banner so the user can retry.
   */
  const handleStreamingWatchdogTimeout = useCallback((): void => {
    clearStreamingWatchdog()
    // Only act if we're still streaming -- a terminal frame may have landed
    // in the same tick the timer fired.
    if (!useChatStore.getState().isStreaming) return

    if (currentThinkingStepIdRef.current) {
      completeThinkingStep(currentThinkingStepIdRef.current)
      currentThinkingStepIdRef.current = null
      currentStatusRef.current = null
    }

    // Reuse the interrupted-turn banner: warning status, "please resend".
    addErrorCard(
      'agent.response_interrupted',
      'The assistant stopped responding. Please resend your message.',
    )
    setCurrentStatus(null)
    setStreaming(false)
    setLoading(false)
    clearPendingInteraction()
    lastSentOutgoingRef.current = null
    pendingOutgoingRef.current = null
    clearUnacknowledgedOutgoing()
  }, [
    addErrorCard,
    clearPendingInteraction,
    clearStreamingWatchdog,
    clearUnacknowledgedOutgoing,
    completeThinkingStep,
    setCurrentStatus,
    setLoading,
    setStreaming,
  ])

  /**
   * (Re)arm the watchdog. Called when a turn starts and on every inbound
   * frame so the deadline is measured from the last sign of life.
   */
  const armStreamingWatchdog = useCallback((): void => {
    clearStreamingWatchdog()
    streamingWatchdogTimeoutRef.current = setTimeout(
      handleStreamingWatchdogTimeout,
      STREAMING_INACTIVITY_TIMEOUT_MS,
    )
  }, [clearStreamingWatchdog, handleStreamingWatchdogTimeout])

  const handleUnacknowledgedOutgoingTimeout = useCallback((): void => {
    const unacknowledged = unacknowledgedOutgoingRef.current
    if (!unacknowledged) return

    const activeConversationId = useChatStore.getState().currentConversation?.id
    const sameConversation =
      !unacknowledged.conversationId ||
      unacknowledged.conversationId === activeConversationId

    if (!sameConversation) {
      lastSentOutgoingRef.current = null
      pendingOutgoingRef.current = null
      clearUnacknowledgedOutgoing()
      return
    }

    if (
      unacknowledged.retryCount < MAX_UNACKNOWLEDGED_OUTGOING_REPLAYS
    ) {
      pendingOutgoingRef.current = {
        ...unacknowledged.payload,
        deliveryRetryCount: unacknowledged.retryCount + 1,
      } as PendingOutgoing
      clearUnacknowledgedOutgoing()
      rotateSocket('delivery-timeout')
      return
    }

    failUnacknowledgedOutgoing()
  }, [
    clearUnacknowledgedOutgoing,
    failUnacknowledgedOutgoing,
    rotateSocket,
  ])

  const trackSentOutgoing = useCallback(
    (payload: PendingOutgoing, outboundId: string): void => {
      const retryCount = payload.deliveryRetryCount ?? 0
      const conversationId = useChatStore.getState().currentConversation?.id ?? currentConversationId

      clearUnacknowledgedOutgoingTimeout()
      lastSentOutgoingRef.current = payload
      unacknowledgedOutgoingRef.current = {
        payload,
        outboundId,
        ackParentId: payload.kind === 'message' ? outboundId : payload.parentId,
        conversationId,
        retryCount,
      }
      unacknowledgedOutgoingTimeoutRef.current = setTimeout(
        handleUnacknowledgedOutgoingTimeout,
        UNACKNOWLEDGED_OUTGOING_ACK_TIMEOUT_MS,
      )
    },
    [
      clearUnacknowledgedOutgoingTimeout,
      currentConversationId,
      handleUnacknowledgedOutgoingTimeout,
    ]
  )

  const acknowledgeOutgoingDelivery = useCallback((parentId?: string): void => {
    const unacknowledged = unacknowledgedOutgoingRef.current
    if (!unacknowledged) return

    // Some NAT frames omit parent_id, and intermediate frames may carry an
    // internal step id rather than the original user-message id. Any backend
    // frame while this request is active proves the prior send crossed the
    // socket boundary, but when parent_id is present and matches our known
    // request ids we can be stricter.
    if (
      !parentId ||
      parentId === unacknowledged.ackParentId ||
      parentId === unacknowledged.outboundId
    ) {
      clearUnacknowledgedOutgoing()
    }
  }, [clearUnacknowledgedOutgoing])

  const sendOutgoingPayload = useCallback(
    (payload: PendingOutgoing): boolean => {
      const client = wsClientRef.current
      if (!client?.isConnected()) return false

      const outboundId = payload.kind === 'message'
        ? client.sendMessage(payload.content, payload.dataSources)
        : client.sendInteractionResponse(
          payload.interactionId,
          payload.parentId,
          payload.response,
        )

      if (!outboundId) return false
      trackSentOutgoing(payload, outboundId)
      return true
    },
    [trackSentOutgoing]
  )

  /**
   * Create WebSocket callbacks that route messages to the store
   */
  const createCallbacks = useCallback((): NATWebSocketClientCallbacks => {
    /**
     * Guard against stale messages from a previous (cancelled) workflow.
     * Returns true when the message should be dropped.
     */
    const isStaleMessage = (parentId?: string): boolean => {
      const activeId = wsClientRef.current?.activeParentId
      if (!parentId || !activeId) return false
      return parentId !== activeId
    }

    return {
      onResponse: (
        content: string,
        status: string,
        isFinal: boolean,
        parentId?: string,
        cards?: unknown[],
        deepResearchJobId?: string,
        answerConfidence?: 'low' | 'medium' | 'high',
        sources?: unknown[]
      ) => {
        // A response on the wire proves the post-rotation auth is alive --
        // clear the consecutive auth_expired counter so a *future* (and
        // therefore independent) auth_expired starts the silent-reconnect
        // budget from zero again.
        consecutiveAuthExpiredRef.current = 0

        if (isStaleMessage(parentId)) {
          console.warn('Dropping stale system_response (parent_id mismatch)', { parentId, active: wsClientRef.current?.activeParentId })
          return
        }

        // If the UI is no longer streaming, this response belongs to a
        // workflow that outlived its request lifecycle. Drop it before adding
        // content; otherwise stale final responses can duplicate agent replies.
        const { isStreaming: currentlyStreaming } = useChatStore.getState()
        if (!currentlyStreaming) {
          console.warn(
            isFinal
              ? 'Ignoring stale isFinal -- not currently streaming'
              : 'Ignoring stale system_response -- not currently streaming'
          )
          return
        }
        acknowledgeOutgoingDelivery(parentId)
        // A live frame proves the turn is progressing -- restart the
        // inactivity deadline from now.
        armStreamingWatchdog()

        // Validate grid cards carried on the response message
        const validatedCards: GridCard[] = validateGridCards(cards)

        // Deep research escalation signal. Prefer the STRUCTURED job id sent
        // as a dedicated field; fall back to regex-parsing the response prose
        // only for older backends that don't emit the structured field.
        const deepResearchMatch = content?.match(
          /Deep research job submitted\. Job ID: ([a-f0-9-]+)/i
        )
        const resolvedJobId = deepResearchJobId ?? deepResearchMatch?.[1]

        if (resolvedJobId) {
          const jobId = resolvedJobId
          // Get current state for plan messages and conversation
          const state = useChatStore.getState()
          const currentPlanMessages = state.planMessages
          const currentConversation = state.currentConversation

          // Derive a conversation title from the plan (preferred) or fall
          // back to the last user message.
          if (currentConversation) {
            let extractedTitle: string | null = null

            // First, look at all plan messages for a title
            for (const planMsg of currentPlanMessages) {
              if (extractedTitle) break

              // Pattern 1: JSON report_title field
              const jsonTitleMatch = planMsg.text.match(/"report_title":\s*"([^"]+)"/i)
              if (jsonTitleMatch) {
                extractedTitle = jsonTitleMatch[1]
                break
              }

              // Pattern 2: Markdown Report Title heading
              const reportTitleMatch = planMsg.text.match(/\*\*Report Title[:\s]*\*\*\s*\n?\s*\*?([^*\n]+)/i)
                || planMsg.text.match(/Report Title[:\s]*\n?\s*\*?([^*\n]+)/i)
              if (reportTitleMatch) {
                extractedTitle = reportTitleMatch[1].trim()
                break
              }

              // Pattern 3: First markdown heading
              const mdHeadingMatch = planMsg.text.match(/^#+\s+(.+?)(?:\n|$)/m)
              if (mdHeadingMatch) {
                extractedTitle = mdHeadingMatch[1].trim()
                break
              }
            }

            // Fallback: Use the last user message if no title found in plan
            if (!extractedTitle) {
              const userMessages = currentConversation.messages.filter((m) => m.role === 'user')
              const lastUserMsg = userMessages[userMessages.length - 1]
              // Skip simple greetings.
              if (lastUserMsg && lastUserMsg.content.length > 10) {
                extractedTitle = lastUserMsg.content
              }
            }

            if (extractedTitle) {
              // Clean up the title
              const cleanTitle = extractedTitle
                .replace(/^\*+|\*+$/g, '')
                .replace(/^["']|["']$/g, '')
                .trim()

              // Truncate to reasonable length
              const title = cleanTitle.length > 80
                ? cleanTitle.substring(0, 77) + '...'
                : cleanTitle

              if (title.length > 0) {
                updateConversationTitle(currentConversation.id, title)
              }
            }
          }

          // Add 'starting' banner as a persistent message
          addDeepResearchBanner('starting', jobId)

          // Empty-content tracking message carries job metadata for session
          // restoration; AgentResponse returns null for empty content so it
          // won't render.
          const messageId = addAgentResponseWithMeta(
            '',
            false,
            {
              deepResearchJobId: jobId,
              deepResearchJobStatus: 'submitted',
              isDeepResearchActive: true,
              planMessages: currentPlanMessages.length > 0 ? [...currentPlanMessages] : undefined,
            },
            validatedCards
          )
          // Start deep research SSE streaming bound to this message
          startDeepResearch(jobId, messageId)
          // Hand off to the deep-research SSE stream: it drives its own
          // progress signal, so the WS inactivity watchdog must stand down
          // (no WS frames arrive during deep research).
          clearStreamingWatchdog()
          // Keep isStreaming=true to block input -- deep research SSE will
          // release it on completion.
          setLoading(false)
          // Don't add this as final response - let SSE handle the rest
          return
        }

        // reportContent is only populated by deep research SSE events
        // (use-deep-research.ts), not by regular WebSocket responses.
        //
        // Answer frames are routed by their frame SEMANTICS (status), not any
        // client flag: `in_progress` frames are deltas that accumulate into a
        // single bubble; the terminal `complete` frame replaces the text with
        // the authoritative full answer and attaches cards/sources/confidence.
        // With the legacy single-frame backend this collapses to "one delta
        // (full text + cards) then an empty complete", which finalizes the same
        // one bubble — identical to the previous single-shot behaviour.
        const citations = citationsFromWireList(sources)
        if (isFinal) {
          finalizeAgentResponse(content, validatedCards, answerConfidence, citations)
        } else if ((content && content.trim()) || validatedCards.length > 0) {
          appendAgentResponseDelta(content, validatedCards, answerConfidence, citations)
        }

        // status: "complete" with null text signals task completion
        if (isFinal) {
          // Turn finished -- stand the inactivity watchdog down.
          clearStreamingWatchdog()
          // Complete any pending thinking step
          if (currentThinkingStepIdRef.current) {
            completeThinkingStep(currentThinkingStepIdRef.current)
            currentThinkingStepIdRef.current = null
            currentStatusRef.current = null
          }

          // Stop streaming and mark complete
          setStreaming(false)
          setCurrentStatus('complete')

          // Clear any pending interaction (HITL prompt) on completion
          clearPendingInteraction()

          // Workflow finished cleanly -- drop the resend buffer.
          lastSentOutgoingRef.current = null
        }
      },

      onIntermediateStep: (content: NATIntermediateStepContent | string, status: string, _parentId?: string) => {
        // Same as onResponse: any backend-emitted frame on this socket
        // proves the rotated handshake is honoured. Reset the consecutive
        // auth_expired budget.
        consecutiveAuthExpiredRef.current = 0

        // NAT uses an internal step ID (not the user message ID) for
        // parent_id on intermediate steps, so we can't stale-detect via
        // parent_id. Guard on isStreaming instead: if not streaming, the
        // workflow was already cancelled/disconnected.
        const { isStreaming: currentlyStreaming } = useChatStore.getState()
        if (!currentlyStreaming) {
          console.warn('Ignoring stale intermediate step -- not currently streaming')
          return
        }
        // This is the same signal that makes ChatThinking appear in the UI:
        // after the streaming stale guard, any intermediate frame proves the
        // backend received the outbound message even when NAT uses internal
        // workflow parent IDs that do not match the user-message id.
        clearUnacknowledgedOutgoing()
        // Progress signal -- restart the inactivity deadline.
        armStreamingWatchdog()

        // Legacy string-content path: synthesize a generic thinking step.
        if (typeof content === 'string') {
          // For plain string content, create a generic thinking step
          if (content && content.trim()) {
            const stepId = addThinkingStep({
              category: 'agents',
              functionName: 'unknown',
              displayName: 'Processing',
              content: content + '\n',
              isComplete: false,
            })
            currentThinkingStepIdRef.current = stepId
            currentStatusRef.current = 'thinking'
          }
          return
        }

        // Parse structured content with name and payload
        if (!content.name) return

        const { functionName, isComplete } = parseFunctionName(content.name)
        const category = mapFunctionToCategory(functionName)
        const workflowLabel = getWorkflowDisplayName(functionName)
        const displayName = workflowLabel || getDisplayName(functionName)
        const isTopLevel = isFunctionStepName(content.name)
        const formattedPayload = formatPayload(content.payload || '')

        // Check if we already have a step for this function
        const existingStep = findThinkingStepByFunctionName(functionName)

        if (isComplete && existingStep) {
          // Update existing step with complete status and final content
          updateThinkingStepByFunctionName(functionName, formattedPayload, true)
        } else if (existingStep) {
          // Defensive: shouldn't usually fire (a step is normally either new
          // or transitioning to complete), but handle gracefully.
          appendToThinkingStep(existingStep.id, '\n' + formattedPayload)
        } else {
          // Create new step for this function (or model/tool sub-call)
          const stepId = addThinkingStep({
            category,
            functionName,
            displayName,
            content: formattedPayload,
            rawPayload: content.payload,
            isComplete,
            isTopLevel,
          })
          currentThinkingStepIdRef.current = stepId
          currentStatusRef.current = 'thinking'
        }

        // Update status based on message status
        if (status === 'in_progress') {
          setCurrentStatus('thinking')
        }
      },

      onHumanPrompt: (promptId: string, parentId: string, prompt: NATHumanPrompt) => {
        acknowledgeOutgoingDelivery(parentId)

        // Store the pending interaction for the UI to handle
        const inputType = prompt.input_type as PendingInteraction['inputType']
        const interaction: PendingInteraction = {
          id: promptId,
          parentId,
          inputType,
          text: prompt.text,
          options: prompt.options,
          defaultValue: prompt.default_value,
        }
        setPendingInteraction(interaction)

        // Add to local plan state FIRST so it's captured when the prompt message is
        // saved (addAgentPrompt below snapshots planMessages for session
        // restoration).
        addPlanMessage({
          text: prompt.text,
          inputType: prompt.input_type as 'text' | 'multiple_choice' | 'binary_choice' | 'approval' | 'notification',
        })

        // Add as an agent prompt in the chat with HITL routing info for persistence
        // This captures current planMessages (including the one just added) for session restoration
        const promptType = mapHumanPromptType(prompt.input_type)
        addAgentPrompt(promptType, prompt.text, prompt.options, undefined, promptId, parentId, inputType)

        // Pause streaming while waiting for user response. The user may take
        // arbitrarily long to answer, so stand the inactivity watchdog down.
        clearStreamingWatchdog()
        setStreaming(false)
        setLoading(false)
      },

      onError: async (errorContent: NATErrorContent) => {
        // Any error resolves the current turn one way or another; stand the
        // inactivity watchdog down. Paths that keep streaming alive (the
        // auth_expired rotation below) re-arm it before they return.
        clearStreamingWatchdog()

        // Auth expired mid-workflow: backend contract is `code ===
        // 'user_auth_error'` + `message === 'auth_expired'` (see
        // websocket_reconnect.py `_send_auth_expired_error`). Buffer the
        // just-sent payload, rotate the socket, and let
        // `onConnectionChange('connected')` re-issue the message once the
        // fresh handshake completes. We deliberately do NOT touch
        // `isStreaming` or the thinking step so the user's "request in
        // progress" UX bridges the rotation seamlessly.
        //
        // Match BOTH fields, not just `message`. A future application
        // error that happens to carry `message: 'auth_expired'` (agent
        // text, validation message) would otherwise be silently swallowed
        // and trigger a phantom reconnect instead of surfacing as a
        // banner.
        if (errorContent.code === 'user_auth_error' && errorContent.message === 'auth_expired') {
          // Cap on consecutive auth_expired rotations: without it, a stale
          // token or clock-skew condition can drive a silent rotation loop --
          // rotate() resets reconnectCount, so the WS client's own
          // CONNECTION_FAILED safety net never triggers on this path. See
          // MAX_CONSECUTIVE_AUTH_EXPIRED.
          consecutiveAuthExpiredRef.current += 1
          if (consecutiveAuthExpiredRef.current > MAX_CONSECUTIVE_AUTH_EXPIRED) {
            consecutiveAuthExpiredRef.current = 0
            lastSentOutgoingRef.current = null
            pendingOutgoingRef.current = null
            clearUnacknowledgedOutgoing()
            addErrorCard(
              'auth.session_expired' as ErrorCode,
              'Your session has expired. Please sign in again to continue.',
              errorContent.details,
            )
            setCurrentStatus(null)
            setStreaming(false)
            setLoading(false)
            clearPendingInteraction()
            return
          }

          const lastSent = lastSentOutgoingRef.current
          if (lastSent) {
            pendingOutgoingRef.current = lastSent
          }
          clearUnacknowledgedOutgoing()
          // The turn stays "in progress" across the rotation, so keep a
          // deadline running against the fresh socket.
          armStreamingWatchdog()
          rotateSocket('auth_expired')
          return
        }

        // Connection failure (all client retries exhausted) -- gate the UI
        // on a health check so we can distinguish "backend down" from a
        // likely auth/cookie drift.
        if (errorContent.code === 'CONNECTION_FAILED') {
          // Reason discovery: the gateway refuses a budget-exhausted upgrade
          // with a bare failed handshake the browser can't read, so it looks
          // identical to a network outage here. Ask the diagnostics endpoint
          // once per failure episode; if it's a budget block, surface the
          // distinct non-retryable banner instead of "check your network".
          if (!budgetDiagnosticsCheckedRef.current) {
            budgetDiagnosticsCheckedRef.current = true
            const budgetMessage = await discoverBudgetFailureMessage()
            if (budgetMessage) {
              addErrorCard('budget.exhausted', budgetMessage)
              setCurrentStatus(null)
              setStreaming(false)
              setLoading(false)
              clearPendingInteraction()
              lastSentOutgoingRef.current = null
              pendingOutgoingRef.current = null
              clearUnacknowledgedOutgoing()
              return
            }
          }

          const backendUp = await checkBackendHealthCached()

          const errorInfo = backendUp
            ? getTransportFailure(errorContent.message, errorContent.details)
            : { code: 'connection.failed' as const, message: errorContent.message, details: errorContent.details }

          addErrorCard(errorInfo.code, errorInfo.message, errorInfo.details)
          setCurrentStatus(null)
          setStreaming(false)
          setLoading(false)
          clearPendingInteraction()
          // UI is now in a failure state. Drop both buffers so a later
          // recovery-driven `connected` cannot silently replay the
          // pre-rotation payload behind the user's back.
          lastSentOutgoingRef.current = null
          pendingOutgoingRef.current = null
          clearUnacknowledgedOutgoing()
          return
        }

        // Application-level errors from the backend (agent errors, etc.).
        if (currentThinkingStepIdRef.current) {
          completeThinkingStep(currentThinkingStepIdRef.current)
          currentThinkingStepIdRef.current = null
          currentStatusRef.current = null
        }

        // Map NAT error to frontend error code and display error card
        const errorCode = mapNATErrorToErrorCode(errorContent.code)
        addErrorCard(
          errorCode,
          errorContent.message,
          errorContent.details,
        )

        setCurrentStatus(null)
        setStreaming(false)
        setLoading(false)

        // Clear any pending interaction on error
        clearPendingInteraction()
        // Symmetric with CONNECTION_FAILED: any buffered outgoing payload
        // (preflight rotation, auth_expired) is no longer something the
        // user expects to be re-sent once we've shown them an error card.
        lastSentOutgoingRef.current = null
        pendingOutgoingRef.current = null
        clearUnacknowledgedOutgoing()
      },

      onConnectionChange: (status, context?: ConnectionChangeContext) => {
        setIsConnected(status === 'connected')

        if (status === 'connected') {
          invalidateHealthCache()
          dismissConnectionErrors()
          // Fresh, healthy socket -- a later failure is a new episode, so let
          // budget-reason discovery run again.
          budgetDiagnosticsCheckedRef.current = false

          // Drain any payload buffered by a pre-flight rotation or
          // `auth_expired`. Keeps the UX silent: the user acted once and
          // it goes out the moment the fresh socket is up. Dispatch by
          // `kind` so both chat messages AND HITL interaction responses
          // survive a rotation -- the backend's per-message expiry gate
          // applies to both.
          const pending = pendingOutgoingRef.current
          const client = wsClientRef.current
          if (pending && client) {
            pendingOutgoingRef.current = null
            if (sendOutgoingPayload(pending)) {
              // A buffered turn just went back on the wire -- (re)start the
              // inactivity deadline for it.
              armStreamingWatchdog()
              // Match each send path's loading contract: chat sends clear the
              // composer spinner after putting the message on the wire, while
              // HITL answers keep it visible until the backend processes them.
              setLoading(pending.kind === 'interaction')
            } else {
              pendingOutgoingRef.current = pending
            }
          }
          return
        }

        // Intentional disconnects (session switch, cleanup) shouldn't
        // surface as errors.
        if (context?.intentional) return

        if (status === 'error' || status === 'disconnected') {
          const unacknowledged = unacknowledgedOutgoingRef.current
          if (unacknowledged) {
            const activeConversationId = useChatStore.getState().currentConversation?.id
            const sameConversation =
              !unacknowledged.conversationId ||
              unacknowledged.conversationId === activeConversationId

            if (
              sameConversation &&
              unacknowledged.retryCount < MAX_UNACKNOWLEDGED_OUTGOING_REPLAYS
            ) {
              pendingOutgoingRef.current = {
                ...unacknowledged.payload,
                deliveryRetryCount: unacknowledged.retryCount + 1,
              } as PendingOutgoing
              clearUnacknowledgedOutgoing()
              return
            }

            clearUnacknowledgedOutgoing()
            lastSentOutgoingRef.current = null
            pendingOutgoingRef.current = null
          }

          // Don't show error cards here -- the WS client only fires
          // onError(CONNECTION_FAILED) after all retries are exhausted,
          // and the health-check gate there decides whether to show UI.
          if (currentThinkingStepIdRef.current) {
            completeThinkingStep(currentThinkingStepIdRef.current)
            currentThinkingStepIdRef.current = null
            currentStatusRef.current = null
          }

          // Reset streaming/loading state if connection dropped mid-request
          clearStreamingWatchdog()
          setStreaming(false)
          setLoading(false)
          clearPendingInteraction()
        }
      },
    }
  }, [
    appendAgentResponseDelta,
    finalizeAgentResponse,
    addAgentResponseWithMeta,
    addThinkingStep,
    appendToThinkingStep,
    completeThinkingStep,
    updateThinkingStepByFunctionName,
    findThinkingStepByFunctionName,
    addAgentPrompt,
    addErrorCard,
    dismissConnectionErrors,
    setCurrentStatus,
    setPendingInteraction,
    clearPendingInteraction,
    setLoading,
    setStreaming,
    startDeepResearch,
    addDeepResearchBanner,
    addPlanMessage,
    updateConversationTitle,
    getTransportFailure,
    rotateSocket,
    acknowledgeOutgoingDelivery,
    clearUnacknowledgedOutgoing,
    sendOutgoingPayload,
    armStreamingWatchdog,
    clearStreamingWatchdog,
    discoverBudgetFailureMessage,
  ])

  /**
   * Latest callback set + auth-refresh fn, mirrored into refs so the socket
   * lifecycle effect below can depend ONLY on the conversation id.
   *
   * ROOT CAUSE of the connect/disconnect churn this fixes: the lifecycle
   * effect used to list `createCallbacks` and `refreshAuthBeforeReconnect` in
   * its dependency array. Its cleanup unconditionally closes the socket and
   * nulls the ref, so any render where either identity changed tore the socket
   * down and the re-run opened a fresh one. `refreshAuthBeforeReconnect`
   * depends on `getAccessToken`, which AuthKit's `useAccessToken()` returns as
   * a NEW function reference whenever the access-token state updates -- and
   * this hook re-renders constantly while a turn streams (it subscribes to
   * isStreaming / thinkingSteps / status). The net effect was a socket that
   * reconnected repeatedly (each rotate()/reconnect also resets the client's
   * reconnect counter, so its own CONNECTION_FAILED backstop never tripped).
   * Routing both through refs keeps the socket stable for the conversation's
   * lifetime while the callbacks still observe fresh state via getState().
   */
  const latestCallbacksRef = useRef<NATWebSocketClientCallbacks>({})
  const latestRefreshAuthRef = useRef<() => Promise<void>>(async () => {})
  const memoizedCallbacks = useMemo(() => createCallbacks(), [createCallbacks])
  latestCallbacksRef.current = memoizedCallbacks
  latestRefreshAuthRef.current = refreshAuthBeforeReconnect

  /**
   * Build a WebSocket client whose callbacks and auth-refresh hook delegate to
   * the refs above. Stable (empty deps) so creating a client never depends on
   * a changing callback identity. Seeds projectId from the store like the
   * lifecycle effect did; later project changes are pushed via updateProjectId.
   */
  const buildWsClient = useCallback((conversationId: string): NATWebSocketClient => {
    return createNATWebSocketClient({
      conversationId,
      projectId: useChatStore.getState().projectId || undefined,
      callbacks: {
        onResponse: (...args) => latestCallbacksRef.current.onResponse?.(...args),
        onIntermediateStep: (...args) => latestCallbacksRef.current.onIntermediateStep?.(...args),
        onHumanPrompt: (...args) => latestCallbacksRef.current.onHumanPrompt?.(...args),
        onError: (...args) => latestCallbacksRef.current.onError?.(...args),
        onConnectionChange: (...args) => latestCallbacksRef.current.onConnectionChange?.(...args),
      },
      onBeforeReconnect: () => latestRefreshAuthRef.current(),
    })
  }, [])

  /**
   * Initialize WebSocket client when conversation changes
   */
  useEffect(() => {
    if (!currentConversationId || !autoConnect) return

    // Create new client if needed. Seed projectId from the store at creation
    // time; subsequent changes are pushed by the dedicated projectId effect
    // below (which rotates the socket cleanly). We deliberately do NOT key this
    // effect on projectId -- doing so tears the socket down mid-connect and
    // produces "closed before the connection is established" churn.
    if (!wsClientRef.current) {
      wsClientRef.current = buildWsClient(currentConversationId)
      wsClientRef.current.connect()
    } else {
      // Update conversation ID on existing client
      wsClientRef.current.updateConversationId(currentConversationId)
    }

    // Cleanup on unmount or conversation switch.
    //
    // CRITICAL: the resend buffers (pendingOutgoingRef,
    // lastSentOutgoingRef) and the consecutive-auth_expired counter are
    // conversation-scoped state. If we leave them populated across a
    // conversation switch, the next conversation's freshly-handshaken
    // socket would drain a payload from the previous conversation into
    // its own backend session on the first `connected` event -- a
    // user-data leak across conversation boundaries.
    //
    // Same goes for currentThinkingStepIdRef / currentStatusRef:
    // stale IDs from the previous conversation must not be reused
    // against the new socket.
    return () => {
      if (wsClientRef.current) {
        wsClientRef.current.disconnect()
        wsClientRef.current = null
      }
      const { isStreaming: wasStreaming, isLoading: wasLoading, currentStatus: status } =
        useChatStore.getState()
      if (wasStreaming || wasLoading || status !== null) {
        setStreaming(false)
        setLoading(false)
        setCurrentStatus(null)
      }
      pendingOutgoingRef.current = null
      lastSentOutgoingRef.current = null
      clearUnacknowledgedOutgoing()
      clearStreamingWatchdog()
      consecutiveAuthExpiredRef.current = 0
      budgetDiagnosticsCheckedRef.current = false
      pendingRotationRef.current = false
      currentThinkingStepIdRef.current = null
      currentStatusRef.current = null
    }
  }, [
    currentConversationId,
    autoConnect,
    buildWsClient,
    clearUnacknowledgedOutgoing,
    clearStreamingWatchdog,
    setStreaming,
    setLoading,
    setCurrentStatus,
  ])

  /**
   * Push project id changes onto the live socket WITHOUT tearing it down.
   *
   * The socket lifecycle above is tied to the conversation, not the project.
   * When the project store resolves after the socket was created (the first-load
   * race), this effect hands the new id to the existing client, which rotates
   * the connection atomically (rotate() swaps the socket in one step, avoiding
   * the close-before-open race) so the handshake re-sends the project scope and
   * the backend gets x-grid-project-context. No-ops when the id is unchanged.
   */
  useEffect(() => {
    wsClientRef.current?.updateProjectId(projectId || undefined)
  }, [projectId])

  /**
   * Send a message via WebSocket
   */
  const sendMessage = useCallback(
    (content: string): boolean => {
      if (!content.trim()) return false

      // Collect metadata about data sources and files before adding user message
      const layoutState = useLayoutStore.getState()
      const enabledDataSources = layoutState.enabledDataSourceIds

      // Get session files
      const sessionId = useChatStore.getState().currentConversation?.id
      const trackedFiles = useDocumentsStore.getState().trackedFiles
      const sessionFiles = sessionId
        ? trackedFiles.filter(
            (f) => f.collectionName === sessionId && (f.status === 'ingesting' || f.status === 'success')
          )
        : []

      // Keep internal knowledge available for base/project/session corpora even though it is hidden from toggles.
      const dataSourcesForMessage = layoutState.knowledgeLayerAvailable
        ? Array.from(new Set([...enabledDataSources, 'knowledge_layer']))
        : enabledDataSources

      // Prepare file metadata for display
      const messageFiles = sessionFiles.map((f) => ({
        id: f.id,
        fileName: f.fileName,
      }))

      // Add user message to store with metadata
      addUserMessage(content, {
        enabledDataSources: dataSourcesForMessage,
        messageFiles,
      })

      // currentConversation may have just been created inside addUserMessage.
      const storeState = useChatStore.getState()
      const conversationId = storeState.currentConversation?.id

      // thinkingSteps are NOT cleared here -- they persist per userMessageId
      // so chat history still renders prior thinking blocks.
      clearReportContent()
      clearPendingInteraction()

      // Reset tracking refs
      currentThinkingStepIdRef.current = null
      currentStatusRef.current = null

      // Set initial status; first real step will be "Workflow: Chat Researcher" from backend
      setCurrentStatus('thinking')
      setStreaming(true)
      setLoading(true)

      const outgoingPayload: PendingOutgoing = {
        kind: 'message',
        content,
        dataSources: dataSourcesForMessage,
      }

      // Helper to actually send the message
      const doSend = (): boolean => {
        if (sendOutgoingPayload(outgoingPayload)) {
          // Turn is on the wire -- start the overall inactivity deadline.
          armStreamingWatchdog()
          setLoading(false)
          return true
        }
        clearStreamingWatchdog()
        addErrorCard('connection.failed', 'WebSocket connection failed')
        setStreaming(false)
        setLoading(false)
        return false
      }

      // Pre-flight: the socket may report connected, but if its JWT is
      // already past `exp` (e.g. after a long idle / laptop sleep) the
      // backend is still trusting a dead token. Buffer + rotate; the
      // buffer is drained from `onConnectionChange('connected')`.
      const tokenIsStale = (): boolean => {
        if (!authRequired || !activeSocketTokenExpiresAt) return false
        return Date.now() >= activeSocketTokenExpiresAt * 1000
      }

      if (wsClientRef.current?.isConnected() && tokenIsStale()) {
        pendingOutgoingRef.current = outgoingPayload
        rotateSocket('preflight')
        return true
      }

      if (wsClientRef.current?.isConnected()) {
        return doSend()
      } else if (conversationId) {
        // A client can exist but still be handshaking or reconnecting.
        // Queue this outbound payload for the normal 'connected' drain
        // instead of replacing the client and creating a parallel socket.
        pendingOutgoingRef.current = outgoingPayload

        if (!wsClientRef.current) {
          // buildWsClient seeds projectId from the store; the updateProjectId
          // effect only fires when the store value CHANGES, so a client created
          // without it would handshake unscoped for its whole life.
          wsClientRef.current = buildWsClient(conversationId)
        }
        void wsClientRef.current.connect()
        return true
      } else {
        // Defensive: shouldn't happen because addUserMessage creates a
        // conversation if one is missing.
        clearStreamingWatchdog()
        addErrorCard('system.unknown', 'No active conversation')
        setStreaming(false)
        setLoading(false)
        return false
      }
    },
    [
      addUserMessage,
      addErrorCard,
      clearReportContent,
      clearPendingInteraction,
      setCurrentStatus,
      setStreaming,
      setLoading,
      buildWsClient,
      rotateSocket,
      sendOutgoingPayload,
      armStreamingWatchdog,
      clearStreamingWatchdog,
      authRequired,
      activeSocketTokenExpiresAt,
    ]
  )

  /**
   * Respond to a pending interaction (clarification, approval, etc.)
   *
   * Mirrors `sendMessage`'s rotation handling: the backend applies the
   * same per-message JWT expiry gate to `WebSocketUserInteractionResponseMessage`
   * as it does to chat messages, so a HITL response that lands right after
   * token expiry would otherwise be silently lost (no `lastSentOutgoingRef`
   * for the rotation handler to replay). Preflight on stale token, buffer
   * the typed payload, and let `onConnectionChange('connected')` drain it
   * via `sendInteractionResponse` once the fresh handshake completes.
   */
  const respondToInteraction = useCallback(
    (response: string) => {
      if (!pendingInteraction) {
        console.warn('No pending interaction to respond to')
        return
      }

      // Mark the most recent unanswered prompt message as responded.
      const messages = currentConversation?.messages ?? []
      const lastPrompt = [...messages]
        .reverse()
        .find((m) => m.messageType === 'prompt' && !m.isPromptResponded)
      if (lastPrompt) {
        respondToPrompt(lastPrompt.id, response)
      }

      // Update the last plan message with the user response
      const currentPlanMessages = useChatStore.getState().planMessages
      if (currentPlanMessages.length > 0) {
        const lastPlanMessage = currentPlanMessages[currentPlanMessages.length - 1]
        if (!lastPlanMessage.userResponse) {
          updatePlanMessageResponse(lastPlanMessage.id, response)
        }
      }

      const interactionPayload: PendingOutgoing = {
        kind: 'interaction',
        interactionId: pendingInteraction.id,
        parentId: pendingInteraction.parentId,
        response,
      }

      const doSend = () => {
        if (sendOutgoingPayload(interactionPayload)) {
          setStreaming(true)
          setLoading(true)
          // HITL answer is on the wire -- resume the inactivity deadline.
          armStreamingWatchdog()
        } else {
          addErrorCard('connection.failed', 'WebSocket not connected')
        }
      }

      // Stale-token pre-flight (mirrors sendMessage): the socket may
      // report connected, but if the handshake JWT is already past `exp`
      // the backend will respond with `auth_expired` and our HITL response
      // would be lost. Buffer + rotate; the drain re-issues it.
      const tokenIsStale = (): boolean => {
        if (!authRequired || !activeSocketTokenExpiresAt) return false
        return Date.now() >= activeSocketTokenExpiresAt * 1000
      }

      if (wsClientRef.current?.isConnected() && tokenIsStale()) {
        pendingOutgoingRef.current = interactionPayload
        // Keep the "working" UX visible across the rotation so the user
        // doesn't see their answer disappear into an idle screen.
        setStreaming(true)
        setLoading(true)
        rotateSocket('preflight-interaction')
        return
      }

      doSend()
    },
    [
      pendingInteraction,
      currentConversation?.messages,
      respondToPrompt,
      updatePlanMessageResponse,
      addErrorCard,
      setStreaming,
      setLoading,
      authRequired,
      activeSocketTokenExpiresAt,
      rotateSocket,
      sendOutgoingPayload,
      armStreamingWatchdog,
    ]
  )

  /**
   * Connect to WebSocket
   */
  const connect = useCallback(() => {
    if (wsClientRef.current) {
      wsClientRef.current.connect()
    } else if (currentConversation) {
      wsClientRef.current = buildWsClient(currentConversation.id)
      wsClientRef.current.connect()
    }
  }, [currentConversation, buildWsClient])

  // Activate recovery polling when connection error cards are visible
  useConnectionRecovery(connect)

  /**
   * Soft-rotation timer. If idle when it fires, rotate immediately; if a
   * stream is in flight, set `pendingRotationRef` and let the deferred
   * effect below rotate once the stream ends so we never cut a response.
   */
  useEffect(() => {
    if (!authRequired || !activeSocketTokenExpiresAt) return

    let cancelled = false
    let softTimer: ReturnType<typeof setTimeout> | undefined

    const onSoftFire = (): void => {
      if (cancelled) return
      if (useChatStore.getState().isStreaming) {
        pendingRotationRef.current = true
        return
      }
      rotateSocket('soft')
    }

    const now = Date.now()
    const expMs = activeSocketTokenExpiresAt * 1000
    const softAt = expMs - WS_REFRESH_SOFT_GUARD_SECONDS * 1000

    if (softAt > now) {
      softTimer = setTimeout(onSoftFire, softAt - now)
    } else {
      // Already inside the soft window on first effect run (e.g. mount
      // with a near-expiry token).
      onSoftFire()
    }

    return () => {
      cancelled = true
      if (softTimer) clearTimeout(softTimer)
    }
  }, [activeSocketTokenExpiresAt, authRequired, rotateSocket])

  /**
   * Drains a deferred rotation the moment the stream ends. Cleared
   * synchronously so a follow-up stream doesn't double-rotate before the
   * next soft timer arms.
   */
  useEffect(() => {
    if (!isStreaming && pendingRotationRef.current) {
      pendingRotationRef.current = false
      rotateSocket('deferred')
    }
  }, [isStreaming, rotateSocket])

  const disconnect = useCallback(() => {
    if (wsClientRef.current) {
      wsClientRef.current.disconnect()
    }
    setStreaming(false)
    setLoading(false)
  }, [setStreaming, setLoading])

  /**
   * Cancel path for the store's `stopStreaming()` action [C1]. The store action
   * owns the UI-state reset (flush batched deltas, finalize the streaming
   * bubble, clear isStreaming/isLoading/currentStatus); here we tear down the
   * socket. `disconnect()` closes it intentionally, so the onConnectionChange
   * handler returns early (no error card, no auto-replay), and the existing
   * `activeParentId` stale-guard in createCallbacks drops any frame still in
   * flight for the cancelled turn. Stand the watchdog down and drop the resend
   * buffers so a cancelled turn never replays behind the user's back.
   */
  const cancelStreaming = useCallback(() => {
    clearStreamingWatchdog()
    lastSentOutgoingRef.current = null
    pendingOutgoingRef.current = null
    clearUnacknowledgedOutgoing()
    disconnect()
  }, [clearStreamingWatchdog, clearUnacknowledgedOutgoing, disconnect])

  // Register the cancel path so useChatStore.getState().stopStreaming() (called
  // from the composer's stop button) can reach the socket without importing the
  // hook. Cleared on unmount.
  useEffect(() => {
    registerStopStreamingHandler(cancelStreaming)
    return () => registerStopStreamingHandler(null)
  }, [cancelStreaming])

  /**
   * Create a new conversation
   */
  const createConversation = useCallback(() => {
    storeCreateConversation()
  }, [storeCreateConversation])

  /**
   * Select a conversation by ID
   */
  const selectConversation = useCallback(
    (conversationId: string) => {
      storeSelectConversation(conversationId)
    },
    [storeSelectConversation]
  )

  const messages = currentConversation?.messages ?? EMPTY_MESSAGES
  const userConversations = useMemo(
    () => (currentUserId ? conversations.filter((c) => c.userId === currentUserId) : EMPTY_CONVERSATIONS),
    [conversations, currentUserId]
  )

  return {
    sendMessage,
    respondToInteraction,
    disconnect,
    connect,
    isConnected,
    isStreaming,
    isLoading,
    messages,
    conversation: currentConversation,
    createConversation,
    userConversations,
    selectConversation,
    thinkingSteps,
    reportContent,
    currentStatus,
    pendingInteraction,
  }
}
