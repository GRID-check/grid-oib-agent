import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { FileSourceCard } from './FileSourceCard'

// Mock useIsCurrentSessionBusy hook
const mockUseIsCurrentSessionBusy = vi.fn(() => false)
vi.mock('@/features/chat', () => ({
  useIsCurrentSessionBusy: () => mockUseIsCurrentSessionBusy(),
}))

describe('FileSourceCard', () => {
  const defaultProps = {
    id: 'file-1',
    title: 'document.pdf',
    uploadedAt: new Date('2024-01-15T14:30:00'),
    status: 'available' as const,
    onDelete: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockUseIsCurrentSessionBusy.mockReturnValue(false)
  })

  test('renders file title', () => {
    render(<FileSourceCard {...defaultProps} />)

    expect(screen.getByText('document.pdf')).toBeInTheDocument()
  })

  test('renders description when provided', () => {
    render(<FileSourceCard {...defaultProps} description="A test document" />)

    expect(screen.getByText('A test document')).toBeInTheDocument()
  })

  test('renders available status', () => {
    render(<FileSourceCard {...defaultProps} status="available" />)

    expect(screen.getByText('Available')).toBeInTheDocument()
  })

  test('renders uploading status with spinner', () => {
    render(<FileSourceCard {...defaultProps} status="uploading" />)

    // Text appears twice: visible status span + sr-only spinner label
    expect(screen.getAllByText('Uploading...').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Uploading...')).toBeInTheDocument() // Spinner
  })

  test('renders ingesting status with spinner', () => {
    render(<FileSourceCard {...defaultProps} status="ingesting" />)

    // Text appears twice: visible status span + sr-only spinner label
    expect(screen.getAllByText('Ingesting...').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Ingesting...')).toBeInTheDocument() // Spinner
  })

  test('renders error status with error message', () => {
    render(<FileSourceCard {...defaultProps} status="error" errorMessage="Upload failed" />)

    expect(screen.getByText('Error')).toBeInTheDocument()
    expect(screen.getByText('Upload failed')).toBeInTheDocument()
  })

  test('opens the preview when the row is clicked (available + onOpen)', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()

    render(<FileSourceCard {...defaultProps} status="available" onOpen={onOpen} />)

    await user.click(screen.getByRole('button', { name: /open preview: document.pdf/i }))

    expect(onOpen).toHaveBeenCalledWith('file-1')
  })

  test('does not render an open affordance while the file is still ingesting', () => {
    const onOpen = vi.fn()

    render(<FileSourceCard {...defaultProps} status="ingesting" onOpen={onOpen} />)

    expect(
      screen.queryByRole('button', { name: /open preview: document.pdf/i })
    ).not.toBeInTheDocument()
  })

  test('does not render an open affordance when onOpen is not provided', () => {
    render(<FileSourceCard {...defaultProps} status="available" />)

    expect(
      screen.queryByRole('button', { name: /open preview: document.pdf/i })
    ).not.toBeInTheDocument()
  })

  test('calls onDelete when delete button is clicked', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()

    render(<FileSourceCard {...defaultProps} onDelete={onDelete} />)

    await user.click(screen.getByRole('button', { name: /delete document.pdf/i }))

    expect(onDelete).toHaveBeenCalledWith('file-1')
  })

  test('displays formatted timestamp', () => {
    render(<FileSourceCard {...defaultProps} />)

    // Check for formatted date (month day, time format)
    expect(screen.getByText(/jan 15/i)).toBeInTheDocument()
  })

  test('handles ISO string timestamp', () => {
    render(<FileSourceCard {...defaultProps} uploadedAt="2024-01-15T14:30:00Z" />)

    expect(screen.getByText(/jan 15/i)).toBeInTheDocument()
  })

  test('renders formatted file size when provided', () => {
    render(<FileSourceCard {...defaultProps} fileSize={2048} />)

    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
  })

  test('renders MB file size correctly', () => {
    render(<FileSourceCard {...defaultProps} fileSize={5242880} />)

    expect(screen.getByText('5.0 MB')).toBeInTheDocument()
  })

  test('does not render file size when zero', () => {
    render(<FileSourceCard {...defaultProps} fileSize={0} />)

    expect(screen.queryByText('0 B')).not.toBeInTheDocument()
  })

  test('does not render file size when null', () => {
    render(<FileSourceCard {...defaultProps} fileSize={null} />)

    expect(screen.queryByText(/\d+\s*(B|KB|MB|GB)/)).not.toBeInTheDocument()
  })

  test('does not render file size when not provided', () => {
    render(<FileSourceCard {...defaultProps} />)

    expect(screen.queryByText(/\d+\s*(B|KB|MB|GB)/)).not.toBeInTheDocument()
  })
})

