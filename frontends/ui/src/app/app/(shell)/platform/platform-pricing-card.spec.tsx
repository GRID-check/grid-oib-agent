import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { toast } from 'sonner'
import { PlatformAccessProvider } from '@/features/platform/platform-access'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { PlatformPricingCard, readPricingDraft } from './platform-pricing-card'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const BOUNDS = {
  marginMultiplier: { min: 0.1, max: 50 },
  usdPerCredit: { min: 0.0001, max: 100 },
  defaultCredits: { min: 0, max: 100_000_000 },
}

const version = (overrides: Record<string, unknown> = {}) => ({
  id: 'ver_2',
  marginMultiplier: 2.5,
  usdPerCredit: 0.1,
  defaultOrgDailyCredits: 500,
  defaultOrgMonthlyCredits: 5000,
  note: 'Pilot pricing',
  createdByEmail: 'owner@grid.example',
  createdAt: '2026-08-01T09:00:00Z',
  status: 'active',
  ...overrides,
})

const pricing = (overrides: Record<string, unknown> = {}) => ({
  versionId: 'ver_2',
  marginMultiplier: 2.5,
  usdPerCredit: 0.1,
  defaultOrgDailyCredits: 500,
  defaultOrgMonthlyCredits: 5000,
  explicit: true,
  note: 'Pilot pricing',
  updatedByEmail: 'owner@grid.example',
  updatedAt: '2026-08-01T09:00:00Z',
  history: [
    version(),
    version({
      id: 'ver_1',
      usdPerCredit: 0.0001,
      defaultOrgDailyCredits: null,
      defaultOrgMonthlyCredits: null,
      note: null,
      status: 'superseded',
      createdAt: '2026-07-01T09:00:00Z',
    }),
  ],
  ...overrides,
})

const json = (body: unknown, status = 200) => Response.json(body, { status })
const fetchMock = vi.fn()

const puts = () =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')

const saveThroughConfirm = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Save price list' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Save for every organization' }))
}

const retype = async (label: string, value: string) => {
  const field = screen.getByLabelText(label)
  await userEvent.clear(field)
  if (value) await userEvent.type(field, value)
}

