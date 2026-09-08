/**
 * Conversations API — list and create conversations for the current
 * organization. Thin handlers; all logic lives in
 * `@/lib/conversations/service`.
 *
 * The list is **visibility-aware** (spec SH-4): it returns what the caller may
 * actually see, not every conversation in the organization. A new conversation is
 * created `private` and shared deliberately (spec MG-2).
 *
 * Since ADR-0054 a conversation also declares its LEVEL: `project` (inside one
 * project) or `workspace` (the Büro, which belongs to the organization and has
 * no project). The two are tied together by a CHECK in migration 0081, and the
 * `superRefine` below is that CHECK's twin at the edge — so a request that
 * contradicts itself is a 400 the client can read rather than a 500 from
 * Postgres.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { createConversation, listConversations } from '@/lib/conversations/service'
import { CONVERSATION_SCOPES } from '@/lib/conversations/scopes'

const createConversationSchema = z
  .object({
    // Client-generated id; length-capped so user-controlled strings never
    // reach the database unbounded.
    id: z.string().min(1).max(128),
    title: z.string().nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    /**
     * Omitted means "derive it from `projectId`", which is what every client
     * that predates the Büro sends and what the service does with it. Stating
     * it is how the Büro says it means the office rather than a project chat
     * whose project got lost.
     */
    scope: z.enum(CONVERSATION_SCOPES).optional(),
    subjectResourceType: z.literal('document').nullable().optional(),
    subjectResourceId: z.string().min(1).max(128).nullable().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.scope === 'workspace' && input.projectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['projectId'],
        message:
          'A workspace conversation belongs to the organization and cannot name a project ' +
          '(ADR-0054). Mount the project into it instead.',
      })
    }
  })

const listConversationsQuerySchema = z.object({
  // Optional project scope; the service enforces project access + tenancy.
  projectId: z.string().uuid().optional(),
  // Optional level filter; `workspace` is what the Büro sessions panel asks
  // for, and the service enforces `org:chat` before the repository sees it.
  scope: z.enum(CONVERSATION_SCOPES).optional(),
})

export const GET = apiRoute(
  async ({ session, request }) =>
    listConversations(session, parseQuery(request, listConversationsQuerySchema)),
  {
    authz: {
      enforcedBy:
        'listConversations (requireProjectAccess project:view + resource access; ' +
        'hasPermission org:chat for scope=workspace)',
    },
  }
)

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, createConversationSchema)
    return createConversation(session, input)
  },
  {
    status: 201,
    authz: {
      enforcedBy:
        'createConversation (requireProjectAccess project:view; ' +
        'hasPermission org:chat for a workspace conversation)',
    },
  }
)
