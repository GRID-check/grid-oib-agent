/**
 * Conversations service — business logic for the conversations domain.
 *
 * Owns authorization: org tenancy is enforced through org-scoped repository
 * queries, and linking a conversation to a project requires project access
 * (`requireProjectAccess`). Route handlers stay thin: they validate input
 * shape and delegate here. Failures are signalled with typed errors from
 * `@/lib/api/errors` — cross-org lookups surface as `NotFoundError` so
 * responses never confirm the existence of other tenants' conversations.
 */

import 'server-only'
import { requireProjectAccess } from '@/lib/authz/projects'
import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Conversation, Message } from '@/lib/db/schema'
import {
  deleteConversationInOrg,
  findConversationInOrg,
  insertConversation,
  insertMessages,
  listConversationsInOrg,
  listMessagesForConversation,
  updateConversationTitleInOrg,
} from './repository'

export interface CreateConversationInput {
  id: string
  title?: string | null
  projectId?: string | null
}

export interface CreateMessageInput {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  messageType?: string
  metadata?: Record<string, unknown>
  createdAt?: string
}

export interface ListConversationsFilter {
  /** Scope the list to one project's conversations (plus legacy unscoped rows). */
  projectId?: string
}

/**
 * List conversations for the caller's organization.
 *
 * With `filter.projectId` the caller must be able to see that project
 * (same guard as `createConversation` — otherwise any org member could
 * probe/list conversations of arbitrary project ids). The result is then
 * scoped to that project, deliberately fail-open for legacy rows without a
 * `projectId` (see `listConversationsInOrg`) so users never lose sight of
 * conversations created before project stamping.
 */
export async function listConversations(
  session: AuthorizedSession,
  filter: ListConversationsFilter = {},
): Promise<Conversation[]> {
  if (filter.projectId) {
    await requireProjectAccess(session, filter.projectId, 'project:view')
  }
  return listConversationsInOrg(session.organizationId, { projectId: filter.projectId })
}

export async function getConversation(session: AuthorizedSession, conversationId: string): Promise<Conversation> {
  const conversation = await findConversationInOrg(conversationId, session.organizationId)
  if (!conversation) throw new NotFoundError()
  return conversation
}

/**
 * Create a conversation. When the caller links it to a project, they must be
 * able to see that project — otherwise any org member could attach
 * conversations to (and probe the existence of) arbitrary project ids.
 */
export async function createConversation(
  session: AuthorizedSession,
  input: CreateConversationInput,
): Promise<Conversation> {
  if (input.projectId) {
    await requireProjectAccess(session, input.projectId, 'project:view')
  }

  const inserted = await insertConversation({
    id: input.id,
    organizationId: session.organizationId,
    createdBy: session.userId,
    title: input.title ?? null,
    projectId: input.projectId ?? null,
  })
  if (inserted) return inserted

  // Id conflict: either a concurrent create from this org (idempotent
  // success) or an id owned by another tenant (opaque 404, same as reads).
  const existing = await findConversationInOrg(input.id, session.organizationId)
  if (!existing) throw new NotFoundError()
  return existing
}

export async function updateConversationTitle(
  session: AuthorizedSession,
  conversationId: string,
  title: string,
): Promise<Conversation> {
  const conversation = await updateConversationTitleInOrg(conversationId, session.organizationId, title)
  if (!conversation) throw new NotFoundError()
  return conversation
}

/** Delete a conversation. Idempotent: deleting a missing id is a no-op. */
export async function deleteConversation(session: AuthorizedSession, conversationId: string): Promise<void> {
  await deleteConversationInOrg(conversationId, session.organizationId)
}

/** List a conversation's messages, oldest first (404 for cross-org/missing). */
export async function listConversationMessages(
  session: AuthorizedSession,
  conversationId: string,
): Promise<Message[]> {
  const conversation = await findConversationInOrg(conversationId, session.organizationId)
  if (!conversation) throw new NotFoundError()
  return listMessagesForConversation(conversationId)
}

/** Append one or more messages to a conversation (404 for cross-org/missing). */
export async function createConversationMessages(
  session: AuthorizedSession,
  conversationId: string,
  inputs: CreateMessageInput[],
): Promise<Message[]> {
  const conversation = await findConversationInOrg(conversationId, session.organizationId)
  if (!conversation) throw new NotFoundError()

  return insertMessages(
    inputs.map((input) => ({
      id: input.id,
      conversationId,
      role: input.role,
      content: input.content,
      // messageType lives in metadata (no dedicated column) so the client
      // can route rehydrated history to the right renderer.
      metadata: {
        ...(input.metadata ?? {}),
        ...(input.messageType ? { messageType: input.messageType } : {}),
      },
      createdAt: input.createdAt ? new Date(input.createdAt) : new Date(),
    })),
  )
}
