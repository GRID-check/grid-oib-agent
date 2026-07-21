/**
 * WebSocket Client Adapter
 *
 * Handles WebSocket connections for the NAT protocol.
 * Supports system_response, system_intermediate, system_interaction,
 * and error message types for full HITL (human-in-the-loop) support.
 */

import { trackAuthEvent } from '@/shared/utils/rum'
import { getWebSocketUrl } from './config'
import {
  // NAT protocol types
  type NATIncomingMessage,
  type NATUserMessage,
  type NATUserInteractionResponse,
  type NATHumanPrompt,
  type NATIntermediateStepContent,
  type NATErrorContent,
  NATIncomingMessageSchema,
  NATMessageType,
  NATSchemaType,
  HumanPromptType,
} from './schemas'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/**
 * Transparency extras lifted onto the TERMINAL system_response frame (WP-A →
 * WP-B wire contract). Every field is optional and additive; absence means
 * "unknown/not applicable". Bundled into one object so the already-wide
 * `onResponse` signature does not grow another handful of positional params.
 */
export interface ResponseTransparency {
  /** Which path the turn took after intent classification. */
  routingDecision?: 'meta' | 'shallow' | 'deep' | 'error'
  /** Human-readable "why" for the routing decision (verbatim from classifier). */
  routingReason?: string
  /** Present only when a shallow→deep escalation happened this turn. */
  escalationReason?: string
  /**
   * Present only when confidence was downgraded. `'ungrounded'` = the answer
   * lost its citation grounding; `'quote_unverified'` = a quoted span did not
   * match any source passage.
   */
  answerConfidenceCappedReason?: 'ungrounded' | 'quote_unverified'
  /** Present only when citation verification removed ≥1 citation. */
  citationsRemoved?: { count: number; reasons: string[] }
  /** Marks the answer text as a queue-rejection notice, NOT a research answer. */
  jobAdmissionRejected?: boolean
  /** Retry hint (seconds) — only alongside jobAdmissionRejected. */
  retryAfterSeconds?: number
}

/** Context passed with connection status changes */
export interface ConnectionChangeContext {
  /** Whether the disconnect was intentional (e.g. session switch, cleanup) */
  intentional?: boolean
}

/** Callbacks for NAT WebSocket client */
export interface NATWebSocketClientCallbacks {
  /** Called when a system response message arrives (final or streaming content) */
  onResponse?: (
    content: string,
    status: string,
    isFinal: boolean,
    parentId?: string,
    cards?: unknown[],
    deepResearchJobId?: string,
    answerConfidence?: 'low' | 'medium' | 'high',
    sources?: unknown[],
    transparency?: ResponseTransparency
  ) => void
  /** Called when intermediate steps arrive (thinking, tool calls) */
  onIntermediateStep?: (content: NATIntermediateStepContent | string, status: string, parentId?: string) => void
  /** Called when a human prompt arrives (clarification, approval, etc.) */
  onHumanPrompt?: (promptId: string, parentId: string, prompt: NATHumanPrompt) => void
  /** Called when an error occurs */
  onError?: (error: NATErrorContent) => void
  /** Called when connection status changes */
  onConnectionChange?: (status: ConnectionStatus, context?: ConnectionChangeContext) => void
}

/** Options for NAT WebSocket client */
export interface NATWebSocketClientOptions {
  /** Conversation/session ID */
  conversationId: string
  /** Optional project ID to scope the backend collection */
  projectId?: string
  /** Callback functions */
  callbacks: NATWebSocketClientCallbacks
  /** Number of reconnection attempts (default: 3) */
  reconnectAttempts?: number
  /** Delay between reconnection attempts in ms (default: 1000) */
  reconnectDelay?: number
  /** Override WebSocket URL (uses same-origin by default, proxied through UI server) */
  websocketUrl?: string
  /**
   * Hook invoked before opening a new WebSocket (initial or reconnect).
   *
   * Used to refresh auth credentials so the upgrade request carries an up-to-date
   * httpOnly idToken cookie. The WebSocket handshake is the only point where the
   * backend (re)reads auth, so a stale cookie can leave a long-lived connection
   * authenticated by an expired token.
   *
   * Errors are swallowed -- the connect attempt proceeds regardless.
   */
  onBeforeReconnect?: () => Promise<void>
}

