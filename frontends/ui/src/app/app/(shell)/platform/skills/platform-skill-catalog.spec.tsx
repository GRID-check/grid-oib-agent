import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PlatformSkillItem } from '@/adapters/api/skills-client'
import { PlatformAccessProvider } from '@/features/platform/platform-access'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { PlatformSkillCatalog } from './platform-skill-catalog'

const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() },
}))

const client = vi.hoisted(() => ({
  listPlatformSkills: vi.fn(),
  listPlatformSkillCategories: vi.fn(),
  updatePlatformSkill: vi.fn(),
  deletePlatformSkill: vi.fn(),
  createPlatformSkill: vi.fn(),
  createPlatformSkillCategory: vi.fn(),
  updatePlatformSkillCategory: vi.fn(),
  deletePlatformSkillCategory: vi.fn(),
}))
vi.mock('@/adapters/api/skills-client', () => client)

// The category manager is its own surface; here it only needs to be able to
// say "something changed", which is one of the paths that reloads the list.
vi.mock('@/features/skills/components/skill-category-manager', () => ({
  SkillCategoryManager: ({ onChanged }: { onChanged: () => void }) => (
    <button type="button" onClick={onChanged}>
      simulate category change
    </button>
  ),
}))

const skill = (overrides: Partial<PlatformSkillItem>): PlatformSkillItem => ({
  id: 'ps-1',
  name: 'oib-fire-check',
  description: 'Checks fire safety.',
  body: 'body',
  metadata: {},
  published: true,
  delivery: 'offer',
  categoryId: null,
  createdAt: '2026-08-01T09:00:00Z',
  updatedAt: '2026-08-01T09:00:00Z',
  ...overrides,
})

describe('PlatformSkillCatalog', () => {
  beforeEach(() => {
    for (const fn of Object.values(client)) fn.mockReset()
    toastError.mockReset()
    client.listPlatformSkills.mockResolvedValue([
      skill({}),
      skill({ id: 'ps-2', name: 'energy-check', published: false }),
    ])
    client.listPlatformSkillCategories.mockResolvedValue([])
  })

  test('publishing a draft asks first; withdrawing does not', async () => {
    client.updatePlatformSkill.mockResolvedValue(skill({}))
    render(<PlatformSkillCatalog />)

    await userEvent.click(await screen.findByRole('switch', { name: /energy-check/ }))
    expect(client.updatePlatformSkill).not.toHaveBeenCalled()
    await userEvent.click(await screen.findByRole('button', { name: 'Publish' }))
    expect(client.updatePlatformSkill).toHaveBeenCalledWith('ps-2', { published: true })

    await userEvent.click(screen.getByRole('switch', { name: /oib-fire-check/ }))
    expect(client.updatePlatformSkill).toHaveBeenCalledWith('ps-1', { published: false })
  })

  test('a failed delete says so (not "could not save") and keeps the confirm open', async () => {
    let reject: (reason: Error) => void = () => undefined
    client.deletePlatformSkill.mockReturnValue(new Promise((_, r) => (reject = r)))
    render(<PlatformSkillCatalog />)

    await userEvent.click(await screen.findByRole('button', { name: 'Delete “oib-fire-check”' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete skill' }))
    // While the server works, the confirm is still on screen and busy.
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true')

    reject(new Error('500'))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Could not delete the curated skill.')
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('platform-skill-oib-fire-check')).toBeInTheDocument()
  })

  test('a reload after a save keeps the rows instead of flashing skeletons', async () => {
    render(<PlatformSkillCatalog />)
    await screen.findByTestId('platform-skill-oib-fire-check')

    client.listPlatformSkills.mockReturnValue(new Promise(() => undefined))
    await userEvent.click(screen.getByRole('button', { name: 'simulate category change' }))

    expect(screen.getByTestId('section-refreshing')).toBeInTheDocument()
    expect(screen.queryByTestId('section-loading')).toBeNull()
    expect(screen.getByTestId('platform-skill-oib-fire-check')).toBeInTheDocument()
  })

  test('read-only staff see the catalogue with no write control', async () => {
    render(
      <PlatformAccessProvider permissions={[PLATFORM_PERMISSIONS.settingsView]}>
        <PlatformSkillCatalog />
      </PlatformAccessProvider>
    )
    const row = await screen.findByTestId('platform-skill-oib-fire-check')
    expect(within(row).getByRole('switch')).toBeDisabled()
    expect(within(row).queryByRole('button')).toBeNull()
    expect(screen.queryByRole('button', { name: 'New curated skill' })).toBeNull()
  })
})
