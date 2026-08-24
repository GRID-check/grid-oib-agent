import { render, screen } from '@/test-utils'
import { describe, expect, test, vi } from 'vitest'
import { PlatformNav, PLATFORM_SECTIONS } from './platform-nav'

const pathname = { value: '/app/platform' }

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.value,
}))

describe('PlatformNav', () => {
  test('links every platform section, twice (rail + mobile strip)', () => {
    pathname.value = '/app/platform'
    render(<PlatformNav />)

    for (const section of PLATFORM_SECTIONS) {
      const links = screen.getAllByRole('link', { name: new RegExp(section.key === 'overview' ? 'Overview' : '', 'i') })
      expect(links.length).toBeGreaterThan(0)
    }
    // Both viewports render the full set; CSS decides which is visible.
    expect(screen.getAllByRole('link')).toHaveLength(PLATFORM_SECTIONS.length * 2)
  })

  test('marks only the overview active at the bare platform path', () => {
    // A prefix test would light up every section here — the overview owns the
    // bare route, so it must match exactly.
    pathname.value = '/app/platform'
    render(<PlatformNav />)

    const current = screen.getAllByRole('link', { current: 'page' })
    expect(current).toHaveLength(2)
    for (const link of current) expect(link.textContent).toContain('Overview')
  })

  test('marks the matching subsection active, not the overview', () => {
    pathname.value = '/app/platform/knowledge'
    render(<PlatformNav />)

    const current = screen.getAllByRole('link', { current: 'page' })
    expect(current).toHaveLength(2)
    for (const link of current) expect(link.textContent).toContain('Base knowledge')
  })

  test('stays active on a nested subsection route', () => {
    pathname.value = '/app/platform/norms/some-detail'
    render(<PlatformNav />)

    const current = screen.getAllByRole('link', { current: 'page' })
    expect(current.length).toBeGreaterThan(0)
    for (const link of current) expect(link.textContent).toContain('Norm catalog')
  })

  test('does not mark a sibling route active on a shared prefix', () => {
    // `/app/platform/norms-draft` is not under `/app/platform/norms`; matching
    // must stop at a path boundary, not at any shared prefix.
    pathname.value = '/app/platform/norms-draft'
    render(<PlatformNav />)

    expect(screen.queryAllByRole('link', { current: 'page' })).toHaveLength(0)
  })

  test('marks nothing active when the pathname is unavailable', () => {
    pathname.value = null as unknown as string
    render(<PlatformNav />)

    expect(screen.queryAllByRole('link', { current: 'page' })).toHaveLength(0)
  })
})
