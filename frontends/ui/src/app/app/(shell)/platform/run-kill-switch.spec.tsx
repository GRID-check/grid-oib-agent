import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { toast } from 'sonner'
import { RunKillSwitch } from './run-kill-switch'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

function jsonResponse(body: unknown, ok = true, statusCode = 200) {
  return { ok, status: statusCode, json: async () => body } as Response
}

const fetchMock = vi.fn()
const trigger = () => screen.getByTestId('kill-runs-trigger')

describe('RunKillSwitch', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.mocked(toast.success).mockClear()
    vi.mocked(toast.error).mockClear()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('nothing is killed without an explicit confirmation', async () => {
    const user = userEvent.setup()
    render(<RunKillSwitch />)

    await user.click(trigger())
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/across all organizations/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /^cancel$/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('confirming POSTs the kill and leaves the counts on screen', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        jobsFound: 3,
        jobsKilled: 2,
        jobsAlreadyFinished: 1,
        runsClosed: 4,
        failures: [{ id: 'job-9', error: 'worker unreachable' }],
        truncated: false,
      }),
    )
    const user = userEvent.setup()
    render(<RunKillSwitch />)

    await user.click(trigger())
    await user.click(await screen.findByTestId('kill-runs-confirm'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/platform/maintenance/kill-runs')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' })

    const result = await screen.findByTestId('kill-runs-result')
    expect(within(result).getByText(/killed 2 job\(s\); 4 further run\(s\) closed/i)).toBeInTheDocument()
    expect(within(screen.getByTestId('kill-runs-failures')).getByText('job-9')).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalled()
  })

  test('a kill the server refused says workers may still be running', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 500))
    const user = userEvent.setup()
    render(<RunKillSwitch />)

    await user.click(trigger())
    await user.click(await screen.findByTestId('kill-runs-confirm'))

    expect(await screen.findByTestId('kill-runs-error')).toHaveTextContent(/workers may still be running/i)
    expect(screen.queryByTestId('kill-runs-result')).not.toBeInTheDocument()
    expect(toast.error).toHaveBeenCalled()
  })
})
