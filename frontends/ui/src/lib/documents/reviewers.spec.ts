/**
 * @vitest-environment node
 */
/**
 * The reviewer chain (ADR-0054, and the review that found it broken).
 *
 * The bug it exists for: a draft Piloti files is `Unvergeben` BY CONSTRUCTION
 * (ADR-0047), so the assignment fallback resolved to nobody and `submit` was
 * refused with „name a reviewer or assign the document first" on every path
 * that had no way to name one — the draft card, the lifecycle panel, and the
 * agent's own `submit_draft`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDocument } from '@/test-utils/db-fixtures'
import type { AuthorizedSession } from '@/lib/auth/types'

vi.mock('@/lib/assignments/repository', () => ({ listAssignmentsForResources: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/authz/project-membership', () => ({
  filterUsersWithProjectPermission: vi.fn(),
}))

import { listAssignmentsForResources } from '@/lib/assignments/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { filterUsersWithProjectPermission } from '@/lib/authz/project-membership'
import { listReviewCandidates, matchReviewCandidate, resolveReviewers } from './reviewers'

const session: AuthorizedSession = {
  userId: 'user_me',
  email: 'me@example.test',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

const document = makeDocument({ id: 'doc_1', projectId: 'proj_1' })
const projectless = makeDocument({ id: 'doc_2', projectId: null })

const person = (userId: string, name: string, email: string | null = null) => ({
  userId,
  name,
  email,
  profilePictureUrl: null,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listAssignmentsForResources).mockResolvedValue([])
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map([
      ['user_me', person('user_me', 'Ich')],
      ['user_anna', person('user_anna', 'Anna Berger', 'anna@buero.test')],
      ['user_bernd', person('user_bernd', 'Bernd Klar', 'bernd@buero.test')],
    ]),
  )
  vi.mocked(filterUsersWithProjectPermission).mockResolvedValue(
    new Set(['user_anna', 'user_bernd']),
  )
})

describe('listReviewCandidates', () => {
  it('asks for project:edit, not project:view', async () => {
    // Being able to OPEN a project does not make somebody able to release a
    // Brandschutzkonzept, and a picker built on the assignment candidates would
    // offer people whose Freigabe the approve transition then refuses.
    await listReviewCandidates(session, document)
    expect(filterUsersWithProjectPermission).toHaveBeenCalledWith(
      session,
      'proj_1',
      expect.arrayContaining(['user_anna', 'user_bernd']),
      'project:edit',
    )
  })

  it('never offers the person asking', async () => {
    const candidates = await listReviewCandidates(session, document)
    expect(candidates.map((entry) => entry.userId)).toEqual(['user_anna', 'user_bernd'])
  })

  it('has nobody to offer for a document with no project', async () => {
    // The org-wide Archiv and a chat attachment have no project roster to ask.
    expect(await listReviewCandidates(session, projectless)).toEqual([])
    expect(filterUsersWithProjectPermission).not.toHaveBeenCalled()
  })
})

describe('resolveReviewers — the chain', () => {
  it('takes the people the caller named and asks nothing else', async () => {
    const resolved = await resolveReviewers(session, document, ['user_x', 'user_x', 'user_y'])
    expect(resolved).toEqual({ reviewers: ['user_x', 'user_y'], selfReview: false })
    expect(listAssignmentsForResources).not.toHaveBeenCalled()
  })

  it('asks whoever is on the hook next', async () => {
    vi.mocked(listAssignmentsForResources).mockResolvedValue([
      {
        resourceType: 'document',
        resourceId: 'doc_1',
        subjectUserId: 'user_anna',
        assignedBy: 'x',
        createdAt: new Date(),
      },
    ])
    const resolved = await resolveReviewers(session, document, [])
    expect(resolved).toEqual({ reviewers: ['user_anna'], selfReview: false })
  })

  it('opens the round to every editor for an Unvergeben draft', async () => {
    // The case the whole chain exists for: a Piloti draft nobody has taken.
    const resolved = await resolveReviewers(session, document, undefined)
    expect(resolved).toEqual({ reviewers: ['user_anna', 'user_bernd'], selfReview: false })
  })

  it('does not let the submitter be their own reviewer by way of an assignment', async () => {
    vi.mocked(listAssignmentsForResources).mockResolvedValue([
      {
        resourceType: 'document',
        resourceId: 'doc_1',
        subjectUserId: session.userId,
        assignedBy: 'x',
        createdAt: new Date(),
      },
    ])
    const resolved = await resolveReviewers(session, document, [])
    expect(resolved.reviewers).toEqual(['user_anna', 'user_bernd'])
  })

  it('waives to the submitter in a one-person project, and says it did', async () => {
    // Refusing here would make the lifecycle unusable for a sole
    // Ziviltechniker. The waiver is recorded rather than granted silently.
    vi.mocked(filterUsersWithProjectPermission).mockResolvedValue(new Set())
    const resolved = await resolveReviewers(session, document, [])
    expect(resolved).toEqual({ reviewers: [session.userId], selfReview: true })
  })

  it('never resolves to nobody, which is what used to refuse the submission', async () => {
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())
    const resolved = await resolveReviewers(session, projectless, [])
    expect(resolved.reviewers).toHaveLength(1)
  })
})

describe('matchReviewCandidate — the name the agent was given', () => {
  const candidates = [
    { userId: 'user_anna', name: 'Anna Berger', email: 'anna@buero.test' },
    { userId: 'user_bernd', name: 'Bernd Klar', email: 'bernd@buero.test' },
  ]

  it('matches a display name, case- and whitespace-tolerantly', () => {
    expect(matchReviewCandidate(candidates, '  anna berger ')).toEqual({
      ok: true,
      userId: 'user_anna',
    })
  })

  it('matches an e-mail address', () => {
    expect(matchReviewCandidate(candidates, 'BERND@buero.test')).toEqual({
      ok: true,
      userId: 'user_bernd',
    })
  })

  it('refuses a name the project cannot identify', () => {
    expect(matchReviewCandidate(candidates, 'Anna')).toEqual({ ok: false, reason: 'unknown' })
  })

  it('refuses an ambiguous one rather than picking', () => {
    // Two people called „Anna" means the caller has not said which, and picking
    // one puts a Freigabe in front of somebody who was never asked.
    const twins = [
      { userId: 'user_a', name: 'Anna Berger', email: 'a@buero.test' },
      { userId: 'user_b', name: 'Anna Berger', email: 'b@buero.test' },
    ]
    expect(matchReviewCandidate(twins, 'Anna Berger')).toEqual({ ok: false, reason: 'ambiguous' })
  })
})
