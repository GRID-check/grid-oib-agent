import type { Conversation, Message } from '@/lib/db/schema'

export interface ConversationSummary {
  id: string
  title: string | null
  createdAt: string
  updatedAt: string
}

export const conversationsClient = {
  /**
   * List conversations, optionally scoped to a project. The BFF applies a
   * fail-open rule for legacy rows without a projectId (they are included in
   * every project scope) so users never lose sight of their history.
   */
  async list(projectId?: string): Promise<Conversation[]> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
    const res = await fetch(`/api/conversations${query}`)
    if (!res.ok) throw new Error('Failed to fetch conversations')
    return res.json()
  },

  async get(id: string): Promise<Conversation> {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`)
    if (!res.ok) throw new Error('Conversation not found')
    return res.json()
  },

  async create(id: string, title?: string | null, projectId?: string | null): Promise<Conversation> {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title: title ?? null, projectId: projectId ?? null }),
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
    if (!res.ok) throw new Error('Failed to create messages')
    return res.json()
  },
}

export type ConversationsClient = typeof conversationsClient