describe('FileSourceCard - Expiration Display', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-02-12T12:00:00Z'))
    mockUseIsCurrentSessionBusy.mockReturnValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const baseProps = {
    id: 'file-1',
    title: 'document.pdf',
    status: 'available' as const,
    onDelete: vi.fn(),
  }

  test('shows "Expires in H:MM" when file has not yet expired', () => {
    // uploaded 2 hours ago, expires in 12 hours => 10 hours remaining
    render(
      <FileSourceCard
        {...baseProps}
        uploadedAt="2025-02-12T10:00:00Z"
        expirationIntervalHours={12}
      />
    )

    expect(screen.getByText('Expires in 600 min')).toBeInTheDocument()
  })

  test('shows "Deletion Pending - Reupload" when file has expired', () => {
    // uploaded 24 hours ago, expires in 12 hours => expired 12 hours ago
    render(
      <FileSourceCard
        {...baseProps}
        uploadedAt="2025-02-11T12:00:00Z"
        expirationIntervalHours={12}
      />
    )

    expect(screen.getByText('Deletion Pending - Reupload')).toBeInTheDocument()
  })

  test('does not show expiry when expirationIntervalHours is 0', () => {
    render(
      <FileSourceCard
        {...baseProps}
        uploadedAt="2025-02-12T10:00:00Z"
        expirationIntervalHours={0}
      />
    )

    expect(screen.queryByText(/expires in/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/deletion pending/i)).not.toBeInTheDocument()
  })

  test('does not show expiry when expirationIntervalHours is not provided', () => {
    render(<FileSourceCard {...baseProps} uploadedAt="2025-02-12T10:00:00Z" />)

    expect(screen.queryByText(/expires in/i)).not.toBeInTheDocument()
  })

  test('does not show expiry when status is uploading', () => {
    render(
      <FileSourceCard
        {...baseProps}
        uploadedAt="2025-02-12T10:00:00Z"
        status="uploading"
        expirationIntervalHours={12}
      />
    )

    expect(screen.queryByText(/expires in/i)).not.toBeInTheDocument()
  })

  test('does not show expiry when status is ingesting', () => {
    render(
      <FileSourceCard
        {...baseProps}
        uploadedAt="2025-02-12T10:00:00Z"
        status="ingesting"
        expirationIntervalHours={12}
      />
    )

    expect(screen.queryByText(/expires in/i)).not.toBeInTheDocument()
  })

  test('does not show expiry when uploadedAt is not provided', () => {
    render(
      <FileSourceCard
        {...baseProps}
        expirationIntervalHours={12}
      />
    )

    expect(screen.queryByText(/expires in/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/deletion pending/i)).not.toBeInTheDocument()
  })
})

describe('FileSourceCard - Busy Session State', () => {
  const defaultProps = {
    id: 'file-1',
    title: 'document.pdf',
    uploadedAt: new Date('2024-01-15T14:30:00'),
    status: 'available' as const,
    onDelete: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('disables delete button when session is busy', () => {
    mockUseIsCurrentSessionBusy.mockReturnValue(true)

    render(<FileSourceCard {...defaultProps} />)

    const deleteButton = screen.getByRole('button', { name: /delete document.pdf/i })
    expect(deleteButton).toBeDisabled()
  })

  test('enables delete button when session is not busy', () => {
    mockUseIsCurrentSessionBusy.mockReturnValue(false)

    render(<FileSourceCard {...defaultProps} />)

    const deleteButton = screen.getByRole('button', { name: /delete document.pdf/i })
    expect(deleteButton).not.toBeDisabled()
  })

  test('has appropriate title attribute when delete button is disabled', () => {
    mockUseIsCurrentSessionBusy.mockReturnValue(true)

    render(<FileSourceCard {...defaultProps} />)

    const deleteButton = screen.getByRole('button', { name: /delete document.pdf/i })
    expect(deleteButton).toHaveAttribute('title', 'Cannot delete files during active operations')
  })

  test('does not call onDelete when button is clicked while busy', async () => {
    mockUseIsCurrentSessionBusy.mockReturnValue(true)
    const onDelete = vi.fn()

    const user = userEvent.setup()
    render(<FileSourceCard {...defaultProps} onDelete={onDelete} />)

    const deleteButton = screen.getByRole('button', { name: /delete document.pdf/i })
    await user.click(deleteButton)

    expect(onDelete).not.toHaveBeenCalled()
  })
})
