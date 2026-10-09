import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { toast } from 'sonner'
import { VectorMaintenance } from './vector-maintenance'
import { PlatformAccessProvider } from '@/features/platform/platform-access'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

function jsonResponse(body: unknown, ok = true, statusCode = 200) {
  return { ok, status: statusCode, json: async () => body } as Response
}

const fetchMock = vi.fn()

const trigger = () => screen.getByRole('button', { name: /reconcile orphaned vectors/i })
const confirmButton = () => screen.getByTestId('reconcile-confirm')

/** Open the confirm dialog and confirm it. */
async function runSweep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger())
  await user.click(await screen.findByTestId('reconcile-confirm'))
}

describe('VectorMaintenance', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.mocked(toast.success).mockClear()
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.warning).mockClear()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('explains what the sweep does before it has ever been run', () => {
    render(<VectorMaintenance />)

    // The "why/when" lives in the UI, not in tribal knowledge.
    expect(screen.getByText(/what reconciling does/i)).toBeInTheDocument()
    expect(screen.getByText(/when you need it/i)).toBeInTheDocument()
    expect(screen.getByText(/what it never touches/i)).toBeInTheDocument()

    expect(screen.getByTestId('reconcile-never-run')).toBeInTheDocument()
    expect(screen.queryByTestId('reconcile-result')).not.toBeInTheDocument()
  })

  test('the sweep cannot fire without an explicit confirmation', async () => {
    const user = userEvent.setup()
    render(<VectorMaintenance />)

    // Pressing the action only opens the confirm — nothing is deleted yet.
    await user.click(trigger())
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()

    // The dialog names the stakes (cross-org, irreversible) before the confirm.
    expect(screen.getByText(/across all organizations/i)).toBeInTheDocument()

    // Backing out leaves the store untouched.
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('reconcile-result')).not.toBeInTheDocument()
  })

  test('confirming POSTs to the reconcile endpoint and reports the counts as data', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        collectionsScanned: 4,
        orphansFound: 2,
        orphansDeleted: 7,
        summariesForgotten: 1,
        failures: [],
      })
    )
    const user = userEvent.setup()
    render(<VectorMaintenance />)

    await runSweep(user)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/platform/maintenance/reconcile-vectors')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' })

    // The run survives as a table, not as a toast that vanishes.
    const result = await screen.findByTestId('reconcile-result')
    const rows = within(result).getAllByRole('row')
    expect(
      within(result)
        .getByText(/collections scanned/i)
        .closest('tr')
    ).toHaveTextContent('4')
    expect(
      within(result)
        .getByText(/orphans found/i)
        .closest('tr')
    ).toHaveTextContent('2')
    expect(
      within(result)
        .getByText(/chunks removed/i)
        .closest('tr')
    ).toHaveTextContent('7')
    expect(
      within(result)
        .getByText(/inventory entries forgotten/i)
        .closest('tr')
    ).toHaveTextContent('1')
    expect(rows).toHaveLength(5) // header + four measures

    expect(
      within(result).getByText(/removed 7 orphaned chunk\(s\) across 4 collection\(s\)/i)
    ).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalled()

    // The dialog closes once the sweep settles and the action is usable again.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger()).toBeEnabled()
  })

  test('a clean store reports that nothing was orphaned', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ collectionsScanned: 3, orphansFound: 0, orphansDeleted: 0, failures: [] })
    )
    const user = userEvent.setup()
    render(<VectorMaintenance />)

    await runSweep(user)

    const result = await screen.findByTestId('reconcile-result')
    expect(within(result).getByText(/nothing to clean up/i)).toBeInTheDocument()
    expect(
      within(result)
        .getByText(/collections scanned/i)
        .closest('tr')
    ).toHaveTextContent('3')
    expect(screen.queryByTestId('reconcile-failures')).not.toBeInTheDocument()
  })

  test('collections the sweep could not reconcile are named, not just counted', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        collectionsScanned: 5,
        orphansFound: 3,
        orphansDeleted: 3,
        failures: [
          { collectionName: 'proj-hafenspeicher', error: 'list returned 503' },
          { collectionName: 'proj-schulcampus', error: 'delete returned 500' },
        ],
      })
    )
    const user = userEvent.setup()
    render(<VectorMaintenance />)

    await runSweep(user)

    const failures = await screen.findByTestId('reconcile-failures')
    expect(
      within(failures).getByText(/2 collection\(s\) could not be reconciled/i)
    ).toBeInTheDocument()
    expect(within(failures).getByText('proj-hafenspeicher')).toBeInTheDocument()
    expect(within(failures).getByText('list returned 503')).toBeInTheDocument()
    expect(within(failures).getByText('proj-schulcampus')).toBeInTheDocument()
    expect(within(failures).getByText('delete returned 500')).toBeInTheDocument()
    expect(toast.warning).toHaveBeenCalled()
  })

  test('a failed request surfaces inline and leaves the action usable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Forbidden' }, false, 403))
    const user = userEvent.setup()
    render(<VectorMaintenance />)

    await runSweep(user)

    const error = await screen.findByTestId('reconcile-error')
    expect(error).toHaveTextContent(/reconcile failed/i)
    // The client aborts at 120 s while the server may still finish the sweep, so
    // the copy must not promise that nothing was deleted.
    expect(error).not.toHaveTextContent(/nothing was deleted/i)
    expect(error).toHaveTextContent(/may still have run/i)
    expect(toast.error).toHaveBeenCalled()
    expect(screen.queryByTestId('reconcile-result')).not.toBeInTheDocument()

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger()).toBeEnabled()
  })

  test('both the action and the confirm are dead while a sweep is in flight', async () => {
    let settle: (value: Response) => void = () => {}
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve
        })
    )
    const user = userEvent.setup()
    render(<VectorMaintenance />)

    await runSweep(user)

    // The dialog stays open and locked so the sweep cannot be double-fired.
    await waitFor(() => expect(confirmButton()).toHaveAttribute('aria-disabled', 'true'))
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled()
    // Queried by test id, not role: the open dialog aria-hides the page behind it.
    expect(screen.getByTestId('reconcile-trigger')).toBeDisabled()
    expect(screen.getByTestId('reconcile-trigger')).toHaveTextContent(/reconciling/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    settle(
      jsonResponse({ collectionsScanned: 1, orphansFound: 0, orphansDeleted: 0, failures: [] })
    )

    await screen.findByTestId('reconcile-result')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('a seeded last run renders without any request (dev preview seam)', () => {
    render(
      <VectorMaintenance
        initialResult={{
          collectionsScanned: 9,
          orphansFound: 1,
          orphansDeleted: 12,
          summariesForgotten: 0,
          failures: [],
        }}
      />
    )

    expect(screen.getByTestId('reconcile-result')).toHaveTextContent('12')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('a failed run clears the previous result instead of showing it under the error', async () => {
    // Regression: the failure Alert and the PREVIOUS run's counts used to render
    // together, so the old counts read as this press's outcome.
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 502))
    const user = userEvent.setup()
    render(
      <VectorMaintenance
        initialResult={{
          collectionsScanned: 9,
          orphansFound: 1,
          orphansDeleted: 12,
          summariesForgotten: 0,
          failures: [],
        }}
      />
    )
    expect(screen.getByTestId('reconcile-result')).toBeInTheDocument()

    await runSweep(user)

    expect(await screen.findByTestId('reconcile-error')).toBeInTheDocument()
    expect(screen.queryByTestId('reconcile-result')).not.toBeInTheDocument()
  })

  test('large counts are locale-formatted', () => {
    render(
      <VectorMaintenance
        initialResult={{
          collectionsScanned: 2,
          orphansFound: 1,
          orphansDeleted: 1148,
          summariesForgotten: 0,
          failures: [],
        }}
      />
    )
    const result = screen.getByTestId('reconcile-result')
    expect(
      within(result)
        .getByText(/chunks removed/i)
        .closest('tr')
    ).toHaveTextContent('1,148')
    expect(within(result).getByText(/removed 1,148 orphaned chunk/i)).toBeInTheDocument()
  })

  test('read-only platform staff see the explanation but cannot start a sweep', () => {
    render(
      <PlatformAccessProvider permissions={[PLATFORM_PERMISSIONS.settingsView]}>
        <VectorMaintenance />
      </PlatformAccessProvider>
    )

    expect(screen.getByText(/what reconciling does/i)).toBeInTheDocument()
    expect(screen.getByTestId('reconcile-trigger')).toBeDisabled()
    expect(screen.getByTestId('reconcile-read-only')).toHaveTextContent(/only platform admins/i)
  })
})
