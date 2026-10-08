import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PlatformAccessProvider } from '@/features/platform/platform-access'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { applyLessonUpdate, PlatformLessons } from './platform-lessons'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const json = (body: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: async () => body }) as Response

const lesson = (id: string, status: 'candidate' | 'active' | 'retired') => ({
  id,
  content: `Lesson ${id}`,
  category: 'inaccurate' as const,
  status,
  heldReason: null,
  reportCount: 2,
  orgCount: 1,
  lastReportedAt: '2026-08-20T09:00:00Z',
  retiredReason: null,
  rootCauseStatus: 'open' as const,
  rootCauseNote: null,
})

const OVERVIEW = {
  lessons: [lesson('a', 'candidate'), lesson('b', 'active')],
  counts: { candidate: 1, active: 1, retired: 0 },
}

const fetchMock = vi.fn()
const listCalls = (): number =>
  fetchMock.mock.calls.filter(([url, init]) => url === '/api/platform/lessons' && !init?.method)
    .length

describe('PlatformLessons', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const id = url.split('/').pop() ?? ''
        const base = OVERVIEW.lessons.find((row) => row.id === id)
        return json({ lesson: { ...base, ...JSON.parse(String(init.body)) } })
      }
      return json(OVERVIEW)
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  test('activating updates the row in place, without reloading the register into skeletons', async () => {
    render(<PlatformLessons />)
    const row = await screen.findByTestId('lesson-a')
    await userEvent.click(within(row).getByRole('button', { name: 'Activate' }))

    // Moved into the active group, with focus following it there.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('lesson-a')).getByRole('button', { name: 'Retire' })
      ).toBeInTheDocument()
    )
    expect(document.activeElement).toBe(screen.getByTestId('lesson-a'))
    expect(screen.queryByTestId('section-loading')).toBeNull()
    expect(listCalls()).toBe(1)
  })

  test('a failed retire keeps the confirm open', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'PATCH' ? json({}, 500) : json(OVERVIEW)
    )
    render(<PlatformLessons />)
    const row = await screen.findByTestId('lesson-b')
    await userEvent.click(within(row).getByRole('button', { name: 'Retire' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retire' }))

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true)
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  test('read-only staff can open the history but not change a lesson', async () => {
    render(
      <PlatformAccessProvider permissions={[PLATFORM_PERMISSIONS.settingsView]}>
        <PlatformLessons />
      </PlatformAccessProvider>
    )
    const row = await screen.findByTestId('lesson-a')
    expect(within(row).queryByRole('button', { name: 'Activate' })).toBeNull()
    expect(within(row).getByRole('button', { name: /Trail/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Process backlog/ })).toBeNull()
  })
})

describe('applyLessonUpdate', () => {
  test('moves one unit between the status counts', () => {
    const next = applyLessonUpdate(OVERVIEW, { ...lesson('a', 'active') })
    expect(next.counts).toEqual({ candidate: 0, active: 2, retired: 0 })
    expect(next.lessons.find((row) => row.id === 'a')?.status).toBe('active')
  })
})
