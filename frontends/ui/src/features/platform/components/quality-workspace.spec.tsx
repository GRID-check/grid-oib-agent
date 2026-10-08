import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { parseQualityView, parseQualityWindow, QualityWorkspace } from './quality-workspace'

const nav = vi.hoisted(() => ({ search: '', push: vi.fn() }))

vi.mock('next/navigation', () => ({
  usePathname: () => '/app/platform/quality',
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}))

// The organisms fetch on mount; the workspace is only about which one is open
// and what window it is handed.
vi.mock('./answer-feedback-health', () => ({
  AnswerFeedbackHealth: ({ days }: { days: number }) => (
    <div data-testid="ratings-view">ratings {days}</div>
  ),
}))
vi.mock('./citation-health', () => ({
  CitationHealth: ({ days }: { days: number }) => (
    <div data-testid="citations-view">citations {days}</div>
  ),
}))
vi.mock('./agent-profiler', () => ({
  AgentProfiler: () => <div data-testid="timing-view">timing</div>,
}))

describe('parseQualityView / parseQualityWindow', () => {
  test('fall back to the ratings view and 30 days for anything not offered', () => {
    expect(parseQualityView(null)).toBe('ratings')
    expect(parseQualityView('nonsense')).toBe('ratings')
    expect(parseQualityView('citations')).toBe('citations')
    expect(parseQualityWindow(null)).toBe(30)
    expect(parseQualityWindow('14')).toBe(30)
    expect(parseQualityWindow('90')).toBe(90)
  })
})

describe('QualityWorkspace', () => {
  beforeEach(() => {
    nav.search = ''
    nav.push.mockReset()
  })

  test('opens on the ratings view with the default window', () => {
    render(<QualityWorkspace />)
    expect(screen.getByTestId('ratings-view')).toHaveTextContent('ratings 30')
    expect(screen.queryByTestId('citations-view')).not.toBeInTheDocument()
  })

  test('hands the window from the URL to the open view', () => {
    nav.search = 'view=citations&days=7'
    render(<QualityWorkspace />)
    expect(screen.getByTestId('citations-view')).toHaveTextContent('citations 7')
  })

  test('writes a window change into the URL, keeping the view', async () => {
    nav.search = 'view=citations'
    render(<QualityWorkspace />)
    await userEvent.click(screen.getByRole('radio', { name: /90/ }))
    expect(nav.push).toHaveBeenCalledWith('/app/platform/quality?view=citations&days=90', {
      scroll: false,
    })
  })

  test('hides the window control on the runtime view, which has no window', () => {
    nav.search = 'view=timing'
    render(<QualityWorkspace />)
    expect(screen.getByTestId('timing-view')).toBeInTheDocument()
    expect(screen.queryByTestId('quality-window')).not.toBeInTheDocument()
  })
})