describe('PlatformPricingCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(json({ pricing: pricing(), bounds: BOUNDS }))
  })

  test.each([
    ['Default daily allowance', 'ten'],
    ['Default monthly allowance', '12oops'],
    ['Margin multiplier', '2.5x'],
    ['Credit price', '0x10'],
  ])(
    'refuses %s = %s with a field error instead of saving it as unlimited',
    async (label, value) => {
      render(<PlatformPricingCard />)
      await screen.findByLabelText('Margin multiplier')

      await retype(label, value)

      expect(screen.getByText('Enter a number, such as 2.5.')).toBeDefined()
      expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('button', { name: 'Save price list' })).toBeDisabled()
      expect(puts()).toHaveLength(0)
    }
  )

  test('says a blank allowance is unlimited, and saves it as exactly that', async () => {
    const onSaved = vi.fn()
    fetchMock
      .mockResolvedValueOnce(json({ pricing: pricing(), bounds: BOUNDS }))
      .mockResolvedValueOnce(json({ pricing: pricing({ defaultOrgDailyCredits: null }) }))
    render(<PlatformPricingCard onSaved={onSaved} />)
    await screen.findByLabelText('Margin multiplier')

    expect(
      screen.getAllByText('For organizations without their own limit. Leave blank for unlimited.')
    ).toHaveLength(2)
    await retype('Default daily allowance', '')
    await saveThroughConfirm()

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String((puts()[0][1] as RequestInit).body))).toMatchObject({
      marginMultiplier: 2.5,
      usdPerCredit: 0.1,
      defaultOrgDailyCredits: null,
      defaultOrgMonthlyCredits: 5000,
    })
  })

  test('the rates are required: blank is an error, not a value', async () => {
    render(<PlatformPricingCard />)
    await screen.findByLabelText('Margin multiplier')

    await retype('Margin multiplier', '')

    expect(screen.getByText('Required.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Save price list' })).toBeDisabled()
  })

  test('checks the bounds the server will apply before sending anything', async () => {
    render(<PlatformPricingCard />)
    await screen.findByLabelText('Margin multiplier')

    await retype('Margin multiplier', '60')

    expect(screen.getByText('Enter a value from 0.1 to 50.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Save price list' })).toBeDisabled()
  })

  test('accepts a German comma and refuses a thousands group it cannot tell from a decimal', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ pricing: pricing(), bounds: BOUNDS }))
      .mockResolvedValueOnce(json({ pricing: pricing({ marginMultiplier: 3.5 }) }))
    render(<PlatformPricingCard />)
    await screen.findByLabelText('Margin multiplier')

    await retype('Default monthly allowance', '5,000')
    expect(
      screen.getByText(/Unclear whether that is a decimal or a thousands separator/)
    ).toBeDefined()
    await retype('Default monthly allowance', '5000')

    await retype('Margin multiplier', '3,5')
    await saveThroughConfirm()
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(JSON.parse(String((puts()[0][1] as RequestInit).body))).toMatchObject({
      marginMultiplier: 3.5,
    })
  })

  test('a save updates the card from the response instead of reloading it into a skeleton', async () => {
    const onSaved = vi.fn()
    fetchMock
      .mockResolvedValueOnce(json({ pricing: pricing(), bounds: BOUNDS }))
      .mockResolvedValueOnce(json({ pricing: pricing({ marginMultiplier: 3 }) }))
    render(<PlatformPricingCard onSaved={onSaved} />)
    await screen.findByLabelText('Margin multiplier')

    await retype('Margin multiplier', '3')
    await saveThroughConfirm()

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Price list saved. It applies from the next request.'
      )
    )
    expect(onSaved).toHaveBeenCalledTimes(1)
    // One GET (the mount) and one PUT: no second GET, and no skeleton.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('section-loading')).toBeNull()
    expect(screen.getByLabelText('Margin multiplier')).toHaveValue('3')
  })

  test('a refused save names the field in words, not the server text in the toast', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ pricing: pricing(), bounds: BOUNDS }))
      .mockResolvedValueOnce(
        json({ error: 'Invalid pricing', details: { errors: ['marginMultiplier: 0.1–50'] } }, 422)
      )
    render(<PlatformPricingCard />)
    await screen.findByLabelText('Margin multiplier')

    await retype('Margin multiplier', '3')
    await saveThroughConfirm()

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'The price list was not saved. Check the marked fields.',
        undefined
      )
    )
    expect(screen.getByLabelText('Margin multiplier')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Enter a value from 0.1 to 50.')).toBeDefined()
  })

  test('shows the worked example as a note, recomputed from the draft', async () => {
    render(<PlatformPricingCard />)
    const example = await screen.findByTestId('pricing-example')

    expect(example).toHaveAttribute('role', 'note')
    expect(example).toHaveTextContent(
      'A call OpenRouter charges $0.04 for is priced at $0.10 and shows as 1 credit.'
    )
    await retype('Margin multiplier', '5')
    expect(example).toHaveTextContent('is priced at $0.20 and shows as 2 credits.')
  })

  test('lists the versions as a table, with words for unlimited and a credit price to four places', async () => {
    render(<PlatformPricingCard />)
    const history = within(await screen.findByTestId('pricing-history'))

    expect(history.getByText('Current')).toBeDefined()
    expect(history.getByText('$0.0001')).toBeDefined()
    expect(history.getAllByText(/Unlimited \/ Unlimited/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/∞/)).toBeNull()
  })

  test('read-only staff see the price list without a Save that would answer 403', async () => {
    render(
      <PlatformAccessProvider permissions={[PLATFORM_PERMISSIONS.settingsView]}>
        <PlatformPricingCard />
      </PlatformAccessProvider>
    )
    await screen.findByLabelText('Margin multiplier')

    expect(screen.queryByRole('button', { name: 'Save price list' })).toBeNull()
    expect(screen.queryByLabelText('Change note')).toBeNull()
    expect(screen.getByLabelText('Margin multiplier')).toHaveAttribute('readonly')
    expect(screen.getByTestId('pricing-read-only')).toHaveTextContent(
      'needs the platform settings permission'
    )
  })
})

describe('readPricingDraft', () => {
  const inputs = {
    marginMultiplier: '2,5',
    usdPerCredit: '0.1',
    defaultOrgDailyCredits: '',
    defaultOrgMonthlyCredits: '5000',
  }

  test('reads both separators and keeps blank allowances as null', () => {
    expect(readPricingDraft(inputs, BOUNDS, 'de')).toEqual({
      values: {
        marginMultiplier: 2.5,
        usdPerCredit: 0.1,
        defaultOrgDailyCredits: null,
        defaultOrgMonthlyCredits: 5000,
      },
      problems: {},
    })
  })

  test('never turns an unreadable allowance into null', () => {
    const draft = readPricingDraft({ ...inputs, defaultOrgDailyCredits: 'ten' }, BOUNDS, 'en')
    expect(draft.problems.defaultOrgDailyCredits).toEqual({ key: 'numberField.notANumber' })
  })
})
