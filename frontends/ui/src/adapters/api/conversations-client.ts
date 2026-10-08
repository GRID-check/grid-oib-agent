import type { Conversation, Message } from '@/lib/db/schema'

export interface ConversationSummary {
  id: string
  title: string | null
  tags: string[]
  createdAt: string
  updatedAt: string
}

/** One turn of the opening exchange sent to the naming endpoint. */
export interface ConversationTitleMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Naming result: a concise title plus 0–3 OIB topic tag keys. */
export interface ConversationTitleResult {
  title: string
  tags: string[]
  error?: string
}

/** A conversation as the list sends it: the row, and whether its content is withheld from this reader (ADR-0088). */
export type ListedConversation = Conversation & { contentLocked?: boolean }

/**
 * An other project that restricts a conversation now (ADR-0093), as the server
 * judges it; `name` is null for a project that is deleted or gone.
 */
export interface RestrictingOtherProject {
  id: string
  name: string | null
}

/**
 * The server refused a read or write because the reader may no longer read what
 * the conversation drew on (403 `RESOURCE_RIGHTS_LOST`). Not "not found" and
 * not "forbidden": the chat is theirs and stays in their list, without content.
 */
export class ConversationRightsLostError extends Error {
  constructor() {
    super('You no longer have the rights to view this conversation.')
    this.name = 'ConversationRightsLostError'
  }
}

/** Throw {@link ConversationRightsLostError} when `res` is that refusal; otherwise do nothing. */
async function throwIfRightsLost(res: Response): Promise<void> {
  if (res.status !== 403) return
  const body = (await res.clone().json().catch(() => null)) as { code?: unknown } | null
  if (body?.code === 'RESOURCE_RIGHTS_LOST') throw new ConversationRightsLostError()
}

