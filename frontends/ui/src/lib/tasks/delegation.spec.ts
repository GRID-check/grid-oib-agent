/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({
  insertDefinition: vi.fn(),
  insertDefinitionWithRun: vi.fn(),
  insertRun: vi.fn(),
  updateRun: vi.fn(),
}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/jobs/service', () => ({
  submitAgentRun: vi.fn(),
  createTaskThread: vi.fn(async () => 's_definition_thread'),
}))
vi.mock('@/lib/skills/service', () => ({ resolveSkillSnapshot: vi.fn() }))

import { NotFoundError, UnprocessableError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { TaskDefinition, TaskRun } from '@/lib/db/schema'
import { JobSubmitError } from '@/lib/jobs/backend-client'
import { createTaskThread, submitAgentRun } from '@/lib/jobs/service'
import { resolveSkillSnapshot } from '@/lib/skills/service'
import * as repository from './repository'
import {
  commissionResearchRun,
  delegateTask,
  isDelegatableTaskKind,
  TASK_GOAL_MAX_CHARS,
} from './delegation'

const session = {
  userId: 'user_asker',
  email: 'asker@grid.test',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
  accessToken: '',
  name: null,
} as AuthorizedSession

const PROJECT = '3f8b0d2e-0000-4000-8000-000000000001'

/** The inserted definition, as the database would hand it back. */
let insertedDefinition: TaskDefinition
/** The inserted run, as the database would hand it back. */
let insertedRun: TaskRun

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(repository.insertDefinition).mockImplementation(async (values) => {
    insertedDefinition = { ...values, id: 'definition-1', dueAt: values.dueAt ?? null } as TaskDefinition
    return insertedDefinition
  })
  vi.mocked(repository.insertDefinitionWithRun).mockImplementation(async (values, runValues) => {
    insertedDefinition = { ...values, id: 'definition-1', dueAt: values.dueAt ?? null } as TaskDefinition
    insertedRun = {
      ...runValues,
      definitionId: insertedDefinition.id,
      id: 'run-1',
      status: 'queued',
      conversationId: null,
    } as TaskRun
    return { definition: insertedDefinition, run: insertedRun }
  })
  vi.mocked(repository.insertRun).mockImplementation(async (values) => {
    insertedRun = { ...values, id: 'run-1', conversationId: null } as TaskRun
    return insertedRun
  })
  vi.mocked(repository.updateRun).mockImplementation(async (_id, _org, patch) => ({ ...insertedRun, ...patch }) as TaskRun)
  vi.mocked(createTaskThread).mockResolvedValue('s_definition_thread')
  vi.mocked(submitAgentRun).mockImplementation(async (spec) => ({
    backendJobId: 'backend-1',
    conversationId: spec.conversationId,
    runMessageId: spec.conversationId ? `msg-${spec.runId}` : null,
  }))
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('delegateTask', () => {
  it('pins the caller as the requester and freezes the goal on the plan', async () => {
    const { run } = await delegateTask(session, { projectId: PROJECT, kind: 'compliance_check', goal: 'Prüf das Haus A' })

    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT, [
      'project:edit',
      'project:documents:write',
    ])
    expect(insertedDefinition.requesterUserId).toBe('user_asker')
    expect(insertedDefinition.requesterEmail).toBe('asker@grid.test')
    expect(insertedDefinition.trigger).toBe('once')
    expect(insertedDefinition.plan.goal).toBe('Prüf das Haus A')
    // Verbatim inside the prompt: the engine's instruction is meta, the goal is
    // the person's own sentence.
    expect(insertedDefinition.plan.prompt).toContain('Prüf das Haus A')
    // The attempt is a `delegated` run beside the definition it belongs to.
    expect(insertedRun).toMatchObject({
      definitionId: 'definition-1',
      trigger: 'delegated',
      triggeredBy: 'user_asker',
      kind: 'compliance_check',
    })
    expect(run?.status).toBe('running')
  })

  it('runs every kind as a chat output, so the work lands in a real thread', async () => {
    await delegateTask(session, { projectId: PROJECT, kind: 'document', goal: 'Schreib den Aktenvermerk' })

    expect(vi.mocked(submitAgentRun).mock.calls[0][0]).toMatchObject({
      organizationId: 'org_1',
      projectId: PROJECT,
      userId: 'user_asker',
      output: 'chat',
      // The run's title heads its block in the thread — the same string the
      // Aufträge card shows, so both surfaces name one run the same way.
      title: 'Dokument: Schreib den Aktenvermerk',
    })
    expect(insertedRun.conversationId).toBeNull()
    // The conversation id comes back from the submission and is recorded, so
    // the card can link a reader to the work rather than only announce it.
    const updated = vi.mocked(repository.updateRun).mock.calls[0][2]
    expect(updated).toMatchObject({
      status: 'running',
      backendJobId: 'backend-1',
      conversationId: 's_definition_thread',
    })
  })

  /**
   * A run is one message in the thread that commissioned it (ADR-0062), so
   * „@Piloti prüf das" answers where it was asked. The old shape minted a
   * conversation per delegation, which put the answer somewhere the person who
   * asked had no reason to look.
   */
  it('lands the run in the thread the person was typing in, and records its message', async () => {
    await delegateTask(session, {
      projectId: PROJECT,
      kind: 'document',
      goal: 'Schreib den Aktenvermerk',
      conversationId: 's_live_chat',
    })

    // No thread of its own: the person already has one open.
    expect(createTaskThread).not.toHaveBeenCalled()
    expect(vi.mocked(submitAgentRun).mock.calls[0][0]).toMatchObject({
      conversationId: 's_live_chat',
      runId: 'run-1',
    })
    expect(vi.mocked(repository.updateRun).mock.calls[0][2]).toMatchObject({
      conversationId: 's_live_chat',
      runMessageId: 'msg-run-1',
    })
  })

  /**
   * A reviewer's send-back on a version nobody filed from a chat has no thread
   * to answer in, and the definition's own thread is the place for it — never
   * nowhere, which would leave the revision with no account of itself at all.
   */
  it('gives a delegation nobody typed the definition’s own thread', async () => {
    await delegateTask(session, { projectId: PROJECT, kind: 'document', goal: 'Schreib das' })

    expect(createTaskThread).toHaveBeenCalledWith(insertedDefinition)
    expect(vi.mocked(submitAgentRun).mock.calls[0][0]).toMatchObject({
      conversationId: 's_definition_thread',
    })
  })

  // A kind that wants a playbook NAMES it, the way a person names one in the
  // composer. It used to resolve the skill, freeze its body and paste it in
  // under „Verwende dabei den folgenden Skill verbindlich und vollständig" —
  // forcing, spelled out in German, reached through a code table instead of a
  // picker. ADR-0060 says nothing may impose a skill on a turn, and a table in
  // our own source is no more allowed to than a job or a request is.
  it('names the einreichcheck skill in the prompt and pastes no body', async () => {
    await delegateTask(session, { projectId: PROJECT, kind: 'einreichcheck', goal: 'Prüf die Einreichung' })

    expect(insertedDefinition.plan.prompt).toContain('/einreichcheck')
    expect(insertedDefinition.plan.prompt).not.toContain('verbindlich')
    expect(resolveSkillSnapshot).not.toHaveBeenCalled()
  })

  it('freezes no snapshot, so nothing can be delivered without the model asking', async () => {
    await delegateTask(session, { projectId: PROJECT, kind: 'einreichcheck', goal: 'Prüf die Einreichung' })

    // `emptySkillSnapshot()` is literally `{}` — the honest expression of "this
    // row was configured with no skill", and what the pair CHECK expects
    // beside a null `skill_name`.
    expect(insertedDefinition.plan.skill).toEqual({})
    expect(insertedRun.skillSnapshot).toEqual({})
  })

  it('quotes the version being revised into the prompt, fenced and bounded', async () => {
    await delegateTask(session, {
      projectId: PROJECT,
      kind: 'revision',
      goal: 'Die Fluchtweglänge stimmt nicht',
      subject: { documentId: 'doc-3', versionId: 'ver-1', comment: 'Die Fluchtweglänge stimmt nicht' },
      sourceText: '# Befund\n\nDie Länge beträgt 42 m.',
      requester: { userId: 'user_author', email: null },
    })

    expect(insertedDefinition.plan.prompt).toContain('```markdown')
    expect(insertedDefinition.plan.prompt).toContain('Die Länge beträgt 42 m.')
    expect(insertedDefinition.plan.subject).toEqual({
      documentId: 'doc-3',
      versionId: 'ver-1',
      comment: 'Die Fluchtweglänge stimmt nicht',
    })
    // The RE-FILING carries the permissions the original filing carried: the
    // reviewer authorizes the delegation and does not lend their own.
    expect(insertedDefinition.requesterUserId).toBe('user_author')
  })

  it('says so when the quoted version is cut rather than ending it mid-paragraph', async () => {
    await delegateTask(session, {
      projectId: PROJECT,
      kind: 'revision',
      goal: 'Kürzen',
      subject: { documentId: 'doc-3', versionId: 'ver-1', comment: 'Kürzen' },
      sourceText: 'x'.repeat(70_000),
    })
    expect(insertedDefinition.plan.prompt).toContain('hier gekürzt')
  })

  it('refuses a revision with no version to revise', async () => {
    await expect(
      delegateTask(session, { projectId: PROJECT, kind: 'revision', goal: 'Überarbeite' }),
    ).rejects.toBeInstanceOf(UnprocessableError)
  })

  it('refuses an empty or over-long goal before anything is written', async () => {
    await expect(
      delegateTask(session, { projectId: PROJECT, kind: 'document', goal: '   ' }),
    ).rejects.toBeInstanceOf(UnprocessableError)
    await expect(
      delegateTask(session, { projectId: PROJECT, kind: 'document', goal: 'x'.repeat(TASK_GOAL_MAX_CHARS + 1) }),
    ).rejects.toBeInstanceOf(UnprocessableError)
    expect(repository.insertDefinition).not.toHaveBeenCalled()
  })

  it('records a submission failure ON the run rather than throwing it at the caller', async () => {
    // The alternative loses the one case a person most wants explained: the
    // chat tool and the lifecycle effect would each have to invent their own
    // way of saying the queue would not take it.
    vi.mocked(submitAgentRun).mockRejectedValue(new JobSubmitError('backend unreachable', 502))

    const { run } = await delegateTask(session, { projectId: PROJECT, kind: 'document', goal: 'Schreib das' })

    expect(run?.status).toBe('failed')
    expect(run?.error).toContain('backend unreachable')
  })

  it('audits the creation as `task.created`, with the trigger named', async () => {
    await delegateTask(session, { projectId: PROJECT, kind: 'compliance_check', goal: 'Prüf das' })
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'task.created',
        targetType: 'task',
        targetId: 'run-1',
        metadata: expect.objectContaining({ kind: 'compliance_check', trigger: 'delegated' }),
      }),
    )
  })
})