/**
 * NAT WebSocket client for AI-Q backend communication.
 * Supports full human-in-the-loop (HITL) features including
 * clarification prompts and approval flows.
 */
export class NATWebSocketClient {
  private ws: WebSocket | null = null
  private options: NATWebSocketClientOptions
  private reconnectCount = 0
  private isIntentionallyClosed = false
  private errorBeforeClose = false
  private messageIdCounter = 0
  /**
   * Message `type` values we've already warned about after a failed parse.
   * A never-before-seen or malformed frame type is logged ONCE here and then
   * silently ignored — an unknown/renamed backend frame must not spam the
   * console on every message or fail the whole parse pipeline.
   */
  private warnedUnknownTypes = new Set<string>()
  /**
   * In-flight rotation promise, set for the duration of `rotate()`.
   * Subsequent rotate() calls await the same promise instead of each
   * one independently detaching handlers from a socket that the previous
   * rotate() already replaced -- the worst case there is two parallel
   * `new WebSocket(...)` opens with the second one orphaning the first.
   * See the `rotate()` docstring.
   */
  private rotationInFlight: Promise<void> | null = null
  private connectInFlight: Promise<void> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** ID of the last user message sent -- used by callbacks to detect stale responses */
  activeParentId: string | null = null

  constructor(options: NATWebSocketClientOptions) {
    this.options = {
      reconnectAttempts: 3,
      reconnectDelay: 1000,
      ...options,
    }
  }

  /**
   * Generate a unique message ID
   */
  private generateMessageId = (): string => {
    this.messageIdCounter++
    return `msg_${Date.now()}_${this.messageIdCounter}`
  }

  /**
   * Build the WebSocket URL with collection-scoping query params.
   */
  private buildWebSocketUrl = async (): Promise<string> => {
    const baseUrl = this.options.websocketUrl || (await getWebSocketUrl())
    const params = new URLSearchParams()

    if (this.options.projectId) {
      params.set('projectId', this.options.projectId)
    }
    if (this.options.conversationId) {
      // camelCase param the Grid backend scopes the collection on.
      params.set('conversationId', this.options.conversationId)
      // snake_case duplicate that NAT's `_restore_execution_state` reads
      // verbatim (it looks up `conversation_id`) to swap a reconnected socket
      // into a still-running handler. Sending BOTH keeps the live-reattach
      // path working without depending on the backend camelCase tolerance.
      params.set('conversation_id', this.options.conversationId)
    }

    const queryString = params.toString()
    if (!queryString) {
      return baseUrl
    }

    const separator = baseUrl.includes('?') ? '&' : '?'
    return `${baseUrl}${separator}${queryString}`
  }
  connect = (): Promise<void> => {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return Promise.resolve()
    }
    // Coalesce concurrent connect()s (mirrors rotationInFlight): between the
    // readyState guard and `new WebSocket(...)` this method awaits auth
    // refresh and URL building with `this.ws` still null, so a reconnect
    // timer firing mid-rotate would otherwise open a second, orphaned socket.
    if (this.connectInFlight) {
      return this.connectInFlight
    }
    this.connectInFlight = (async () => {
      this.isIntentionallyClosed = false
      this.options.callbacks.onConnectionChange?.('connecting')

      try {
        if (this.options.onBeforeReconnect) {
          try {
            await this.options.onBeforeReconnect()
          } catch (err) {
            // Auth refresh is best-effort; the upgrade still happens with whatever
            // cookie the browser has. The backend will close the socket if it's bad.
            console.warn('[WS] onBeforeReconnect failed, proceeding with current auth', err)
          }
        }
        const wsUrl = await this.buildWebSocketUrl()
        this.ws = new WebSocket(wsUrl)
        this.setupEventHandlers()
      } catch {
        this.options.callbacks.onConnectionChange?.('error', { intentional: false })
        this.handleReconnect()
      } finally {
        this.connectInFlight = null
      }
    })()
    return this.connectInFlight
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect = (): void => {
    this.isIntentionallyClosed = true
    this.reconnectCount = 0
    this.clearReconnectTimer()

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.options.callbacks.onConnectionChange?.('disconnected', { intentional: true })
  }

