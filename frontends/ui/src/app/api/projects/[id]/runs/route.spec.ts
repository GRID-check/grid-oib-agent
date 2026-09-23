/**
 * @vitest-environment node
 */
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    email: 'p@grid.test',
    role: 'admin',
    featureFlags: [],
  }),
}))
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({ findConversationInOrg: vi.fn() }))
vi.mock('@/lib/tasks/delegation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks/delegation')>()
  return { ...actual, commissionResearchRun: vi.fn() }
})

import { NotFoundError } from '@/lib/api/errors'
import { findConversationInOrg } from '@/lib/conversations/repository'
import { requireResourceAccess } from '@/lib/sharing/access'
import { commissionResearchRun } from '@/lib/tasks/delegation'
import { POST } from './route'

const PROJECT = '11111111-1111-4111-8111-111111111111'

const post = (body: unknown) =>
  POST(
    new NextRequest(`https://grid.test/api/projects/${PROJECT}/runs`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id: PROJECT }) }
  )

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.mocked(commissionResearchRun).mockReset()
  vi.mocked(requireResourceAccess).mockReset().mockResolvedValue({} as never)
  vi.mocked(findConversationInOrg)
    .mockReset()
    .mockResolvedValue({ id: 's_conv', projectId: PROJECT } as never)
})

describe('POST /api/projects/[id]/runs', () => {
  it('commissions a run in the thread that asked and answers its ids', async () => {
    vi.mocked(commissionResearchRun).mockResolvedValue({
      runId: 'run-1',
      runMessageId: 'msg-1',
      conversationId: 's_conv',
      status: 'queued',
    } as never)

    const response = await post({
      conversationId: 's_conv',
      question: 'Fluchtweg klären',
      context: 'Befund offen',
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      runId: 'run-1',
      runMessageId: 'msg-1',
      conversationId: 's_conv',
      status: 'queued',
    })
    expect(commissionResearchRun).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1' }),
      {
        projectId: PROJECT,
        conversationId: 's_conv',
        question: 'Fluchtweg klären',
        context: 'Befund offen',
        documents: null,
      }
    )
  })

  it('carries a continuation’s Grundlage into the commission', async () => {
    vi.mocked(commissionResearchRun).mockResolvedValue({
      runId: 'run-2',
      runMessageId: 'msg-2',
      conversationId: 's_conv',
      status: 'queued',
    } as never)
    const response = await post({
      conversationId: 's_conv',
      question: 'Fortschreibung: Bericht',
      documents: { grundlage: [{ name: 'Einreichplan.pdf', shelf: 'project' }], ausgeschlossen: [] },
    })
    expect(response.status).toBe(201)
    expect(commissionResearchRun).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1' }),
      expect.objectContaining({
        documents: { grundlage: [{ name: 'Einreichplan.pdf', shelf: 'project' }], ausgeschlossen: [] },
      })
    )
  })

  it('refuses a body without a question', async () => {
    const response = await post({ conversationId: 's_conv', question: '' })
    expect(response.status).toBe(400)
    expect(commissionResearchRun).not.toHaveBeenCalled()
  })

  it('answers 403 when deep research is off for the org', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    const response = await post({ conversationId: 's_conv', question: 'Fluchtweg klären' })
    expect(response.status).toBe(403)
    expect(commissionResearchRun).not.toHaveBeenCalled()
  })

  it('refuses a thread the caller may not post to', async () => {
    vi.mocked(requireResourceAccess).mockRejectedValue(new NotFoundError())
    const response = await post({ conversationId: 's_other', question: 'Fluchtweg klären' })
    expect(response.status).toBe(404)
    expect(requireResourceAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1' }),
      'conversation',
      's_other',
      'collaborator'
    )
    expect(commissionResearchRun).not.toHaveBeenCalled()
  })

  it('refuses a thread that belongs to another project', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue({
      id: 's_conv',
      projectId: '22222222-2222-4222-8222-222222222222',
    } as never)
    const response = await post({ conversationId: 's_conv', question: 'Fluchtweg klären' })
    expect(response.status).toBe(404)
    expect(commissionResearchRun).not.toHaveBeenCalled()
  })
})