describe('isDelegatableTaskKind', () => {
  it('accepts the four engines and refuses the two job outputs', () => {
    for (const kind of ['compliance_check', 'einreichcheck', 'document', 'revision']) {
      expect(isDelegatableTaskKind(kind)).toBe(true)
    }
    // `chat` and `deep-research` describe how a definition delivers a result;
    // asking for one would be naming a delivery channel where work belongs.
    expect(isDelegatableTaskKind('chat')).toBe(false)
    expect(isDelegatableTaskKind('deep-research')).toBe(false)
  })
})

describe('a cadence turns the delegation into a schedule', () => {
  it('creates a recurring definition and dispatches nothing', async () => {
    const result = await delegateTask(session, {
      projectId: PROJECT,
      kind: 'document',
      goal: 'Prüf das jeden Montag',
      cadence: { cron: '0 8 * * 1' },
    })

    expect(insertedDefinition).toMatchObject({
      trigger: 'schedule',
      scheduleCron: '0 8 * * 1',
      scheduleTimezone: 'UTC',
      dueAt: null,
    })
    expect(insertedDefinition.nextRunAt).toBeInstanceOf(Date)
    // No run now: the scheduler owns every fire of a schedule.
    expect(result.run).toBeNull()
    expect(repository.insertDefinitionWithRun).not.toHaveBeenCalled()
    expect(submitAgentRun).not.toHaveBeenCalled()
  })

  it('refuses a cadence from a requester without project:skills:manage, creating nothing', async () => {
    // Production answers the missing permission with NotFoundError, not
    // ForbiddenError: `requireProjectAccess` hides a project the caller cannot
    // name a permission on. The first call passed already, so the second one's
    // 404 is this denial.
    vi.mocked(requireProjectAccess)
      .mockResolvedValueOnce({ role: 'project-admin' } as never)
      .mockRejectedValueOnce(new NotFoundError('Project not found'))

    await expect(
      delegateTask(session, {
        projectId: PROJECT,
        kind: 'document',
        goal: 'Prüf das jeden Montag',
        cadence: { cron: '0 8 * * 1' },
      }),
    ).rejects.toThrow('project:skills:manage')

    // Nothing was written: the refusal is the whole outcome, and its message is
    // what the model relays.
    expect(repository.insertDefinition).not.toHaveBeenCalled()
    expect(submitAgentRun).not.toHaveBeenCalled()
  })

  it('refuses a delegation that is both one-off and recurring', async () => {
    await expect(
      delegateTask(session, {
        projectId: PROJECT,
        kind: 'document',
        goal: 'Prüf das',
        dueAt: new Date('2026-09-18T23:59:59Z'),
        cadence: { cron: '0 8 * * 1' },
      }),
    ).rejects.toBeInstanceOf(UnprocessableError)
    expect(repository.insertDefinition).not.toHaveBeenCalled()
  })
})

