import { render, screen } from '@/test-utils'
import { describe, expect, test, vi } from 'vitest'
import {
  ORGANIZATION_SECTIONS,
  OrganizationNav,
  type OrganizationSectionKey,
} from './organization-nav'

const pathname = { value: '/app/organization' }

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.value,
}))

/** Everything an org admin would be handed. */
const ALL_SECTIONS: OrganizationSectionKey[] = ORGANIZATION_SECTIONS.map((section) => section.key)

describe('OrganizationNav', () => {
  test('renders every granted section, twice (rail + mobile strip)', () => {
    pathname.value = '/app/organization'
    render(<OrganizationNav sections={ALL_SECTIONS} />)

    // Both viewports render the full set; CSS decides which is visible.
    expect(screen.getAllByRole('link')).toHaveLength(ALL_SECTIONS.length * 2)
    expect(screen.getAllByRole('link', { name: 'People & access' })).toHaveLength(2)
    expect(screen.getAllByRole('link', { name: 'Enterprise' })).toHaveLength(2)
  })

  test('renders only the sections it was granted', () => {
    // What a plain member gets: the overview and their own usage, nothing else.
    pathname.value = '/app/organization'
    render(<OrganizationNav sections={['overview', 'budgets']} />)

    expect(screen.getAllByRole('link')).toHaveLength(4)
    expect(screen.queryAllByRole('link', { name: 'Models' })).toHaveLength(0)
    expect(screen.queryAllByRole('link', { name: 'People & access' })).toHaveLength(0)
    expect(screen.queryAllByRole('link', { name: 'Enterprise' })).toHaveLength(0)
  })

  test('keeps the canonical order whatever order the sections arrive in', () => {
    // The layout builds the set from capability checks, not from the nav's
    // order — so the nav, not its caller, decides how the tier reads.
    pathname.value = '/app/organization'
    render(<OrganizationNav sections={['enterprise', 'budgets', 'overview']} />)

    const labels = screen
      .getAllByRole('link')
      .slice(0, 3)
      .map((link) => link.textContent)
    expect(labels).toEqual(['Overview', 'Usage & budgets', 'Enterprise'])
  })

  test('marks only the overview active at the bare organization path', () => {
    // A prefix test would light up every section here — the overview owns the
    // bare route, so it must match exactly.
    pathname.value = '/app/organization'
    render(<OrganizationNav sections={ALL_SECTIONS} />)

    const current = screen.getAllByRole('link', { current: 'page' })
    expect(current).toHaveLength(2)
    for (const link of current) expect(link.textContent).toBe('Overview')
  })

  test('marks the matching subsection active, not the overview', () => {
    pathname.value = '/app/organization/access'
    render(<OrganizationNav sections={ALL_SECTIONS} />)

    const current = screen.getAllByRole('link', { current: 'page' })
    expect(current).toHaveLength(2)
    for (const link of current) expect(link.textContent).toBe('People & access')
  })

  test('stays active on a nested subsection route', () => {
    pathname.value = '/app/organization/models/some-detail'
    render(<OrganizationNav sections={ALL_SECTIONS} />)

    const current = screen.getAllByRole('link', { current: 'page' })
    expect(current).toHaveLength(2)
    for (const link of current) expect(link.textContent).toBe('Models')
  })

  test('does not mark a sibling route active on a shared prefix', () => {
    // `/app/organization/access-log` is not under `/app/organization/access`;
    // matching must stop at a path boundary, not at any shared prefix.
    pathname.value = '/app/organization/access-log'
    render(<OrganizationNav sections={ALL_SECTIONS} />)

    expect(screen.queryAllByRole('link', { current: 'page' })).toHaveLength(0)
  })

  test('marks nothing active when the pathname is unavailable', () => {
    pathname.value = null as unknown as string
    render(<OrganizationNav sections={ALL_SECTIONS} />)

    expect(screen.queryAllByRole('link', { current: 'page' })).toHaveLength(0)
  })
})
