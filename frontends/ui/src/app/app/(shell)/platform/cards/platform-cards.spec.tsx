import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PlatformCards } from './platform-cards'

function jsonResponse(body: unknown, ok = true, statusCode = 200) {
  return { ok, status: statusCode, json: async () => body } as Response
}

const fetchMock = vi.fn()

const FEATURE_REQUEST = {
  repository: 'https://github.com/GRID-check/grid-oib-agent',
  url: 'https://github.com/GRID-check/grid-oib-agent/issues/new?template=02-enhancement.yml',
  label: 'Missing a card, or a value on one? Open a feature request.',
}

const catalog = {
  cardCount: 3,
  buildingBlocks: {},
  featureRequest: FEATURE_REQUEST,
  cards: [
    {
      type: 'parking_requirement',
      model: 'ParkingRequirementCard',
      summary: 'A parking-provision card: required vs provided count.',
      emittedBy: 'agent',
      interaction: 'presentational',
      fields: [
        {
          name: 'car_spaces',
          type: 'DimensionCheck',
          required: true,
          description: 'Provided vs required Kfz-Stellplätze',
          constraints: [],
        },
        { name: 'basis', type: 'string', required: false, description: 'How it is derived', constraints: [] },
      ],
    },
    {
      type: 'memory_proposal',
      model: 'MemoryProposalCard',
      summary: 'A proposal to save a finding to long-term memory.',
      emittedBy: 'system',
      interaction: 'interactive',
      fields: [],
    },
    {
      type: 'ifc_viewer',
      model: 'IfcViewerCard',
      summary: 'The project model in 3D with findings highlighted.',
      emittedBy: 'agent',
      interaction: 'presentational',
      fields: [],
    },
  ],
}

describe('PlatformCards', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(jsonResponse(catalog))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('renders each catalogued card as an actual card, not a description of one', async () => {
    render(<PlatformCards />)

    const entry = await screen.findByTestId('platform-card-parking_requirement')
    // The real renderer ran: the fixture's title is on screen, which no amount
    // of catalog metadata would produce on its own.
    expect(within(entry).getByText(/Stellplatznachweis/)).toBeInTheDocument()
    expect(within(entry).getByText('parking_requirement')).toBeInTheDocument()
  })

  test('a card that needs real data is described, not faked', async () => {
    render(<PlatformCards />)

    const entry = await screen.findByTestId('platform-card-ifc_viewer')
    expect(within(entry).getByText(/loaded IFC model/i)).toBeInTheDocument()
  })

  test('previews cannot be operated — an interactive card is inert here', async () => {
    render(<PlatformCards />)

    const entry = await screen.findByTestId('platform-card-memory_proposal')
    // memory_proposal's "Yes" writes an org-scoped memory. In a gallery that
    // button is decoration, so the subtree is removed from hit-testing, focus
    // order and the a11y tree entirely.
    await waitFor(() => {
      const preview = entry.querySelector('.pointer-events-none')
      expect(preview).not.toBeNull()
      expect((preview as HTMLElement).inert).toBe(true)
    })
  })

  test('marks what the card is: system-emitted, or asking the user to decide', async () => {
    render(<PlatformCards />)

    const interactive = await screen.findByTestId('platform-card-memory_proposal')
    expect(within(interactive).getByText(/asks the user/i)).toBeInTheDocument()
    expect(within(interactive).getByText(/system-emitted/i)).toBeInTheDocument()

    const plain = screen.getByTestId('platform-card-parking_requirement')
    expect(within(plain).queryByText(/asks the user/i)).not.toBeInTheDocument()
  })

  test('the values a card carries are one click away, with requiredness and type', async () => {
    const user = userEvent.setup()
    render(<PlatformCards />)

    const entry = await screen.findByTestId('platform-card-parking_requirement')
    await user.click(within(entry).getByRole('button', { name: /show values \(2\)/i }))

    expect(within(entry).getByText('car_spaces')).toBeInTheDocument()
    expect(within(entry).getByText('DimensionCheck')).toBeInTheDocument()
    expect(within(entry).getByText(/Provided vs required/)).toBeInTheDocument()
  })

  test('always offers somewhere to ask for what is missing', async () => {
    render(<PlatformCards />)

    await screen.findByTestId('platform-card-parking_requirement')
    const links = screen.getAllByRole('link', { name: /request a card/i })
    // Header and foot: the reader who scrolled every card without finding
    // theirs is exactly the one with a request to file.
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(link).toHaveAttribute('href', FEATURE_REQUEST.url)
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    }
  })

  test('a backend outage says so and offers a retry, rather than an empty gallery', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, false, 502))
    render(<PlatformCards />)

    expect(await screen.findByText(/could not load the card catalog/i)).toBeInTheDocument()
    expect(screen.queryByTestId('platform-card-parking_requirement')).not.toBeInTheDocument()

    fetchMock.mockResolvedValueOnce(jsonResponse(catalog))
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(await screen.findByTestId('platform-card-parking_requirement')).toBeInTheDocument()
  })
})