export const conversationsClient = {
  /**
   * List conversations, optionally scoped to a project. The BFF applies a
   * fail-open rule for legacy rows without a projectId (they are included in
   * every project scope) so users never lose sight of their history.
   */
  async list(projectId?: string): Promise<ListedConversation[]> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
    const res = await fetch(`/api/conversations${query}`)
    if (!res.ok) throw new Error('Failed to fetch conversations')
    return res.json()
  },

  async get(id: string): Promise<Conversation> {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`)
    await throwIfRightsLost(res)
    if (!res.ok) throw new Error('Conversation not found')
    return res.json()
  },

  /**
   * The other projects that restrict this conversation NOW (ADR-0093): the
   * server's current record, judged at read time, never what an answer's
   * citations said when it was written. `null` when it cannot be read (no
   * access, a failed request), so a caller keeps what it showed. Never throws.
   */
  async restrictingOtherProjects(id: string): Promise<RestrictingOtherProject[] | null> {
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { cache: 'no-store' })
      if (!res.ok) return null
      const body = (await res.json()) as { restrictingOtherProjects?: unknown }
      if (!Array.isArray(body.restrictingOtherProjects)) return []
      return body.restrictingOtherProjects.flatMap((entry: unknown) => {
        const project = entry as { id?: unknown; name?: unknown } | null
        if (typeof project?.id !== 'string') return []
        return [{ id: project.id, name: typeof project.name === 'string' ? project.name : null }]
      })
    } catch {
      return null
    }
  },

  /**
   * Is a turn in this conversation still producing frames? The age of the
   * newest frame in its replay stream by the server's clock, in ms; `null`
   * when the stream holds none, `undefined` when there is nothing to ask (no
   * shared cache, a failed read). Never throws.
   */
  async newestFrameAge(id: string): Promise<number | null | undefined> {
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/frames?peek=1`, {
        cache: 'no-store',
      })
      if (!res.ok) return undefined
      const body = (await res.json()) as { available?: unknown; newest?: unknown; now?: unknown }
      if (body.available !== true || typeof body.now !== 'number') return undefined
      if (typeof body.newest !== 'string') return null
      const ms = Number(body.newest.split('-')[0])
      return Number.isFinite(ms) ? Math.max(0, body.now - ms) : undefined
    } catch {
      return undefined
    }
  },

  async create(
    id: string,
    title?: string | null,
    projectId?: string | null,
    subject?: { resourceType: 'document'; resourceId: string } | null,
  ): Promise<Conversation> {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        title: title ?? null,
        projectId: projectId ?? null,
        subjectResourceType: subject?.resourceType ?? null,
        subjectResourceId: subject?.resourceId ?? null,
      }),
    })
    if (!res.ok) throw new Error('Failed to create conversation')
    return res.json()
  },

  async updateTitle(id: string, title: string): Promise<Conversation> {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    if (!res.ok) throw new Error('Failed to update conversation')
    return res.json()
  },

  /**
   * Ask the backend to name a conversation (ChatGPT-style) and assign OIB topic
   * tags from its opening exchange; the server persists both on the row. Returns
   * an empty title/tags on any generation failure (the endpoint fails open).
   */
  async generateTitle(
    id: string,
    messages: ConversationTitleMessage[],
    locale?: string,
  ): Promise<ConversationTitleResult> {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/generate-title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, locale }),
    })
    if (!res.ok) throw new Error('Failed to generate conversation title')
    return res.json()
  },

  async delete(id: string): Promise<void> {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error('Failed to delete conversation')
  },

  async listMessages(conversationId: string): Promise<Message[]> {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    )
    await throwIfRightsLost(res)
    if (!res.ok) throw new Error('Failed to fetch messages')
    return res.json()
  },

  async createMessage(
    conversationId: string,
    message: { id: string; role: string; content: string; messageType?: string; metadata?: unknown; createdAt?: string },
  ): Promise<Message> {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      },
    )
    await throwIfRightsLost(res)
    if (!res.ok) throw new Error('Failed to create message')
    return res.json()
  },

  async createMessages(
    conversationId: string,
    messages: Array<{ id: string; role: string; content: string; messageType?: string; metadata?: unknown; createdAt?: string }>,
  ): Promise<Message[]> {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      },
    )
    await throwIfRightsLost(res)
    if (!res.ok) throw new Error('Failed to create messages')
    return res.json()
  },

  /**
   * Record the user's answers to an answer's interactive cards on the stored
   * message row (merged into `metadata.cardInteractions`), so an applied
   * profile patch or a saved memory stays settled when the history is
   * rehydrated from the server instead of localStorage.
   */
  async updateMessageCardInteractions(
    conversationId: string,
    messageId: string,
    cardInteractions: Record<string, { decision: string; decidedAt: string }>,
  ): Promise<Message> {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardInteractions }),
      },
    )
    if (!res.ok) throw new Error('Failed to update message card interactions')
    return res.json()
  },

  /**
   * Record what an answer rested on — the Herleitung, the confidence
   * self-assessment, the routing transparency (ADR-0037).
   *
   * Sent once a turn has settled rather than with the message, because none of it
   * exists yet when the message is posted: it accumulates from the intermediate
   * frames while the answer streams. The server whitelists and bounds the payload
   * (`sanitizeProvenance`), so what is sent here is the client's compact display
   * form and not the raw stream.
   */
  async updateMessageProvenance(
    conversationId: string,
    messageId: string,
    provenance: Record<string, unknown>,
  ): Promise<Message> {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provenance }),
      },
    )
    if (!res.ok) throw new Error('Failed to update message provenance')
    return res.json()
  },

  /**
   * Record what a POST-ANSWER STAGE computed for this turn
   * (`docs/architecture/post-answer-stages.md` §4.3).
   *
   * The browser is what persists it, and that is not an implementation detail:
   * the agent tier holds the WS turn id and the browser holds the message row
   * id, and there is no id that is both (§1.6). The half that owns the row does
   * the writing.
   *
   * Best-effort, like every other mirror on this route — the chips are already
   * rendered from the store, so losing this costs a colleague's view and the
   * cross-device replay, not the turn. The server whitelists and bounds the
   * payload (`sanitizeStages`).
   */
  async updateMessageStages(
    conversationId: string,
    messageId: string,
    stages: Record<string, unknown>,
  ): Promise<Message> {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stages }),
      },
    )
    if (!res.ok) throw new Error('Failed to update message stages')
    return res.json()
  },

  /**
   * Record the answer to a human-in-the-loop prompt on its message row, so the
   * transcript says what was DECIDED rather than only that something was asked.
   *
   * Only the answer travels: the instant is stamped at the server persistence
   * boundary so a participant cannot backdate a decision.
   */
  async updateMessagePromptState(
    conversationId: string,
    messageId: string,
    promptState: { response: string },
  ): Promise<Message> {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptState }),
      },
    )
    if (!res.ok) throw new Error('Failed to update message prompt state')
    return res.json()
  },
}

export type ConversationsClient = typeof conversationsClient
