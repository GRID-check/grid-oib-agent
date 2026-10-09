import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'

vi.mock('server-only', () => ({}))

const requireProjectAccess = vi.fn(async () => ({ role: 'project-viewer' }))
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: (...args: unknown[]) => requireProjectAccess(...(args as [])),
}))

const countQuestionsPerDay = vi.fn()
const countAskingPeople = vi.fn()
vi.mock('./activity-repository', () => ({
  countQuestionsPerDay: (...args: unknown[]) => countQuestionsPerDay(...args),
  countAskingPeople: (...args: unknown[]) => countAskingPeople(...args),
}))

import { getProjectActivity } from './activity'

const session = { organizationId: 'org-1', userId: 'u1' } as AuthorizedSession

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-09T12:00:00Z'))
  countAskingPeople.mockResolvedValue(3)
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('getProjectActivity', () => {
  test('zero-fills 30 days and sums only this month into the headline', async () => {
    countQuestionsPerDay.mockResolvedValue([
      { day: '2026-09-20', questions: 7 }, // last month: in the trend, not the headline
      { day: '2026-10-01', questions: 2 },
      { day: '2026-10-09', questions: 4 },
    ])

    const activity = await getProjectActivity(session, 'p1')

    expect(activity.daily).toHaveLength(30)
    expect(activity.daily[0]).toEqual({ day: '2026-09-10', questions: 0 })
    expect(activity.daily.at(-1)).toEqual({ day: '2026-10-09', questions: 4 })
    expect(activity.questionsThisMonth).toBe(6)
    expect(activity.peopleThisMonth).toBe(3)
  })

  test('checks project view access before reading anything', async () => {
    requireProjectAccess.mockRejectedValueOnce(new Error('Not found'))

    await expect(getProjectActivity(session, 'p1')).rejects.toThrow('Not found')
    expect(countQuestionsPerDay).not.toHaveBeenCalled()
  })
})
