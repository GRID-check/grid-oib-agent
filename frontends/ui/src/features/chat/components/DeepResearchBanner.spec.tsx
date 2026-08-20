import { render, screen } from '@/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DeepResearchBanner } from './DeepResearchBanner'
import { useChatStore } from '../store'

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

/**
 * The banner reads the active project off the real chat store (it is a fact
 * about where this chat is, not about the message). Setting it is therefore how
 * a test says "this chat is inside a project". It is reset BEFORE each test
 * rather than after: resetting afterwards writes to the store while the
 * previous test's tree is still mounted, which React reports as an unacted
 * update.
 */
const enterProject = (projectId: string | null): void => {
  useChatStore.setState({ projectId })
}

beforeEach(() => {
  enterProject(null)
})

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

  test('discloses the filing destination on the starting banner, inside a project', () => {
    enterProject('proj-1')

    render(<DeepResearchBanner bannerType="starting" jobId="job-1" />)

    // The disclosure is what makes the authorization real, and the starting
    // banner is the only moment it is worth anything: the run can still be
    // stopped. Deep research has no submit form to carry it — it escalates out
    // of a chat turn — so this line is the whole of what the user was told.
    expect(
      screen.getByText('The finished report will be filed in this project under “Berichte”.')
    ).toBeInTheDocument()
  })

  test('discloses nothing outside a project, where nothing is filed', () => {
    render(<DeepResearchBanner bannerType="starting" jobId="job-1" />)

    expect(screen.queryByText(/will be filed in this project/)).not.toBeInTheDocument()
  })

  test('offers the filed document on the success banner through the Files deep link', () => {
    enterProject('proj-1')

    render(
      <DeepResearchBanner
        bannerType="success"
        jobId="job-1"
        filedDocument={{ documentId: 'doc-9', filename: 'fluchtwege-2026-08-20.docx' }}
      />
    )

    expect(screen.getByText('Filed in the project: fluchtwege-2026-08-20.docx')).toBeInTheDocument()
    // The one deep-link shape the Files feature already uses — never a second one.
    expect(screen.getByRole('link', { name: 'Open in Project' })).toHaveAttribute(
      'href',
      '/app/projects/proj-1/files?doc=doc-9'
    )
  })

  test('claims no file when the run was not filed', () => {
    enterProject('proj-1')

    render(<DeepResearchBanner bannerType="success" jobId="job-1" />)

    // Filing is refused for a whole family of ordinary reasons. Saying nothing
    // is the requirement; a "maybe" or a dead link would be worse than silence.
    expect(screen.queryByText(/Filed in the project/)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open in Project' })).not.toBeInTheDocument()
  })

  test('renders no modal or confirmation on any banner state', () => {
    enterProject('proj-1')

    render(<DeepResearchBanner bannerType="starting" jobId="job-1" />)

    // The design rejects a confirmation step explicitly: a dialog asked after
    // the run is only ever answered yes. This guards the rejection.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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
