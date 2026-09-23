/**
 * @vitest-environment node
 */
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({ userId: 'user_1', organizationId: 'org_1', email: 'p@grid.test', role: 'admin' }),
}))
vi.mock('@/lib/plans/service', () => ({ proposePlannedRun: vi.fn() }))

import { proposePlannedRun } from '@/lib/plans/service'
import { POST } from './route'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const post = (body: unknown) =>
  POST(
    new NextRequest(`https://grid.test/api/projects/${PROJECT}/plans`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id: PROJECT }) }
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(proposePlannedRun).mockResolvedValue({ plan: { id: 'plan-1' }, run: { runId: 'run-1' } } as never)
})

describe('POST /api/projects/[id]/plans — a plan a person wrote', () => {
  it('creates the plan approved, as the person, and commissions its run', async () => {
    const response = await post({
      conversationId: 's_conv',
      question: 'Fluchtwege prüfen',
      sections: ['Bestand', 'Befund'],
      genre: 'pruefbericht',
      grundlage: ['Einreichplan.pdf'],
      unterlagen: [{ name: 'Einreichplan.pdf', shelf: 'project' }],
    })
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ plan: { id: 'plan-1' }, run: { runId: 'run-1' } })
    expect(proposePlannedRun).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org_1' }), {
      projectId: PROJECT,
      conversationId: 's_conv',
      author: 'user',
      start: 'approved',
      context: null,
      draft: {
        question: 'Fluchtwege prüfen',
        sections: ['Bestand', 'Befund'],
        genre: 'pruefbericht',
        depth: 'gutachten',
        grundlage: ['Einreichplan.pdf'],
        ausgeschlossen: [],
        nurGrundlage: false,
        unterlagen: [{ name: 'Einreichplan.pdf', shelf: 'project' }],
      },
    })
  })

  it('a carried-forward plan counts down first and carries its context', async () => {
    await post({ conversationId: 's_conv', question: 'Fortschreibung', sections: ['A'], context: 'Befunde', countdown: true })
    expect(vi.mocked(proposePlannedRun).mock.calls[0][1]).toMatchObject({
      start: { policy: 'auto' },
      context: 'Befunde',
    })
  })

  it('refuses a plan without sections', async () => {
    expect((await post({ conversationId: 's_conv', question: 'x', sections: [] })).status).toBe(400)
    expect(proposePlannedRun).not.toHaveBeenCalled()
  })
})