describe('what a delegated run is told to produce', () => {
  it('never tells a `document` or `revision` run to call the filing tools', async () => {
    // The job worker injects three unsigned identity headers and never the
    // signed envelope, so `file_draft` has no acting person and refuses — by
    // design. Telling the run to call it would spend budget on a refusal and
    // then have it report a failure for work it had actually done. The BFF is
    // the party with a real session at completion, so the BFF files.
    for (const kind of ['document', 'revision'] as const) {
      vi.clearAllMocks()
      vi.mocked(repository.insertDefinition).mockImplementation(async (values) => {
        insertedDefinition = { ...values, id: 'definition-1' } as TaskDefinition
        return insertedDefinition
      })
      vi.mocked(repository.insertDefinitionWithRun).mockImplementation(async (values, runValues) => {
        insertedDefinition = { ...values, id: 'definition-1' } as TaskDefinition
        insertedRun = { ...runValues, definitionId: insertedDefinition.id, id: 'run-1' } as TaskRun
        return { definition: insertedDefinition, run: insertedRun }
      })
      vi.mocked(repository.insertRun).mockImplementation(async (values) => {
    insertedRun = { ...values, id: 'run-1', conversationId: null } as TaskRun
    return insertedRun
  })
  vi.mocked(repository.updateRun).mockImplementation(async (_id, _org, patch) => ({ ...insertedRun, ...patch }) as TaskRun)
      vi.mocked(submitAgentRun).mockResolvedValue({
        backendJobId: 'b',
        conversationId: null,
        runMessageId: null,
      })
      await delegateTask(session, {
        projectId: PROJECT,
        kind,
        goal: 'Schreib das',
        subject: kind === 'revision' ? { documentId: 'd', versionId: 'v', comment: 'c' } : undefined,
      })
      expect(insertedDefinition.plan.prompt).not.toContain('file_draft')
      expect(insertedDefinition.plan.prompt).not.toContain('submit_draft')
      // The answer IS the document, which is what `completeRunForOutcome` files.
      expect(insertedDefinition.plan.prompt).toContain('Markdown')
    }
  })
})