  /**
   * Atomically swap the underlying WebSocket for a fresh one.
   *
   * Done as a single client-side operation (rather than `disconnect()` +
   * `connect()` interleaved from the caller) because of an `onclose` race:
   *   1. `disconnect()` sets `isIntentionallyClosed = true` and calls
   *      `ws.close()`, but the browser fires `onclose` asynchronously.
   *   2. `connect()` immediately flips `isIntentionallyClosed = false`.
   *   3. The old socket's `onclose` then arrives, sees the flag is now
   *      false, classifies the close as unintentional, and drives
   *      `onConnectionChange('disconnected' | 'error')` -- clobbering the
   *      streaming/loading UX of the freshly-opened socket and potentially
   *      scheduling a redundant reconnect via `handleReconnect()`.
   *
   * Three layers of defense:
   *   - Detach handlers from the old socket BEFORE closing it, so any
   *     late event the browser still tries to deliver hits a no-op.
   *   - Belt-and-braces: `setupEventHandlers()` also captures the source
   *     socket in each handler and early-returns unless `this.ws ===
   *     socket`, protecting against any other reordering we can't control.
   *   - Idempotency: if a rotation is already in flight (e.g. soft-timer
   *     fires while an `auth_expired` rotation is mid-handshake),
   *     subsequent callers await the same in-flight promise instead of
   *     each independently ripping handlers off whatever `this.ws`
   *     currently is. Without this, the second rotate() would detach
   *     handlers from the brand-new (still `connecting`) socket and could
   *     leave two parallel `new WebSocket(...)` opens racing for the
   *     `this.ws` slot.
   */
  rotate = (): Promise<void> => {
    if (this.rotationInFlight) {
      // Coalesce: every concurrent caller observes the same outcome.
      return this.rotationInFlight
    }
    this.rotationInFlight = (async () => {
      try {
        const oldSocket = this.ws
        if (oldSocket) {
          oldSocket.onopen = null
          oldSocket.onclose = null
          oldSocket.onerror = null
          oldSocket.onmessage = null
          try {
            oldSocket.close()
          } catch {
            // close() can throw in test or polyfill environments; the
            // rotation doesn't depend on a clean close because handlers
            // are already detached.
          }
          if (this.ws === oldSocket) this.ws = null
        }
        this.isIntentionallyClosed = false
        this.reconnectCount = 0
        this.errorBeforeClose = false
        // A pending backoff reconnect for the OLD socket must not fire during
        // (or after) the rotation — it would race this connect() for this.ws.
        this.clearReconnectTimer()
        await this.connect()
      } finally {
        this.rotationInFlight = null
      }
    })()
    return this.rotationInFlight
  }

