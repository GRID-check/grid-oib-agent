/**
 * The ONE route a machine may delegate work through (ADR-0051, ADR-0055).
 *
 * ## What it is for
 *
 * ADR-0051 named three triggers that create a task and built one: a job on its
 * timer. This is the second — "a chat handoff (@Piloti prüf das bis Freitag)
 * becomes another" — and it exists as an HTTP route with a typed client rather
 * than as a service call the Python tier makes, because ADR-0055 says a
 * primitive has one surface and every consumer is a client of it. The `tasks`
 * table already had a session-facing surface for reading and reviewing; this is
 * the writing end of it.
 *
 * ## Identity: the same two checks as the document route, and the same reason
 *
 * The internal token authenticates the SERVICE, and the agent's principal is
 * wider than any human's, so the acting identity comes from the signed
 * request-context envelope and from `resolvePinnedRequesterSession` — see
 * `lib/api/internal-envelope.ts` for the threat model and
 * `docs/adr/0054-document-versions-and-the-publish-door.md` §4 for the record.
 * The task's `requester_user_id` is that person, which is the whole point: an
 * unattended run files as somebody, and the somebody is whoever asked.
 *
 * ## The op set is `create`, and there is no second verb
 *
 * A machine may ASK for work. It may not judge it: `reviewTask` is a session
 * route because a review is a person's statement about the project's own record,
 * and a machine that could accept its own output would close the loop ADR-0051
 * exists to open. The union in `lib/tasks/wire.ts` is what says so, and the
 * route's spec asserts it has exactly one member.
 */

import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { requirePinnedSession, requireVerifiedContext } from '@/lib/api/internal-envelope'
import { withTenant } from '@/lib/db/tenant-context'
import { delegateTask } from '@/lib/tasks/delegation'
import { internalTaskRequestSchema, parseTaskDue } from '@/lib/tasks/wire'

export const POST = internalApiRoute(
  'tasks',
  async ({ request }) => {
    const context = requireVerifiedContext(request)
    const body = await parseJsonBody(request, internalTaskRequestSchema)
    const session = await requirePinnedSession(context)
    const dueAt = parseTaskDue(body.due)

    // The tenant slot comes from the VERIFIED envelope and never from the body,
    // exactly as the document-versions route does it: `fromPayload` below names
    // where the claim comes from, and the claim is a signed one.
    return withTenant({ organizationId: context.organizationId }, async () => {
      const task = await delegateTask(session, {
        projectId: body.projectId,
        kind: body.kind,
        goal: body.goal,
        dueAt,
      })
      return {
        taskId: task.id,
        kind: body.kind,
        title: task.title,
        status: task.status,
        conversationId: task.conversationId,
        dueAt: task.deadlineAt ? task.deadlineAt.toISOString() : null,
      }
    })
  },
  {
    tenancy: {
      fromPayload:
        'the verified X-Grid-Request-Context envelope (organizationId), never the request body',
    },
    status: 201,
  },
)
