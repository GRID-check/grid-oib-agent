/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./service', () => ({ getBudgetStatus: vi.fn() }))

import { getBudgetStatus } from './service'
import { unaskedSpendAllowed } from './unasked-spend'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('unaskedSpendAllowed', () => {
  it('asks the person’s, the project’s and the organization’s budgets', async () => {
    vi.mocked(getBudgetStatus).mockResolvedValue({ blocked: false } as never)
    expect(await unaskedSpendAllowed({ organizationId: 'org_1', userId: 'user_1' }, 'project-1')).toBe(true)
    expect(getBudgetStatus).toHaveBeenCalledWith('org_1', 'user_1', 'project-1')
  })

  it('asks no member’s budget for work that runs as the system', async () => {
    vi.mocked(getBudgetStatus).mockResolvedValue({ blocked: true } as never)
    expect(await unaskedSpendAllowed({ organizationId: 'org_1', userId: null }, 'project-1')).toBe(false)
    expect(getBudgetStatus).toHaveBeenCalledWith('org_1', null, 'project-1')
  })

  it('says no when the budget cannot be read', async () => {
    vi.mocked(getBudgetStatus).mockRejectedValue(new Error('db down'))
    expect(await unaskedSpendAllowed({ organizationId: 'org_1', userId: null }, null)).toBe(false)
  })
})
