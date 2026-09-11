import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { ErrorBanner } from './ErrorBanner'

// Mock the error registry
vi.mock('../lib/error-registry', () => ({
  getErrorMeta: (code: string) => {
    const registry: Record<string, { title: string; defaultMessage: string; status: 'error' | 'warning' | 'info' }> = {
      'connection.failed': {
        title: 'Connection Failed',
        defaultMessage: 'Unable to connect to the server. Please check your network connection.',
        status: 'error',
      },
      'agent.response_interrupted': {
        title: 'Response Interrupted',
        defaultMessage: 'Your previous request was not completed.',
        status: 'warning',
      },
    }
    return registry[code] || {
      title: 'Error',
      defaultMessage: 'An error occurred',
      status: 'error',
    }
  },
}))

describe('ErrorBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('basic rendering', () => {
    test('renders error title from registry', () => {
      render(<ErrorBanner code="connection.failed" />)

      expect(screen.getByText('Connection Failed')).toBeInTheDocument()
    })

    test('renders default message from registry', () => {
      render(<ErrorBanner code="connection.failed" />)

      expect(screen.getByText(/unable to connect to the server/i)).toBeInTheDocument()
    })

    test('renders custom message when provided', () => {
      render(
        <ErrorBanner
          code="connection.failed"
          message="Custom error message"
        />
      )

      expect(screen.getByText('Custom error message')).toBeInTheDocument()
      expect(screen.queryByText(/unable to connect to the server/i)).not.toBeInTheDocument()
    })

    test('renders as an alert', () => {
      render(<ErrorBanner code="connection.failed" />)

      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
  })

  describe('banner status', () => {
    test('renders error status for connection errors', () => {
      render(<ErrorBanner code="connection.failed" />)

      // Banner should be visible with error status
      expect(screen.getByText('Connection Failed')).toBeInTheDocument()
    })

    test('renders warning status for interrupted responses', () => {
      render(<ErrorBanner code="agent.response_interrupted" />)

      // Banner should be visible with warning status
      expect(screen.getByText('Response Interrupted')).toBeInTheDocument()
    })
  })

  describe('timestamp', () => {
    test('displays timestamp when provided', () => {
      render(
        <ErrorBanner
          code="connection.failed"
          timestamp={new Date('2024-01-15T14:30:00')}
        />
      )

      expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
    })

    test('handles ISO string timestamp', () => {
      render(
        <ErrorBanner
          code="connection.failed"
          timestamp="2024-01-15T14:30:00Z"
        />
      )

      expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
    })

    test('does not display timestamp when not provided', () => {
      const { container } = render(<ErrorBanner code="connection.failed" />)

      // Should render but without a time string
      expect(container.textContent).not.toMatch(/\d{1,2}:\d{2}/)
    })
  })

  describe('persistent banner', () => {
    test('does not show retry button', () => {
      render(<ErrorBanner code="connection.failed" />)

      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
    })

    test('does not show dismiss button', () => {
      render(<ErrorBanner code="connection.failed" />)

      expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument()
    })
  })

  describe('expandable details', () => {
    test('shows "Show details" button when details provided', () => {
      render(
        <ErrorBanner
          code="connection.failed"
          details="Stack trace here..."
        />
      )

      expect(screen.getByText('Show details')).toBeInTheDocument()
    })

    test('expands to show details when clicked', async () => {
      const user = userEvent.setup()

      render(
        <ErrorBanner
          code="connection.failed"
          details="Error stack trace goes here"
        />
      )

      await user.click(screen.getByText('Show details'))

      expect(screen.getByText('Error stack trace goes here')).toBeInTheDocument()
      expect(screen.getByText('Hide details')).toBeInTheDocument()
    })

    test('collapses details when clicked again', async () => {
      const user = userEvent.setup()

      render(
        <ErrorBanner
          code="connection.failed"
          details="Error details"
        />
      )

      // Expand
      await user.click(screen.getByText('Show details'))
      expect(screen.getByText('Error details')).toBeInTheDocument()

      // Collapse
      await user.click(screen.getByText('Hide details'))
      expect(screen.queryByText('Error details')).not.toBeInTheDocument()
    })

    test('does not show details button when no details provided', () => {
      render(<ErrorBanner code="connection.failed" />)

      expect(screen.queryByText('Show details')).not.toBeInTheDocument()
    })
  })

  describe('accessibility', () => {
    test('details button has aria-expanded attribute', async () => {
      const user = userEvent.setup()

      render(
        <ErrorBanner
          code="connection.failed"
          details="Details here"
        />
      )

      const button = screen.getByText('Show details').closest('button')!
      expect(button).toHaveAttribute('aria-expanded', 'false')

      await user.click(button)
      expect(button).toHaveAttribute('aria-expanded', 'true')
    })

    test('details button controls the details region it discloses', async () => {
      const user = userEvent.setup()
      render(
        <ErrorBanner
          code="connection.failed"
          details="Details here"
        />
      )

      const button = screen.getByText('Show details').closest('button')!
      // The id is generated per banner (useId): two error cards in one thread
      // used to share the literal `error-details`, so both disclosure buttons
      // pointed at the first card's <pre>. The contract is the LINKAGE.
      const controlsId = button.getAttribute('aria-controls')
      expect(controlsId).toBeTruthy()

      await user.click(button)
      expect(document.getElementById(controlsId!)).toHaveTextContent('Details here')
    })
  })
})

/**
 * The support reference (ledger item 11).
 *
 * The property that matters is not that an id is drawn — it is that the id
 * drawn is a PREFIX of the id copied, and that both are the id the BFF logged.
 * A digest, or a re-formatted id, would look right and find nothing.
 */
describe('ErrorBanner — support reference', () => {
  const REQUEST_ID = '3f2a1b4c-9d8e-4f70-bc21-0a5d6e7f8091'

  test('says nothing when the failure carried no id', () => {
    render(<ErrorBanner code="connection.failed" />)

    expect(screen.queryByTestId('error-request-id')).not.toBeInTheDocument()
  })

  test('shows the short form under the support label', () => {
    render(<ErrorBanner code="connection.failed" requestId={REQUEST_ID} />)

    const reference = screen.getByTestId('error-request-id')
    expect(reference).toHaveTextContent('Support reference')
    expect(reference).toHaveTextContent('3f2a1b4c')
    // The long form is not on screen: it is what the clipboard gets.
    expect(reference).not.toHaveTextContent(REQUEST_ID)
  })

  test('copies the WHOLE id, not the eight characters it shows', async () => {
    const user = userEvent.setup()
    // AFTER `setup()`: user-event installs a clipboard stub of its own, and a
    // spy defined before it is the one that gets replaced.
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    render(<ErrorBanner code="connection.failed" requestId={REQUEST_ID} />)

    await user.click(screen.getByLabelText(`Copy reference ${REQUEST_ID}`))

    expect(writeText).toHaveBeenCalledWith(REQUEST_ID)
  })

  test('a refused clipboard leaves the id readable rather than throwing', async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    })
    render(<ErrorBanner code="connection.failed" requestId={REQUEST_ID} />)

    await user.click(screen.getByLabelText(`Copy reference ${REQUEST_ID}`))

    expect(screen.getByTestId('error-request-id')).toHaveTextContent('3f2a1b4c')
  })
})
