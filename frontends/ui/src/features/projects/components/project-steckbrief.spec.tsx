/**
 * The Steckbrief card (ADR-0083): it shows address, period and people, offers
 * only what the server allows, and sends months and nothing more.
 */
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SteckbriefView } from '@/lib/projects/steckbrief-types'
import { ProjectSteckbrief } from './project-steckbrief'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const view = (overrides: Partial<SteckbriefView> = {}): SteckbriefView => ({
  address: 'Seestadtstraße 12, 1220 Wien',
  startedOn: '2023-03',
  endedOn: '2026-10',
  people: [
    {
      id: 'person-1',
      name: 'DI Maria Huber',
      function: 'Statik',
      company: 'Huber ZT GmbH',
      startedOn: '2023-03',
      endedOn: '2025-11',
      account: null,
    },
  ],
  canEdit: true,
  canErase: true,
  ...overrides,
})

describe('ProjectSteckbrief', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    refresh.mockClear()
  })

  test('shows the address, and each person with function, company and months', () => {
    render(<ProjectSteckbrief projectId="p1" steckbrief={view()} />)
    expect(screen.getByTestId('steckbrief-address')).toHaveTextContent('Seestadtstraße 12, 1220 Wien')
    const row = screen.getByRole('row', { name: /DI Maria Huber/ })
    expect(within(row).getByText('Statik')).toBeInTheDocument()
    expect(within(row).getByText('Huber ZT GmbH')).toBeInTheDocument()
    expect(within(row).getByText('Mar 2023 – Nov 2025')).toBeInTheDocument()
  })

  test('a closed project: the period as text, nothing to add or edit, but a manager may still erase a person', () => {
    render(<ProjectSteckbrief projectId="p1" steckbrief={view({ canEdit: false, canErase: true })} />)
    expect(screen.getByTestId('steckbrief-period')).toHaveTextContent('Mar 2023 – Oct 2026')
    expect(screen.queryByRole('button', { name: 'Add person' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit DI Maria Huber' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove DI Maria Huber' })).toBeInTheDocument()
  })

  test('a reader may do nothing', () => {
    render(<ProjectSteckbrief projectId="p1" steckbrief={view({ canEdit: false, canErase: false })} />)
    expect(screen.queryByRole('button', { name: /Remove|Add|Edit/ })).not.toBeInTheDocument()
  })

  test('adds a person, sending months and no contact details', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectSteckbrief projectId="p1" steckbrief={view({ people: [] })} />)

    await userEvent.click(screen.getByRole('button', { name: 'Add person' }))
    await userEvent.type(screen.getByLabelText('Name'), 'Anna Weber')
    await userEvent.type(screen.getByLabelText('Function'), 'Projektleitung')
    await userEvent.type(screen.getByLabelText('from'), '2023-03')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p1/people',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Anna Weber',
          function: 'Projektleitung',
          company: '',
          startedOn: '2023-03',
          endedOn: null,
          userId: null,
        }),
      })
    )
    expect(refresh).toHaveBeenCalled()
  })

  test('erases a person after one confirmation', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectSteckbrief projectId="p1" steckbrief={view()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Remove DI Maria Huber' }))
    expect(fetchMock).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Remove for good' }))
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/people/person-1', expect.objectContaining({ method: 'DELETE' }))
  })

  test('refuses a period that runs backwards before sending it', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectSteckbrief projectId="p1" steckbrief={view({ startedOn: '2025-03', endedOn: '2023-03' })} />)
    expect(screen.getByText('The completion lies before the start.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save period' })).toBeDisabled()
  })
})
