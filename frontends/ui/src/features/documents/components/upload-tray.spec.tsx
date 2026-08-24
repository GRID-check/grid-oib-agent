import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { UploadTray } from './upload-tray'
import type { TrackedFile } from '../types'

const tracked = (overrides: Partial<TrackedFile> = {}): TrackedFile => ({
  id: 'f1',
  fileName: 'Brandschutzkonzept.pdf',
  fileSize: 4_000_000,
  status: 'uploading',
  progress: 0,
  collectionName: 'proj-1',
  ...overrides,
})

function renderTray(files: TrackedFile[], overrides: Partial<Parameters<typeof UploadTray>[0]> = {}) {
  return render(<UploadTray files={files} onRetry={vi.fn()} {...overrides} />)
}

const track = () => screen.getByTestId('upload-tray-track')

describe('UploadTray', () => {
  it('renders nothing when there is nothing to report', () => {
    renderTray([])
    expect(screen.queryByTestId('upload-tray')).toBeNull()
  })

  describe('honest progress', () => {
    it('states a real percentage only while bytes are actually moving', () => {
      renderTray([tracked({ uploadStartedAt: 1, bytesUploaded: 1_000_000 })])

      expect(track()).toHaveAttribute('aria-valuenow', '25')
      expect(within(screen.getByTestId('upload-row')).getByText('25%')).toBeDefined()
    })

    it('omits aria-valuenow entirely while the backend reads — the ARIA form of "no position exists"', () => {
      renderTray([tracked({ status: 'ingesting' })])

      expect(track()).not.toHaveAttribute('aria-valuenow')
      expect(screen.getByText(/no time estimate/i)).toBeDefined()
    })

    it('never invents a number for a queued file', () => {
      renderTray([tracked({ status: 'uploading' })])

      const row = screen.getByTestId('upload-row')
      expect(row).toHaveAttribute('data-phase', 'queued')
      expect(within(row).getByText('Waiting')).toBeDefined()
      expect(within(row).queryByText(/%/)).toBeNull()
    })

    it('reports batch progress by bytes, so one large file cannot be masked by many small ones', () => {
      renderTray([
        tracked({ id: 'model', fileName: 'Wohnbau.ifc', fileSize: 96_000_000, uploadStartedAt: 1, bytesUploaded: 0 }),
        tracked({ id: 'a', fileName: 'a.pdf', fileSize: 2_000_000, status: 'success' }),
        tracked({ id: 'b', fileName: 'b.pdf', fileSize: 2_000_000, status: 'success' }),
      ])

      // Two of three files are done; almost none of the payload has moved.
      expect(track()).toHaveAttribute('aria-valuenow', '4')
    })
  })

  describe('what the header says', () => {
    it('names the phase in the user’s terms, not the backend’s', () => {
      const { rerender } = renderTray([tracked({ uploadStartedAt: 1 })])
      expect(screen.getByText('Uploading 1 document')).toBeDefined()

      rerender(<UploadTray files={[tracked({ status: 'ingesting' })]} onRetry={vi.fn()} />)
      expect(screen.getByText('Piloti is reading 1 document')).toBeDefined()

      rerender(<UploadTray files={[tracked({ status: 'success' })]} onRetry={vi.fn()} />)
      expect(screen.getByText('1 document added')).toBeDefined()
    })

    it('separates what landed from what did not', () => {
      renderTray([
        tracked({ id: 'a', status: 'success' }),
        tracked({ id: 'b', fileName: 'b.pdf', status: 'failed', errorMessage: 'File too large' }),
      ])

      expect(screen.getByText('1 added · 1 failed')).toBeDefined()
      expect(screen.getByText('File too large')).toBeDefined()
    })

    it('announces phase changes politely rather than reading out a byte counter', () => {
      renderTray([tracked({ uploadStartedAt: 1 })])
      expect(screen.getByText('Uploading 1 document')).toHaveAttribute('aria-live', 'polite')
    })
  })

  describe('control and recovery', () => {
    it('lets one file be abandoned without taking the batch with it', async () => {
      const onCancel = vi.fn()
      const user = userEvent.setup()
      renderTray([tracked({ uploadStartedAt: 1, bytesUploaded: 10 })], { onCancel })

      await user.click(screen.getByRole('button', { name: 'Cancel upload of Brandschutzkonzept.pdf' }))
      expect(onCancel).toHaveBeenCalledWith('f1')
    })

    it('offers no cancel for a file the backend has already taken', () => {
      renderTray([tracked({ status: 'ingesting' })], { onCancel: vi.fn() })
      expect(screen.queryByRole('button', { name: /cancel upload/i })).toBeNull()
    })

    it('retries every failure at once', async () => {
      const onRetry = vi.fn()
      const user = userEvent.setup()
      renderTray(
        [
          tracked({ id: 'a', status: 'failed', errorMessage: 'boom' }),
          tracked({ id: 'b', fileName: 'b.pdf', status: 'failed', errorMessage: 'boom' }),
          tracked({ id: 'c', fileName: 'c.pdf', status: 'success' }),
        ],
        { onRetry }
      )

      await user.click(screen.getByRole('button', { name: 'Retry failed' }))
      expect(onRetry.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
    })

    it('offers no retry-all while the batch is still running', () => {
      renderTray([tracked({ uploadStartedAt: 1 }), tracked({ id: 'b', status: 'failed' })])
      expect(screen.queryByRole('button', { name: 'Retry failed' })).toBeNull()
    })

    it('dismisses a notice without touching the document', async () => {
      const onDismiss = vi.fn()
      const user = userEvent.setup()
      renderTray([tracked({ status: 'canceled' })], { onDismiss })

      await user.click(screen.getByRole('button', { name: 'Dismiss Brandschutzkonzept.pdf' }))
      expect(onDismiss).toHaveBeenCalledWith(['f1'])
    })
  })

  describe('getting out of the way', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('retires itself once a batch has wholly succeeded', () => {
      const onDismiss = vi.fn()
      renderTray([tracked({ status: 'success' })], { onDismiss })

      vi.advanceTimersByTime(6_000)
      expect(onDismiss).toHaveBeenCalledWith(['f1'])
    })

    it('does not retire out from under a keyboard user', () => {
      const onDismiss = vi.fn()
      renderTray([tracked({ status: 'success' })], { onDismiss })

      // Focus inside the tray — the collapse control, a row's retry, anything.
      act(() => screen.getByRole('button', { name: 'Hide files' }).focus())
      act(() => vi.advanceTimersByTime(60_000))

      // Unmounting the section would drop focus to the document body.
      expect(onDismiss).not.toHaveBeenCalled()
    })

    it('retires once the tray is let go again', () => {
      const onDismiss = vi.fn()
      renderTray([tracked({ status: 'success' })], { onDismiss })

      const collapse = screen.getByRole('button', { name: 'Hide files' })
      act(() => collapse.focus())
      act(() => vi.advanceTimersByTime(60_000))
      expect(onDismiss).not.toHaveBeenCalled()

      act(() => collapse.blur())
      act(() => vi.advanceTimersByTime(6_000))
      expect(onDismiss).toHaveBeenCalledWith(['f1'])
    })

    it('stays put when something failed — an unread failure carries an action', () => {
      const onDismiss = vi.fn()
      renderTray([tracked({ id: 'a', status: 'success' }), tracked({ id: 'b', status: 'failed' })], { onDismiss })

      vi.advanceTimersByTime(60_000)
      expect(onDismiss).not.toHaveBeenCalled()
    })
  })

  it('collapses the file list without hiding the batch status', async () => {
    const user = userEvent.setup()
    renderTray([tracked({ uploadStartedAt: 1 })])

    await user.click(screen.getByRole('button', { name: 'Hide files' }))
    expect(screen.getByText('Uploading 1 document')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Show files' })).toBeDefined()
  })
})
