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
        filedDocument={{ documentId: 'doc-9', filename: 'fluchtweglangen-gk-4-2026-08-20.pdf' }}
      />
    )

    expect(screen.getByText('Filed in the project: fluchtweglangen-gk-4-2026-08-20.pdf')).toBeInTheDocument()
    // The one deep-link shape the Files feature already uses — never a second one.
    expect(screen.getByRole('link', { name: 'Open in project' })).toHaveAttribute(
      'href',
      '/app/projects/proj-1/files?doc=doc-9'
    )
  })

  test('claims no file when the run was not filed', () => {
    enterProject('proj-1')

    render(<DeepResearchBanner bannerType="success" jobId="job-1" />)

    // Nothing was filed and nothing was promised — an older run, or one whose
    // report route never attempted a write. Saying nothing is the requirement;
    // a "maybe" or a dead link would be worse than silence. This is NOT the
    // failed-filing case: that one arrives as `filingFailed` below.
    expect(screen.queryByText(/Filed in the project/)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open in project' })).not.toBeInTheDocument()
    expect(screen.queryByText(/could not be filed/)).not.toBeInTheDocument()
  })

  test('takes the filing promise back when it was made and broken', () => {
    enterProject('proj-1')

    render(<DeepResearchBanner bannerType="success" jobId="job-1" filingFailed />)

    // The starting banner printed „wird abgelegt" for this run. Saying nothing
    // now does not spare the reader the failure — it sends them to Berichte to
    // discover it alone, with the only record in a server log they cannot read.
    expect(
      screen.getByText('The report could not be filed under “Berichte”.')
    ).toBeInTheDocument()
    // Still no file claimed, and no action offered to open one.
    expect(screen.queryByRole('link', { name: 'Open in project' })).not.toBeInTheDocument()
  })

  test('takes it back in the register the promise was made in', () => {
    enterProject('proj-1')

    render(<DeepResearchBanner bannerType="success" jobId="job-1" filingFailed />)

    // A muted line, not an alarm. The RESEARCH succeeded — the run is not in
    // error — and chroma in this product belongs to provenance
    // (`docs/design/grid-design-language.md`), so the banner keeps its `success`
    // variant and the retraction carries the same `text-subtle text-xs` as the
    // disclosure it retracts.
    expect(screen.getByTestId('research-filing-failed')).toHaveClass('text-subtle', 'text-xs')

    const alert = screen.getByRole('alert')
    expect(alert).toHaveClass('bg-success-subtle')
    // Not a warning and not an error: neither the amber nor the red may be
    // reached for by a filing that failed under a run that did not.
    expect(alert).not.toHaveClass('bg-warning-subtle')
    expect(alert).not.toHaveClass('text-destructive')
  })

  test('says nothing about a failed filing outside a project, where nothing was promised', () => {
    render(<DeepResearchBanner bannerType="success" jobId="job-1" filingFailed />)

    // Mirrors the disclosure exactly: no project, no line was ever printed, so
    // there is nothing to take back. A retraction of a promise the reader never
    // saw is a new claim, not a correction.
    expect(screen.queryByText(/could not be filed/)).not.toBeInTheDocument()
  })

  test('names the file rather than denying it when both arrive', () => {
    enterProject('proj-1')

    render(
      <DeepResearchBanner
        bannerType="success"
        jobId="job-1"
        filedDocument={{ documentId: 'doc-9', filename: 'fluchtweglangen-gk-4-2026-08-20.pdf' }}
        filingFailed
      />
    )

    // A document that exists outranks a later attempt that failed. One banner
    // denying and naming the same file is the one dishonesty worse than silence.
    expect(screen.getByText('Filed in the project: fluchtweglangen-gk-4-2026-08-20.pdf')).toBeInTheDocument()
    expect(screen.queryByText(/could not be filed/)).not.toBeInTheDocument()
  })

  test('says nothing about a failed filing on a banner that made no promise', () => {
    enterProject('proj-1')

    // The disclosure renders on `starting` only, and a failed filing can only
    // follow a finished run — so no other banner type may carry the retraction.
    render(<DeepResearchBanner bannerType="failure" jobId="job-1" filingFailed />)

    expect(screen.queryByText(/could not be filed/)).not.toBeInTheDocument()
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
