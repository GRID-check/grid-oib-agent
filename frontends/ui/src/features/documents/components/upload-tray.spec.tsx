import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { UploadTray } from './upload-tray'

const requestQuarantineRelease = vi.fn(async (_documentId: string) => ({ notified: 1 }))
vi.mock('@/adapters/api/upload-screening-client', () => ({
  requestQuarantineRelease: (documentId: string) => requestQuarantineRelease(documentId),
}))
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

    it('says „unchanged – already here" when the server already held these bytes', () => {
      renderTray([tracked({ status: 'success', unchanged: true, bytesUploaded: 4_000_000 })])

      const row = screen.getByTestId('upload-row')
      expect(within(row).getByTestId('upload-row-unchanged')).toHaveTextContent('Unchanged – already here')
      expect(within(row).queryByText('Citable')).toBeNull()
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

    it('says a read failure in words, with the stored text behind Details', async () => {
      const user = userEvent.setup()
      renderTray([
        tracked({
          status: 'failed',
          serverFileId: 'doc-1',
          errorMessage: 'interrupted: ingestion stopped when the service restarted; retry to index this file',
        }),
      ])

      expect(screen.getByText('Reading stopped when the service restarted. Read it again to finish.')).toBeDefined()
      expect(screen.queryByText(/^interrupted:/)).toBeNull()
      await user.click(screen.getByRole('button', { name: 'Details' }))
      expect(screen.getByTestId('upload-row-failure-raw')).toHaveTextContent(/^interrupted: ingestion stopped/)
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

  describe('on a phone', () => {
    it('cuts a long name in the middle so its revision and extension survive', () => {
      const name = '2026-06-14_Lageplan_Baufeld_Nord_Rev_C_Freigabe.pdf'
      renderTray([tracked({ fileName: name, uploadStartedAt: 1, bytesUploaded: 10 })])

      const label = within(screen.getByTestId('upload-row-name'))
      // The end is a span of its own that never shrinks; the head is the part CSS ellipsizes.
      // Both are drawn for the eye; the whole name is read once.
      const [head, tail] = Array.from(label.getByTitle(name).querySelectorAll('[aria-hidden="true"]'))
      expect(tail.textContent).toMatch(/Rev_C_Freigabe\.pdf$/)
      expect(head.textContent).toMatch(/^2026-06-14_Lageplan/)
      expect(label.getByText(name)).toHaveClass('sr-only')
    })

    it('puts a labelled retry under a failed file, where a finger can find it', async () => {
      const onRetry = vi.fn()
      const user = userEvent.setup()
      renderTray([tracked({ status: 'failed', errorMessage: 'Connection lost' })], { onRetry })

      await user.click(screen.getByTestId('upload-row-retry'))
      expect(onRetry).toHaveBeenCalledWith('f1')
      expect(screen.getByTestId('upload-row-retry')).toHaveTextContent('Try again')
    })

    it('shows the labelled retry even when the failure came without a reason', () => {
      renderTray([tracked({ status: 'failed' })])
      expect(screen.getByTestId('upload-row-retry')).toBeDefined()
    })

    it('offers no labelled retry for a failure a retry would only repeat', () => {
      renderTray([tracked({ status: 'failed', errorMessage: 'refused', retryable: false })])
      expect(screen.queryByTestId('upload-row-retry')).toBeNull()
    })

    it('carries the size on the status line of a file that is still moving', () => {
      renderTray([tracked({ fileSize: 4_800_000, uploadStartedAt: 1, bytesUploaded: 1_200_000 })])
      expect(screen.getByTestId('upload-row')).toHaveTextContent(/25%\s*·\s*4[.,]8 MB/)
    })
  })

  describe('without a connection', () => {
    const setOnline = (value: boolean) => {
      Object.defineProperty(window.navigator, 'onLine', { value, configurable: true })
    }
    afterEach(() => setOnline(true))

    it('says so instead of claiming progress, and recovers when the link returns', () => {
      renderTray([tracked({ uploadStartedAt: 1, bytesUploaded: 1_000_000 })])
      expect(screen.queryByText(/no connection/i)).toBeNull()

      act(() => {
        setOnline(false)
        window.dispatchEvent(new Event('offline'))
      })
      expect(screen.getByText(/no connection/i)).toBeDefined()
      expect(screen.getByTestId('upload-tray-glyph')).toHaveAttribute('data-tone', 'offline')

      act(() => {
        setOnline(true)
        window.dispatchEvent(new Event('online'))
      })
      expect(screen.queryByText(/no connection/i)).toBeNull()
    })

    it('stays quiet when nothing is being sent', () => {
      setOnline(false)
      renderTray([tracked({ status: 'success' })])
      expect(screen.queryByText(/no connection/i)).toBeNull()
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

    it('still retires when the parent keeps re-rendering the same settled batch', () => {
      // A poll or a store write hands a new array (and so a new dismiss) every
      // few seconds; the timer used to restart on each one and never fire.
      const onDismiss = vi.fn()
      const { rerender } = renderTray([tracked({ status: 'success' })], { onDismiss })

      for (let second = 0; second < 6; second++) {
        act(() => vi.advanceTimersByTime(1_000))
        rerender(<UploadTray files={[tracked({ status: 'success' })]} onRetry={vi.fn()} onDismiss={(ids) => onDismiss(ids)} />)
      }

      expect(onDismiss).toHaveBeenCalledWith(['f1'])
    })

    it('retires the next clean batch after one dismissed from under the pointer', async () => {
      const onDismiss = vi.fn()
      const { rerender } = renderTray([tracked({ status: 'failed', errorMessage: 'boom' })], { onDismiss })
      const tray = screen.getByTestId('upload-tray')

      // Pointer in, „Dismiss“ pressed: the tray empties while it is held.
      act(() => {
        tray.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      })
      rerender(<UploadTray files={[]} onRetry={vi.fn()} onDismiss={onDismiss} />)
      act(() => vi.advanceTimersByTime(1_000))

      rerender(<UploadTray files={[tracked({ id: 'next', status: 'success' })]} onRetry={vi.fn()} onDismiss={onDismiss} />)
      act(() => vi.advanceTimersByTime(6_000))
      expect(onDismiss).toHaveBeenCalledWith(['next'])
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

  describe('a file the content check held back (ADR-0086)', () => {
    const VERDICT = 'quarantined:{"reasons":[{"kind":"term","term":"Lohnzettel","pages":[2]}],"checked":"full"}'
    const held = (overrides: Partial<TrackedFile> = {}) =>
      tracked({ id: 'h', fileName: 'Lohnzettel_03.pdf', status: 'held', serverFileId: 'doc-h', errorMessage: VERDICT, ...overrides })

    it('says held back, in the warning colour, with what was found — never failed', () => {
      renderTray([held()])

      const row = screen.getByTestId('upload-row')
      expect(row).toHaveAttribute('data-phase', 'held')
      const label = within(row).getByText('Held back')
      expect(label.closest('.text-warning')).not.toBeNull()
      expect(within(row).queryByText('Failed')).toBeNull()
      expect(within(screen.getByTestId('upload-row-held')).getByText(/Lohnzettel/)).toBeDefined()
      // The tray cannot show the document, so the pages are words, not buttons.
      expect(screen.queryByTestId('upload-row-held-page-2')).toBeNull()
      expect(screen.queryByText(/^quarantined:/)).toBeNull()
    })

    it('lets the uploader ask for a review from the row', async () => {
      const user = userEvent.setup()
      renderTray([held()])

      await user.click(screen.getByTestId('upload-row-request-review'))
      expect(requestQuarantineRelease).toHaveBeenCalledWith('doc-h')
    })

    it('is not retried by „Retry failed", and has no retry of its own', async () => {
      const onRetry = vi.fn()
      const user = userEvent.setup()
      renderTray([held(), tracked({ id: 'f', fileName: 'b.pdf', status: 'failed', errorMessage: 'boom' })], { onRetry })

      await user.click(screen.getByRole('button', { name: 'Retry failed' }))
      expect(onRetry.mock.calls.map(([id]) => id)).toEqual(['f'])
      const heldRow = screen.getAllByTestId('upload-row').find((row) => row.getAttribute('data-phase') === 'held')!
      expect(within(heldRow).queryByRole('button', { name: 'Retry' })).toBeNull()
    })

    it('offers no retry for a failure a retry would only repeat', () => {
      // The quarantined-replace 409: uploading again gets the same refusal.
      renderTray([
        tracked({ id: 'r', fileName: 'r.pdf', status: 'failed', errorMessage: 'refused', retryable: false }),
        tracked({ id: 'ok', fileName: 'ok.pdf', status: 'success' }),
      ])
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Retry failed' })).toBeNull()
    })

    it('offers no „Retry failed" when nothing but a held file is left', () => {
      renderTray([held(), tracked({ id: 'ok', fileName: 'ok.pdf', status: 'success' })])
      expect(screen.queryByRole('button', { name: 'Retry failed' })).toBeNull()
    })

    describe('a file refused because the document it would replace is held', () => {
      const SENTENCE =
        '“Lohnzettel_03.pdf” would replace a file that is held back and waits in quarantine for review. Once someone allows it through or deletes it, you can upload the new one.'
      const replacing = (ownUpload: boolean) =>
        held({
          serverFileId: undefined,
          errorMessage: SENTENCE,
          retryable: false,
          replacesHeld: { documentId: 'doc-earlier', ownUpload },
        })

      it('says its own sentence, not that a reason was not stored', () => {
        renderTray([replacing(true)])

        const row = screen.getByTestId('upload-row')
        expect(row).toHaveAttribute('data-phase', 'held')
        expect(screen.getByTestId('upload-row-held-replaces')).toHaveTextContent(SENTENCE)
        expect(within(row).queryByText(/not stored or cannot be read/)).toBeNull()
        expect(within(row).queryByText('Failed')).toBeNull()
      })

      it('lets the uploader of the held file ask for its review from the row', async () => {
        const user = userEvent.setup()
        renderTray([replacing(true)])

        await user.click(screen.getByTestId('upload-row-request-review'))
        expect(requestQuarantineRelease).toHaveBeenCalledWith('doc-earlier')
      })

      it('offers no request to someone who did not upload the held file (a reviewer decides it)', () => {
        renderTray([replacing(false)])
        expect(screen.queryByTestId('upload-row-request-review')).toBeNull()
      })
    })

    it('can be dismissed from the tray', async () => {
      const onDismiss = vi.fn()
      const user = userEvent.setup()
      renderTray([held()], { onDismiss })

      await user.click(screen.getByRole('button', { name: 'Dismiss Lohnzettel_03.pdf' }))
      expect(onDismiss).toHaveBeenCalledWith(['h'])
    })

    it('heads the batch with what was held, and marks it with a warning, not a check', () => {
      const { rerender } = renderTray([held()])
      expect(screen.getByText('1 document held back')).toBeDefined()
      expect(screen.getByTestId('upload-tray-glyph')).toHaveAttribute('data-tone', 'warning')

      rerender(<UploadTray files={[held(), tracked({ id: 'ok', fileName: 'ok.pdf', status: 'success' })]} onRetry={vi.fn()} />)
      expect(screen.getByText('1 added · 1 held back')).toBeDefined()

      rerender(
        <UploadTray
          files={[held(), tracked({ id: 'f', fileName: 'b.pdf', status: 'failed', errorMessage: 'boom' })]}
          onRetry={vi.fn()}
        />
      )
      expect(screen.getByTestId('upload-tray-glyph')).toHaveAttribute('data-tone', 'destructive')
    })

    describe('the batch', () => {
      beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
      })

      afterEach(() => {
        vi.useRealTimers()
      })

      it('does not retire itself while anything is held', () => {
        const onDismiss = vi.fn()
        renderTray([tracked({ id: 'ok', status: 'success' }), held()], { onDismiss })

        vi.advanceTimersByTime(60_000)
        expect(onDismiss).not.toHaveBeenCalled()
      })
    })
  })

  describe('a file stored and not read', () => {
    it('says filed, muted, and never citable', () => {
      renderTray([tracked({ status: 'stored', serverFileId: 'doc-s' })])

      const row = screen.getByTestId('upload-row')
      expect(row).toHaveAttribute('data-phase', 'stored')
      const label = within(row).getByText('Filed')
      expect(label.closest('.text-muted-foreground')).not.toBeNull()
      expect(within(row).queryByText('Citable')).toBeNull()
      expect(screen.getByText('1 document added')).toBeDefined()
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