  /**
   * Send a user chat message
   * @param content - The message text content (query)
   * @param enabledDataSources - Optional array of enabled data source IDs to include in the query
   */
  sendMessage = (content: string, enabledDataSources?: string[]): string | null => {
    // Format the text content as JSON with query and data_sources
    const textContent = JSON.stringify({
      query: content,
      data_sources: enabledDataSources ?? [],
    })

    const messageId = this.generateMessageId()
    const message: NATUserMessage = {
      type: NATMessageType.USER_MESSAGE,
      schema_type: NATSchemaType.CHAT_STREAM,
      id: messageId,
      conversation_id: this.options.conversationId,
      content: {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: textContent }],
          },
        ],
      },
      timestamp: new Date().toISOString(),
    }

    if (!this.send(message)) return null

    this.activeParentId = messageId
    return messageId
  }

  /**
   * Send a response to a human prompt (clarification, approval, etc.)
   */
  sendInteractionResponse = (promptId: string, parentId: string, responseText: string): string | null => {
    const messageId = this.generateMessageId()
    const message: NATUserInteractionResponse = {
      type: NATMessageType.USER_INTERACTION,
      id: messageId,
      parent_id: parentId,
      conversation_id: this.options.conversationId,
      content: {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: responseText }],
          },
        ],
      },
      timestamp: new Date().toISOString(),
    }

    if (!this.send(message)) return null
    return messageId
  }

  /**
   * Check if connected
   */
  isConnected = (): boolean => {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /**
   * Update conversation ID (e.g., when switching conversations)
   */
  updateConversationId = (conversationId: string): void => {
    this.options.conversationId = conversationId
  }

  /**
   * Update the project ID (e.g., once the project store resolves after the
   * socket was first created).
   *
   * The project scope is injected into the connection HANDSHAKE: `server.js`
   * reads the `projectId` query param on the WS upgrade to set the
   * `x-grid-project-context` header the backend uses to give the agent
   * project knowledge. That param is baked into the URL at connect time by
   * `buildWebSocketUrl`, so a changed project ID can only take effect on a
   * fresh socket. We rotate() -- the same atomic swap used for auth rotation
   * -- but only when the value actually changes, and only if a socket already
   * exists (otherwise the pending connect() will pick up the new value).
   *
   * This is the fix for the first-load race where the socket connected with
   * `projectId: undefined` (before the project store was populated) and then
   * never carried project context for the conversation's lifetime.
   */
  updateProjectId = (projectId: string | undefined): void => {
    const next = projectId || undefined
    if (this.options.projectId === next) return
    this.options.projectId = next
    if (this.ws) {
      void this.rotate()
    }
  }

  private setupEventHandlers = (): void => {
    // Capture the socket instance in each handler closure. If `this.ws` is
    // swapped (rotate(), reconnect, etc.), late events from the old socket
    // hit `this.ws !== socket` and are dropped before they can drive any
    // connection-state side effects on the new socket.
    const socket = this.ws
    if (!socket) return

    socket.onopen = () => {
      if (this.ws !== socket) return
      this.reconnectCount = 0
      this.errorBeforeClose = false
      this.options.callbacks.onConnectionChange?.('connected')
    }

    socket.onerror = () => {
      if (this.ws !== socket) return
      // Flag that an error preceded the close event.
      // Don't fire onConnectionChange here -- onclose always follows onerror
      // in the browser WebSocket API. This prevents double-firing.
      this.errorBeforeClose = true
    }

    socket.onclose = () => {
      if (this.ws !== socket) return
      const hadError = this.errorBeforeClose
      this.errorBeforeClose = false

      if (this.isIntentionallyClosed) {
        // Intentional close (session switch, cleanup) -- already handled by disconnect()
        return
      }

      // During active reconnection, suppress status callbacks to avoid
      // intermediate error/disconnected flickers. Only fire on:
      // - Successful reconnection (handled by onopen above)
      // - Final failure after all retries (handled by handleReconnect)
      if (this.reconnectCount > 0) {
        this.handleReconnect()
        return
      }

      // First disconnect -- notify with appropriate status
      const status: ConnectionStatus = hadError ? 'error' : 'disconnected'
      this.options.callbacks.onConnectionChange?.(status, { intentional: false })
      this.handleReconnect()
    }

    socket.onmessage = (event) => {
      if (this.ws !== socket) return
      this.handleMessage(event.data)
    }
  }

  private handleMessage = (data: string): void => {
    try {
      const parsed = JSON.parse(data)
      const validated = NATIncomingMessageSchema.safeParse(parsed)

      if (!validated.success) {
        // Tolerant fallback: an unknown or renamed frame type must not spam the
        // console on every message. Log ONCE per distinct `type` value (or once
        // for typeless/garbage payloads) and drop the frame without failing the
        // rest of the pipeline.
        const rawType =
          parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string'
            ? (parsed as { type: string }).type
            : '<no-type>'
        if (!this.warnedUnknownTypes.has(rawType)) {
          this.warnedUnknownTypes.add(rawType)
          console.warn(
            `[WS] Ignoring unrecognized NAT message type "${rawType}" (logged once)`,
            validated.error
          )
        }
        return
      }

      const message: NATIncomingMessage = validated.data

      switch (message.type) {
        case NATMessageType.SYSTEM_RESPONSE: {
          // Extract content - can be:
          // - string (direct content)
          // - SystemResponseContent with .text field
          // - GenerateResponse with .output field (shallow/meta responses)
          let content = ''
          if (typeof message.content === 'string') {
            content = message.content
          } else if ('output' in message.content && message.content.output != null) {
            // GenerateResponse format (shallow/meta responses)
            content = message.content.output
          } else if ('text' in message.content && message.content.text != null) {
            // SystemResponseContent format
            content = message.content.text
          }

          const isFinal = message.status === 'complete'
          // Bundle the transparency extras lifted onto the terminal frame. Each
          // is optional; the hook renders only those that are present.
          const transparency: ResponseTransparency = {
            routingDecision: message.routing_decision,
            routingReason: message.routing_reason,
            escalationReason: message.escalation_reason,
            answerConfidenceCappedReason: message.answer_confidence_capped_reason,
            citationsRemoved: message.citations_removed,
            jobAdmissionRejected: message.job_admission_rejected,
            retryAfterSeconds: message.retry_after_seconds,
          }
          this.options.callbacks.onResponse?.(
            content,
            message.status,
            isFinal,
            message.parent_id,
            message.cards,
            message.deep_research_job_id,
            message.answer_confidence,
            message.sources,
            transparency
          )
          break
        }

        case NATMessageType.OBSERVABILITY_TRACE: {
          // Diagnostic/tracing frame. Accepted so it no longer trips the
          // unknown-type fallback, but the frontend renders nothing from it.
          break
        }

        case NATMessageType.SYSTEM_INTERMEDIATE: {
          this.options.callbacks.onIntermediateStep?.(message.content, message.status, message.parent_id)
          break
        }

        case NATMessageType.SYSTEM_INTERACTION: {
          // Human prompt - needs user response
          this.options.callbacks.onHumanPrompt?.(message.id, message.parent_id, message.content)
          break
        }

        case NATMessageType.ERROR: {
          // Auth errors carry the specific error_code in `message`
          // (e.g. "token_expired", "token_invalid", "auth_error",
          // "auth_expired"). `auth_expired` is the per-message re-auth
          // gate -- the hook turns it into a silent reconnect + auto-resend.
          const authCodes = new Set([
            'auth_error',
            'token_expired',
            'token_invalid',
            'auth_expired',
          ])
          const errorMsg = message.content?.message
          if (errorMsg && authCodes.has(errorMsg)) {
            trackAuthEvent(errorMsg, {
              details: message.content?.details,
              source: 'websocket',
            })
          }
          this.options.callbacks.onError?.(message.content)
          break
        }
      }
    } catch {
      console.warn('Failed to parse NAT WebSocket message:', data)
    }
  }

  private send = (message: object): boolean => {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
      return true
    } else {
      console.warn('NAT WebSocket not connected, message not sent')
      return false
    }
  }

  private handleReconnect = (): void => {
    const { reconnectAttempts, reconnectDelay } = this.options

    if (this.reconnectCount >= (reconnectAttempts || 3)) {
      // All retries exhausted -- notify with final disconnected status
      this.options.callbacks.onConnectionChange?.('disconnected', { intentional: false })
      this.options.callbacks.onError?.({
        code: 'CONNECTION_FAILED',
        message: 'Unable to connect to the server. Please check your network connection.',
      })
      return
    }

    this.reconnectCount++

    this.clearReconnectTimer()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.isIntentionallyClosed) {
        this.connect()
      }
    }, reconnectDelay || 1000)
  }

  private clearReconnectTimer = (): void => {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}

/**
 * Create a new NAT WebSocket client instance
 */
export const createNATWebSocketClient = (
  options: NATWebSocketClientOptions
): NATWebSocketClient => {
  return new NATWebSocketClient(options)
}

// Re-export NAT types for convenience
export { NATMessageType, NATSchemaType, HumanPromptType }
export type { NATHumanPrompt, NATIntermediateStepContent, NATErrorContent }
export type { ResponseTransparency as NATResponseTransparency }
