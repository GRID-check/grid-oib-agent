/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({
  insertDefinition: vi.fn(),
  insertDefinitionWithRun: vi.fn(),
  updateRun: vi.fn(),
}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/jobs/service', () => ({ submitAgentRun: vi.fn() }))
vi.mock('@/lib/skills/service', () => ({ resolveSkillSnapshot: vi.fn() }))

import { NotFoundError, UnprocessableError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { TaskDefinition, TaskRun } from '@/lib/db/schema'
import { JobSubmitError } from '@/lib/jobs/backend-client'
import { submitAgentRun } from '@/lib/jobs/service'
import { resolveSkillSnapshot } from '@/lib/skills/service'
import * as repository from './repository'
import { delegateTask, isDelegatableTaskKind, TASK_GOAL_MAX_CHARS } from './delegation'

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
  vi.mocked(repository.updateRun).mockImplementation(async (_id, _org, patch) => ({ ...insertedRun, ...patch }) as TaskRun)
  vi.mocked(submitAgentRun).mockResolvedValue({ backendJobId: 'backend-1', conversationId: 's_conv_2' })
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
      jobId: null,
    })
    expect(insertedRun.conversationId).toBeNull()
    // The conversation id comes back from the submission and is recorded, so
    // the card can link a reader to the work rather than only announce it.
    const updated = vi.mocked(repository.updateRun).mock.calls[0][2]
    expect(updated).toMatchObject({ status: 'running', backendJobId: 'backend-1', conversationId: 's_conv_2' })
  })

  it('attaches and freezes the einreichcheck skill', async () => {
    vi.mocked(resolveSkillSnapshot).mockResolvedValue({
      name: 'einreichcheck',
      description: 'Was fehlt',
      body: '# Einreichcheck',
      metadata: {},
      origin: 'platform',
    })

    await delegateTask(session, { projectId: PROJECT, kind: 'einreichcheck', goal: 'Prüf die Einreichung' })

    expect(resolveSkillSnapshot).toHaveBeenCalledWith('einreichcheck', 'org_1')
    expect(insertedDefinition.plan.skill.name).toBe('einreichcheck')
    // The same words a job's fire prompt uses, so the model reads one contract.
    expect(insertedDefinition.plan.prompt).toContain('Verwende dabei den folgenden Skill verbindlich und vollständig.')
    expect(insertedDefinition.plan.prompt).toContain('# Einreichcheck')
    expect(insertedRun.skillSnapshot.name).toBe('einreichcheck')
  })

  it('refuses when the skill an engine names is not available to this organization', async () => {
    vi.mocked(resolveSkillSnapshot).mockRejectedValue(new NotFoundError('Unknown skill "einreichcheck".'))

    await expect(
      delegateTask(session, { projectId: PROJECT, kind: 'einreichcheck', goal: 'Prüf das' }),
    ).rejects.toBeInstanceOf(UnprocessableError)
    expect(repository.insertDefinition).not.toHaveBeenCalled()
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
      vi.mocked(repository.updateRun).mockImplementation(async (_id, _org, patch) => ({ ...insertedRun, ...patch }) as TaskRun)
      vi.mocked(submitAgentRun).mockResolvedValue({ backendJobId: 'b', conversationId: null })
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