describe('commissionResearchRun — an escalated question becomes a run', () => {
  const THREAD = 's_where_it_was_asked'
  const QUESTION = 'Gilt für das Atrium in Haus A OIB 2 oder OIB 2.3? Bitte mit den Wiener Abweichungen.'

  it('writes one run with no definition behind it, in the thread it was asked in', async () => {
    const result = await commissionResearchRun(session, {
      projectId: PROJECT,
      conversationId: THREAD,
      question: QUESTION,
    })

    const inserted = vi.mocked(repository.insertRun).mock.calls[0][0]
    expect(inserted).toMatchObject({
      definitionId: null,
      kind: 'deep-research',
      trigger: 'delegated',
      triggeredBy: 'user_asker',
      status: 'queued',
      requesterUserId: 'user_asker',
      projectId: PROJECT,
    })
    // The question is the prompt, verbatim: a rewritten one is a different run.
    expect(inserted.plan?.prompt).toBe(QUESTION)
    // The title is the question's first sentence, so a list row names the work.
    expect(inserted.title).toBe('Gilt für das Atrium in Haus A OIB 2 oder OIB 2.3?')

    expect(vi.mocked(submitAgentRun).mock.calls[0][0]).toMatchObject({
      output: 'deep-research',
      conversationId: THREAD,
      runId: 'run-1',
    })
    // Never a thread of its own: an escalation always has the one it came from.
    expect(createTaskThread).not.toHaveBeenCalled()

    expect(result).toEqual({
      runId: 'run-1',
      runMessageId: 'msg-run-1',
      conversationId: THREAD,
      status: 'running',
    })
  })

  it('composes what the turn already settled below the question, and keeps it out of the title', async () => {
    await commissionResearchRun(session, {
      projectId: PROJECT,
      conversationId: THREAD,
      question: QUESTION,
      context: 'Frage: Welches Geschoss? Antwort: Das Erdgeschoss.',
    })

    const inserted = vi.mocked(repository.insertRun).mock.calls[0][0]
    expect(inserted.plan?.prompt).toBe(
      `${QUESTION}\n\nWas in der Unterhaltung bereits geklärt wurde:\nFrage: Welches Geschoss? Antwort: Das Erdgeschoss.`,
    )
    expect(inserted.title).toBe('Gilt für das Atrium in Haus A OIB 2 oder OIB 2.3?')
  })

  it('carries the Rahmen and the Unterlagen onto the run and to the worker, and the context as the clarifier result', async () => {
    const documents = {
      grundlage: [{ name: 'Einreichplan.pdf', title: 'Einreichplan EG', shelf: 'project' }],
      ausgeschlossen: [{ name: 'alt.pdf' }],
    }
    await commissionResearchRun(session, {
      projectId: PROJECT,
      conversationId: THREAD,
      question: QUESTION,
      context: 'Frage: Welches Geschoss? Antwort: Das Erdgeschoss.',
      dataSources: ['knowledge_base'],
      documents,
    })

    const inserted = vi.mocked(repository.insertRun).mock.calls[0][0]
    expect(inserted.plan).toMatchObject({
      dataSources: ['knowledge_base'],
      context: 'Frage: Welches Geschoss? Antwort: Das Erdgeschoss.',
      documents,
    })
    expect(vi.mocked(submitAgentRun).mock.calls[0][0]).toMatchObject({
      dataSources: ['knowledge_base'],
      clarifierResult: 'Frage: Welches Geschoss? Antwort: Das Erdgeschoss.',
      documents,
    })
  })

  it('records no Unterlagen when the lists are empty', async () => {
    await commissionResearchRun(session, {
      projectId: PROJECT,
      conversationId: THREAD,
      question: QUESTION,
      documents: { grundlage: [], ausgeschlossen: [] },
    })
    const inserted = vi.mocked(repository.insertRun).mock.calls[0][0]
    expect(inserted.plan).not.toHaveProperty('documents')
  })

  it('asks for the same permissions handing over a task asks for', async () => {
    await commissionResearchRun(session, { projectId: PROJECT, conversationId: THREAD, question: QUESTION })
    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT, [
      'project:edit',
      'project:documents:write',
    ])
  })

  it('refuses a question that says nothing, and one past the bound', async () => {
    await expect(
      commissionResearchRun(session, { projectId: PROJECT, conversationId: THREAD, question: '   ' }),
    ).rejects.toBeInstanceOf(UnprocessableError)
    await expect(
      commissionResearchRun(session, {
        projectId: PROJECT,
        conversationId: THREAD,
        question: 'x'.repeat(TASK_GOAL_MAX_CHARS + 1),
      }),
    ).rejects.toBeInstanceOf(UnprocessableError)
    expect(repository.insertRun).not.toHaveBeenCalled()
  })

  it('records a refused submission as a failed run instead of throwing', async () => {
    vi.mocked(submitAgentRun).mockRejectedValue(new JobSubmitError('backend unreachable', 502))

    const result = await commissionResearchRun(session, {
      projectId: PROJECT,
      conversationId: THREAD,
      question: QUESTION,
    })

    expect(result.status).toBe('failed')
    expect(vi.mocked(repository.updateRun).mock.calls[0][2]).toMatchObject({
      status: 'failed',
      error: 'backend unreachable',
    })
  })

  it('lets a refused gate through: there is no run to record yet', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new NotFoundError('Unknown project'))
    await expect(
      commissionResearchRun(session, { projectId: PROJECT, conversationId: THREAD, question: QUESTION }),
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(repository.insertRun).not.toHaveBeenCalled()
  })
})
