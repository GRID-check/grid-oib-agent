import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { VectorMaintenance } from './vector-maintenance'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

function jsonResponse(body: unknown, ok = true, statusCode = 200) {
  return { ok, status: statusCode, json: async () => body } as Response
}

const fetchMock = vi.fn()

describe('VectorMaintenance', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('confirming the sweep POSTs to the reconcile endpoint and shows the result', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ collectionsScanned: 4, orphansFound: 2, orphansDeleted: 7, failures: [] }),
    )
    const user = userEvent.setup()
    render(<VectorMaintenance />)

    // Opens a confirm dialog rather than firing immediately (destructive action).
    await user.click(screen.getByRole('button', { name: /reconcile orphaned vectors/i }))
    expect(fetchMock).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /run reconcile/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/platform/maintenance/reconcile-vectors')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' })

    // The run summary is surfaced inline.
    await waitFor(() => expect(screen.getByTestId('reconcile-result')).toHaveTextContent(/7/))
  })

  test('a clean store reports that nothing was orphaned', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ collectionsScanned: 3, orphansFound: 0, orphansDeleted: 0, failures: [] }),
    )
    const user = userEvent.setup()
    render(<VectorMaintenance />)

    await user.click(screen.getByRole('button', { name: /reconcile orphaned vectors/i }))
    await user.click(screen.getByRole('button', { name: /run reconcile/i }))

    await waitFor(() =>
      expect(screen.getByTestId('reconcile-result')).toHaveTextContent(/no orphaned vectors/i),
    )
  })
})
