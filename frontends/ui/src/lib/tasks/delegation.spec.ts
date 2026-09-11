/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({ insertTask: vi.fn(), updateTask: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/jobs/service', () => ({ submitAgentRun: vi.fn() }))
vi.mock('@/lib/skills/service', () => ({ resolveSkillSnapshot: vi.fn() }))

import { NotFoundError, UnprocessableError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { Task } from '@/lib/db/schema'
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

/** The inserted row, as the database would hand it back. */
let inserted: Task

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(repository.insertTask).mockImplementation(async (values) => {
    inserted = { ...values, id: 'task-1', status: 'queued', conversationId: null, deadlineAt: values.deadlineAt ?? null } as Task
    return inserted
  })
  vi.mocked(repository.updateTask).mockImplementation(async (_id, _org, patch) => ({ ...inserted, ...patch }) as Task)
  vi.mocked(submitAgentRun).mockResolvedValue({ backendJobId: 'backend-1', conversationId: 's_conv_2' })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('delegateTask', () => {
  it('pins the caller as the requester and freezes the goal on the plan', async () => {
    const task = await delegateTask(session, { projectId: PROJECT, kind: 'compliance_check', goal: 'Prüf das Haus A' })

    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT, [
      'project:edit',
      'project:documents:write',
    ])
    expect(inserted.requesterUserId).toBe('user_asker')
    expect(inserted.requesterEmail).toBe('asker@grid.test')
    expect(inserted.plan.goal).toBe('Prüf das Haus A')
    // Verbatim inside the prompt: the engine's instruction is meta, the goal is
    // the person's own sentence.
    expect(inserted.plan.prompt).toContain('Prüf das Haus A')
    expect(task.status).toBe('running')
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
    expect(inserted.conversationId).toBeNull()
    // The conversation id comes back from the submission and is recorded, so
    // the card can link a reader to the work rather than only announce it.
    const updated = vi.mocked(repository.updateTask).mock.calls[0][2]
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
    expect(inserted.plan.skill.name).toBe('einreichcheck')
    // The same words a job's fire prompt uses, so the model reads one contract.
    expect(inserted.plan.prompt).toContain('Verwende dabei den folgenden Skill verbindlich und vollständig.')
    expect(inserted.plan.prompt).toContain('# Einreichcheck')
  })

  it('refuses when the skill an engine names is not available to this organization', async () => {
    vi.mocked(resolveSkillSnapshot).mockRejectedValue(new NotFoundError('Unknown skill "einreichcheck".'))

    await expect(
      delegateTask(session, { projectId: PROJECT, kind: 'einreichcheck', goal: 'Prüf das' }),
    ).rejects.toBeInstanceOf(UnprocessableError)
    expect(repository.insertTask).not.toHaveBeenCalled()
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

    expect(inserted.plan.prompt).toContain('```markdown')
    expect(inserted.plan.prompt).toContain('Die Länge beträgt 42 m.')
    expect(inserted.plan.subject).toEqual({
      documentId: 'doc-3',
      versionId: 'ver-1',
      comment: 'Die Fluchtweglänge stimmt nicht',
    })
    // The RE-FILING carries the permissions the original filing carried: the
    // reviewer authorizes the delegation and does not lend their own.
    expect(inserted.requesterUserId).toBe('user_author')
  })

  it('says so when the quoted version is cut rather than ending it mid-paragraph', async () => {
    await delegateTask(session, {
      projectId: PROJECT,
      kind: 'revision',
      goal: 'Kürzen',
      subject: { documentId: 'doc-3', versionId: 'ver-1', comment: 'Kürzen' },
      sourceText: 'x'.repeat(70_000),
    })
    expect(inserted.plan.prompt).toContain('hier gekürzt')
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
    expect(repository.insertTask).not.toHaveBeenCalled()
  })

  it('records a submission failure ON the row rather than throwing it at the caller', async () => {
    // The alternative loses the one case a person most wants explained: the
    // chat tool and the lifecycle effect would each have to invent their own
    // way of saying the queue would not take it.
    vi.mocked(submitAgentRun).mockRejectedValue(new JobSubmitError('backend unreachable', 502))

    const task = await delegateTask(session, { projectId: PROJECT, kind: 'document', goal: 'Schreib das' })

    expect(task.status).toBe('failed')
    expect(task.error).toContain('backend unreachable')
  })

  it('audits the creation as `task.created`, with the trigger named', async () => {
    await delegateTask(session, { projectId: PROJECT, kind: 'compliance_check', goal: 'Prüf das' })
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'task.created',
        targetType: 'task',
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
    // `chat` and `deep-research` describe how a JOB delivers a result; asking
    // for one would be naming a delivery channel where work belongs.
    expect(isDelegatableTaskKind('chat')).toBe(false)
    expect(isDelegatableTaskKind('deep-research')).toBe(false)
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
      vi.mocked(submitAgentRun).mockResolvedValue({ backendJobId: 'b', conversationId: null })
      await delegateTask(session, {
        projectId: PROJECT,
        kind,
        goal: 'Schreib das',
        subject: kind === 'revision' ? { documentId: 'd', versionId: 'v', comment: 'c' } : undefined,
      })
      expect(inserted.plan.prompt).not.toContain('file_draft')
      expect(inserted.plan.prompt).not.toContain('submit_draft')
      // The answer IS the document, which is what `completeTaskForRun` files.
      expect(inserted.plan.prompt).toContain('Markdown')
    }
  })
})
