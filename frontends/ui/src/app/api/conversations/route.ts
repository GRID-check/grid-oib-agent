/**
 * Conversations API — list and create conversations for the current
 * organization. Thin handlers; all logic lives in
 * `@/lib/conversations/service`.
 *
 * The list is **visibility-aware** (spec SH-4): it returns what the caller may
 * actually see, not every conversation in the organization. A new conversation is
 * created `private` and shared deliberately (spec MG-2).
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { createConversation, listConversations } from '@/lib/conversations/service'

const createConversationSchema = z.object({
  // Client-generated id; length-capped so user-controlled strings never
  // reach the database unbounded.
  id: z.string().min(1).max(128),
  title: z.string().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  subjectResourceType: z.literal('document').nullable().optional(),
  subjectResourceId: z.string().min(1).max(128).nullable().optional(),
})

const listConversationsQuerySchema = z.object({
  // Optional project scope; the service enforces project access + tenancy.
  projectId: z.string().uuid().optional(),
})

export const GET = apiRoute(
  async ({ session, request }) =>
    listConversations(session, parseQuery(request, listConversationsQuerySchema)),
  {
    authz: {
      enforcedBy: 'listConversations (requireProjectAccess project:view + resource access)',
    },
  }
)

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, createConversationSchema)
    return createConversation(session, input)
  },
  { status: 201, authz: { enforcedBy: 'createConversation (requireProjectAccess project:view)' } }
)
