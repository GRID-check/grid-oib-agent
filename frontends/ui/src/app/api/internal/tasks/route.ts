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
 * ## Two verbs, both of them asking
 *
 * `create` states a standing intent („@Piloti prüf das bis Freitag"), and
 * `research` commissions one run for a question asked in the thread — the
 * escalation, which used to be a job the product had no row for (ADR-0062).
 * Both are a machine ASKING for work. Neither judges it: `reviewTask` is a
 * session route because a review is a person's statement about the project's
 * own record, and a machine that could accept its own output would close the
 * loop ADR-0051 exists to open.
 */

import { ConflictError, ForbiddenError } from '@/lib/api/errors'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import {
  isDeepResearchEnabledForOrg,
  isTaskAutomationEnabledForOrg,
} from '@/lib/workos/feature-flags'
import {
  requireEnvelopeProject,
  requirePinnedSession,
  requireVerifiedContext,
} from '@/lib/api/internal-envelope'
import { withTenant } from '@/lib/db/tenant-context'
import { proposePlannedRun } from '@/lib/plans/service'
import { commissionResearchRun, delegateTask } from '@/lib/tasks/delegation'
import { internalTaskRequestSchema, parseTaskDue } from '@/lib/tasks/wire'

export const POST = internalApiRoute(
  'tasks',
  async ({ request }) => {
    const context = requireVerifiedContext(request)
    const body = await parseJsonBody(request, internalTaskRequestSchema)
    const session = await requirePinnedSession(context)
    // Same rule as the document route: a body may not name a project the signed
    // envelope contradicts. A task queues a run that files as this person, so a
    // replayed envelope pointed at a second project would be work nobody asked
    // for, attributed to somebody who did not ask for it.
    requireEnvelopeProject(context, body.projectId)

    // The capability gate, and the reason it is HERE rather than only on the
    // session route: this is the door the AGENT comes through. It arrives with a
    // signed envelope and no session, so `requireFeature` cannot see it — which
    // is how a tenant could have the Automation section hidden and still get
    // work queued by asking for it in chat.
    //
    // Both ops, because they withdraw different things. `research` is the same
    // capability `POST /api/jobs/async/submit` gates, reached by another path; a
    // delegated task is `task-automation`. The message is German and a full
    // sentence on purpose: `create_task` relays the envelope's `error` verbatim
    // to the model, which relays it to the reader.
    const allowed =
      body.op === 'research' || body.op === 'plan'
        ? await isDeepResearchEnabledForOrg(context.organizationId)
        : await isTaskAutomationEnabledForOrg(context.organizationId)
    if (!allowed) {
      throw new ForbiddenError(
        body.op === 'research' || body.op === 'plan'
          ? 'Eine Tiefenrecherche steht in diesem Arbeitsbereich nicht zur Verfügung.'
          : 'Aufträge und Zeitpläne stehen in diesem Arbeitsbereich nicht zur Verfügung. ' +
            'Die Frage lässt sich nur direkt im Chat beantworten.',
      )
    }

    if (body.op === 'plan') {
      // The plan and its run, in one step (ADR-0065). The thread comes from
      // the signed envelope for the same reason it does for `research`.
      if (!context.conversationId) {
        throw new ConflictError('A planned run needs the thread it was asked in')
      }
      const conversationId = context.conversationId
      return withTenant({ organizationId: context.organizationId }, async () => {
        const { plan, run } = await proposePlannedRun(session, {
          projectId: body.projectId,
          conversationId,
          draft: body.plan,
          author: 'agent',
          start: body.start,
          context: body.context ?? null,
        })
        return {
          runId: run.runId,
          runMessageId: run.runMessageId,
          conversationId: run.conversationId,
          status: run.status,
          planId: plan.id,
          planStatus: plan.status,
          startsAt: plan.startsAt,
        }
      })
    }

    if (body.op === 'research') {
      // A run is one message in the THREAD that commissioned it. An escalation
      // without a conversation is a run with nowhere to narrate itself, and the
      // caller is the one holding the envelope that should have carried one.
      if (!context.conversationId) {
        throw new ConflictError('A research run needs the thread it was asked in')
      }
      const conversationId = context.conversationId
      return withTenant({ organizationId: context.organizationId }, () =>
        commissionResearchRun(session, {
          projectId: body.projectId,
          conversationId,
          question: body.question,
          context: body.context ?? null,
          dataSources: body.dataSources ?? null,
          documents: body.documents ?? null,
        }),
      )
    }

    const dueAt = parseTaskDue(body.due)

    // The tenant slot comes from the VERIFIED envelope and never from the body,
    // exactly as the document-versions route does it: `fromPayload` below names
    // where the claim comes from, and the claim is a signed one.
    return withTenant({ organizationId: context.organizationId }, async () => {
      const result = await delegateTask(session, {
        projectId: body.projectId,
        kind: body.kind,
        goal: body.goal,
        dueAt,
        cadence: body.cadence
          ? { cron: body.cadence, timezone: body.cadenceTimezone }
          : null,
        // The thread the person was typing in when they asked, from the SIGNED
        // envelope and never from the body. A run is one message in the thread
        // that commissioned it (ADR-0062), and a conversation id a caller could
        // name would be a message written into a thread nobody asked about.
        conversationId: context.conversationId,
      })
      const { definition, run } = result
      return {
        // The definition id: for a one-off it is also the run's parent, for a
        // cadence it is the standing row the reader's list shows.
        taskId: definition.id,
        kind: body.kind,
        title: definition.title,
        status: run ? run.status : 'scheduled',
        conversationId: run?.conversationId ?? null,
        dueAt: definition.dueAt ? definition.dueAt.toISOString() : null,
        scheduled: run === null,
        nextRunAt: definition.nextRunAt ? definition.nextRunAt.toISOString() : null,
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
