import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { RatingsFilters } from '@/lib/feedback/filters'
import type { QualityScope } from '@/lib/quality/scope'
import { parseQualityView, QualityWorkspace } from './quality-workspace'

const nav = vi.hoisted(() => ({ search: '', push: vi.fn() }))

vi.mock('next/navigation', () => ({
  usePathname: () => '/app/platform/quality',
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}))

const describeScope = (scope: QualityScope): string =>
  `${scope.from}..${scope.to} orgs=${scope.organizationIds.join(',')} projects=${scope.projectIds.join(',')}`

// The organisms fetch on mount; the workspace is only about which one is open
// and what it is handed. Each records the exact props the workspace passes.
vi.mock('./answer-feedback-health', () => ({
  AnswerFeedbackHealth: ({
    scope,
    filters,
    onFiltersChange,
  }: {
    scope: QualityScope
    filters: RatingsFilters
    onFiltersChange: (next: RatingsFilters) => void
  }) => (
    <div data-testid="ratings-view">
      ratings {describeScope(scope)} topics={filters.topics.join(',')}
      <button type="button" onClick={() => onFiltersChange({ ...filters, hasComment: true })}>
        only commented
      </button>
    </div>
  ),
}))
vi.mock('./citation-health', () => ({
  CitationHealth: ({ scope }: { scope: QualityScope }) => (
    <div data-testid="citations-view">citations {describeScope(scope)}</div>
  ),
}))
vi.mock('./agent-profiler', () => ({
  AgentProfiler: ({ scope }: { scope: QualityScope }) => (
    <div data-testid="timing-view">timing {describeScope(scope)}</div>
  ),
}))

const today = new Date().toISOString().slice(0, 10)

describe('parseQualityView', () => {
  test('falls back to the ratings view for anything not offered', () => {
    expect(parseQualityView(null)).toBe('ratings')
    expect(parseQualityView('nonsense')).toBe('ratings')
    expect(parseQualityView('citations')).toBe('citations')
  })
})

describe('QualityWorkspace', () => {
  beforeEach(() => {
    nav.search = ''
    nav.push.mockReset()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            organizations: [{ id: 'org_a', name: 'Atelier Nord' }],
            organizationsTruncated: false,
            projects: [],
            projectsTruncated: false,
          }),
          { status: 200 }
        )
      )
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  test('opens on the ratings view with the default 30 days ending today', () => {
    render(<QualityWorkspace />)
    expect(screen.getByTestId('ratings-view')).toHaveTextContent(`..${today} orgs= projects=`)
    expect(screen.queryByTestId('citations-view')).not.toBeInTheDocument()
  })

  test('hands the same scope from the URL to every view, under the prop `scope`', () => {
    nav.search = 'view=citations&from=2026-07-01&to=2026-09-30&org=org_a&project=p1'
    const { unmount } = render(<QualityWorkspace />)
    expect(screen.getByTestId('citations-view')).toHaveTextContent('2026-07-01..2026-09-30 orgs=org_a projects=p1')
    unmount()

    nav.search = 'view=timing&from=2026-07-01&to=2026-09-30&org=org_a'
    render(<QualityWorkspace />)
    expect(screen.getByTestId('timing-view')).toHaveTextContent('2026-07-01..2026-09-30 orgs=org_a')
  })

  test('still reads an old `days` link', () => {
    nav.search = 'days=7'
    render(<QualityWorkspace />)
    expect(screen.getByRole('radio', { name: '7 days' })).toHaveAttribute('data-state', 'on')
  })

  test('hands the ratings filters from the URL to the ratings view, and writes a change back', async () => {
    nav.search = 'from=2026-09-01&to=2026-09-30&topic=statik'
    render(<QualityWorkspace />)
    expect(screen.getByTestId('ratings-view')).toHaveTextContent('topics=statik')

    await userEvent.click(screen.getByRole('button', { name: 'only commented' }))
    expect(nav.push).toHaveBeenCalledWith(
      '/app/platform/quality?from=2026-09-01&to=2026-09-30&topic=statik&has_comment=1',
      { scroll: false }
    )
  })

  test('writes a range preset into the URL as from/to, keeping the view and the filters', async () => {
    nav.search = 'view=citations&topic=statik&days=7'
    render(<QualityWorkspace />)
    await userEvent.click(screen.getByRole('radio', { name: '90 days' }))

    const [url, options] = nav.push.mock.calls[0]
    const params = new URLSearchParams(String(url).split('?')[1])
    expect(options).toEqual({ scroll: false })
    expect(params.get('view')).toBe('citations')
    expect(params.get('topic')).toBe('statik')
    expect(params.get('days')).toBeNull()
    expect(params.get('to')).toBe(today)
  })

  test('shows the scope bar on every view, the runtime one included', async () => {
    nav.search = 'view=timing'
    render(<QualityWorkspace />)
    expect(screen.getByTestId('quality-scope-bar')).toBeInTheDocument()
    await waitFor(() => expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled())
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0][0])).toContain('/api/platform/quality/scope-options?from=')
  })
})
