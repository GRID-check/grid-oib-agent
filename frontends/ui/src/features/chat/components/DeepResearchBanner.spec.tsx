import { render, screen } from '@/test-utils'
import { describe, expect, test, vi } from 'vitest'
import { DeepResearchBanner } from './DeepResearchBanner'

const mockOpenRightPanel = vi.fn()
const mockSetResearchPanelTab = vi.fn()
const mockLoadResearchPanelTab = vi.fn()

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: vi.fn(
    (
      selector?: (s: {
        openRightPanel: typeof mockOpenRightPanel
        setResearchPanelTab: typeof mockSetResearchPanelTab
      }) => unknown
    ) => {
      const state = {
        openRightPanel: mockOpenRightPanel,
        setResearchPanelTab: mockSetResearchPanelTab,
      }
      return selector ? selector(state) : state
    }
  ),
}))

vi.mock('../hooks/use-load-job-data', () => ({
  useLoadJobData: () => ({
    loadResearchPanelTab: mockLoadResearchPanelTab,
  }),
}))

describe('DeepResearchBanner', () => {
  test('renders the View Report action on a successful run', () => {
    render(<DeepResearchBanner bannerType="success" jobId="job-1" />)

    expect(screen.getByRole('button', { name: 'View Report' })).toBeInTheDocument()
  })

  test.each([
    ['failure', 'View Thinking'],
    ['cancelled', 'View Progress'],
  ] as const)(
    'renders the %s banner diagnosis action so the outcome can be inspected',
    (bannerType, actionLabel) => {
      render(<DeepResearchBanner bannerType={bannerType} jobId="job-1" />)

      expect(screen.getByRole('button', { name: actionLabel })).toBeInTheDocument()
    }
  )

  test('keeps the live starting banner action-free', () => {
    render(<DeepResearchBanner bannerType="starting" jobId="job-1" />)

    expect(screen.queryByRole('button', { name: 'View Progress' })).not.toBeInTheDocument()
  })

  test('renders an expired report warning without an action', () => {
    render(<DeepResearchBanner bannerType="expired" jobId="job-1" />)

    expect(screen.getByText('Report Expired')).toBeInTheDocument()
    expect(
      screen.getByText(/The report has expired and is no longer available/i)
    ).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
