import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NormRegistry } from './norm-registry'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

/**
 * What these tests pin is the persistence contract as much as the chrome: the
 * whole catalog is written at once under the version we loaded, so a 409 must
 * take Save away until the user has actually seen the current registry.
 */

const WIEN = {
  id: 'bauo-wien',
  title: 'Bauordnung für Wien',
  short: 'BO Wien',
  rank: 'landesgesetz',
  bundesland: 'Wien',
  topics: ['Bewilligung'],
  relevance: 'hoch',
  application: 'LrW',
  document_number: 'LrW40009876',
  source_url: '',
  citation_url: 'https://ris.example/LrW40009876',
  full_law_url: '',
  aliases: ['Wiener Bauordnung'],
  review_note: 'Novelle 2026 einarbeiten',
  verify: { title_query: 'Bauordnung für Wien', exclude: [] },
  verified_at: '2026-05-01',
}

const OIB = {
  id: 'oib-rl2-2023',
  title: 'OIB-Richtlinie 2 — Brandschutz',
  short: 'OIB-RL 2',
  rank: 'verordnung',
  bundesland: '',
  topics: ['Brandschutz'],
  relevance: 'hoch',
  application: 'BrKons',
  document_number: 'NOR40251234',
  source_url: '',
  citation_url: 'https://ris.example/NOR40251234',
  full_law_url: '',
  aliases: [],
  verify: { title_query: 'OIB-Richtlinie 2', exclude: [] },
  verified_at: '2026-06-01',
}

const MERKBLATT = {
  id: 'ma37-fluchtwege',
  title: 'MA 37 — Merkblatt Fluchtwege',
  short: 'MA 37 FW',
  rank: 'behoerdliche_info',
  bundesland: 'Wien',
  topics: ['Fluchtwege'],
  relevance: 'mittel',
  application: '',
  document_number: '',
  source_url: 'https://www.wien.gv.at/merkblatt',
  citation_url: '',
  full_law_url: '',
  aliases: [],
  verified_at: '',
}

const ENVELOPE = {
  version: 7,
  registry: {
    version: 1,
    corpus_collection: 'oib_knowledge',
    language: 'de',
    states: { W: 'Wien' },
    corpus_note: 'Nur konsolidierte Fassungen.',
    doctrine: 'AT',
    parcel_tags: ['grundstueck'],
    entries: [WIEN, OIB, MERKBLATT],
  },
}

const VERIFY_RESULT = {
  candidates: [
    {
      title: 'Bauordnung für Wien — Fassung 2026',
      document_number: 'LrW40011223',
      citation_url: 'https://ris.example/LrW40011223',
      full_law_url: 'https://ris.example/full/LrW',
    },
  ],
  verified_at: '2026-07-28',
}

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

/** One spy routing GET / PUT / verify, so a test only states what differs. */
function stubFetch(options: { put?: { status: number; body?: unknown }; verify?: unknown } = {}) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/platform/norms/verify')) {
      return json(options.verify ?? VERIFY_RESULT)
    }
    if (init?.method === 'PUT') {
      const put = options.put ?? { status: 200, body: { version: 8 } }
      return json(put.body ?? {}, put.status)
    }
    return json(ENVELOPE)
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

// Radix leaves `pointer-events: none` on the body for a tick after a
// sheet/dialog closes; the checks would fail clicks the user can really make.
const user = () => userEvent.setup({ pointerEventsCheck: 0 })

/** Open the editing sheet for one entry via its row. */
async function openEditor(title: string) {
  await user().click(await screen.findByRole('button', { name: `Edit ${title}` }))
  return screen.findByRole('dialog')
}

const putCalls = (spy: ReturnType<typeof stubFetch>) =>
  spy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')

describe('NormRegistry', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  test('lists the catalog with rank, scope, document and verification signals', async () => {
    stubFetch()

    render(<NormRegistry />)

    expect(await screen.findByText('Bauordnung für Wien')).toBeDefined()
    expect(screen.getByText('OIB-Richtlinie 2 — Brandschutz')).toBeDefined()
    expect(screen.getByText('3 entries.', { exact: false })).toBeDefined()

    // Federal law and a state act are told apart by the scope column.
    expect(screen.getAllByText('Federal').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Wien').length).toBeGreaterThan(0)

    // RIS pointer vs. a plain source link vs. nothing at all.
    expect(screen.getByText('LrW · LrW40009876')).toBeDefined()
    expect(screen.getByText('www.wien.gv.at')).toBeDefined()

    // A missing verified_at is stale, not blank.
    expect(screen.getByText('unverified')).toBeDefined()
    expect(screen.getByText('2026-05-01')).toBeDefined()
  })

  test('surfaces a retryable error instead of a permanent skeleton', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json(ENVELOPE))
    vi.stubGlobal('fetch', spy)

    render(<NormRegistry />)

    expect(await screen.findByText('Could not load the norm catalog.')).toBeDefined()

    await user().click(screen.getByRole('button', { name: /Retry/i }))

    expect(await screen.findByText('Bauordnung für Wien')).toBeDefined()
  })

  test('filters by search and by the open-review queue', async () => {
    stubFetch()

    render(<NormRegistry />)
    await screen.findByText('Bauordnung für Wien')

    await user().type(screen.getByLabelText('Search norm entries'), 'brandschutz')

    expect(screen.getByText('OIB-Richtlinie 2 — Brandschutz')).toBeDefined()
    expect(screen.queryByText('Bauordnung für Wien')).toBeNull()

    await user().click(screen.getByRole('button', { name: 'Clear search' }))
    expect(await screen.findByText('Bauordnung für Wien')).toBeDefined()

    // The review queue survived the rebuild as a filter — count included.
    await user().click(screen.getByRole('button', { name: 'Open reviews (1)' }))
    expect(screen.getByText('Bauordnung für Wien')).toBeDefined()
    expect(screen.queryByText('OIB-Richtlinie 2 — Brandschutz')).toBeNull()
  })

  test('says so when the filters match nothing, rather than showing a blank table', async () => {
    stubFetch()

    render(<NormRegistry />)
    await screen.findByText('Bauordnung für Wien')

    await user().type(screen.getByLabelText('Search norm entries'), 'salzburg')

    expect(screen.getByText('No entry matches these filters')).toBeDefined()
  })

  test('edits an entry in the sheet and writes the whole registry under the held version', async () => {
    const spy = stubFetch()

    render(<NormRegistry />)
    const sheet = await openEditor('Bauordnung für Wien')

    const title = within(sheet).getByPlaceholderText('Full title of the norm')
    await user().clear(title)
    await user().type(title, 'Bauordnung für Wien 2026')
    await user().click(within(sheet).getByRole('button', { name: 'Apply' }))

    expect(await screen.findByText('Bauordnung für Wien 2026')).toBeDefined()

    await user().click(screen.getByRole('button', { name: 'Save registry' }))

    await waitFor(() => expect(putCalls(spy)).toHaveLength(1))
    const body = JSON.parse((putCalls(spy)[0][1] as RequestInit).body as string)
    // The held optimistic-concurrency version, not the file-format version.
    expect(body.version).toBe(7)
    expect(body.registry.version).toBe(1)
    expect(body.registry.entries).toHaveLength(3)
    expect(body.registry.entries.find((e: { id: string }) => e.id === 'bauo-wien').title).toBe(
      'Bauordnung für Wien 2026',
    )
    // Fields with no UI surface must survive the round-trip untouched.
    expect(body.registry.corpus_collection).toBe('oib_knowledge')
    expect(body.registry.states).toEqual({ W: 'Wien' })
    expect(body.registry.parcel_tags).toEqual(['grundstueck'])
  })

  test('verifies a pointer against RIS and applies the picked candidate', async () => {
    const spy = stubFetch()

    render(<NormRegistry />)
    const sheet = await openEditor('Bauordnung für Wien')

    await user().click(within(sheet).getByRole('button', { name: 'Verify' }))

    const candidate = await screen.findByRole('button', {
      name: 'Apply Bauordnung für Wien — Fassung 2026',
    })

    const verifyCall = spy.mock.calls.find(([url]) => String(url).includes('/verify'))
    expect(JSON.parse((verifyCall![1] as RequestInit).body as string)).toMatchObject({
      title_query: 'Bauordnung für Wien',
      application: 'LrW',
      bundesland: 'Wien',
    })

    await user().click(candidate)

    expect(within(sheet).getByPlaceholderText('NOR40251234')).toHaveValue('LrW40011223')
    expect(within(sheet).getByPlaceholderText('YYYY-MM-DD')).toHaveValue('2026-07-28')
    // The diff makes the overwrite reviewable before it is applied to the file.
    expect(within(sheet).getByText('Applied:')).toBeDefined()
    expect(within(sheet).getByText(/LrW40009876 → LrW40011223/)).toBeDefined()
  })

  test('a 409 blocks further saves until the current registry has been reloaded', async () => {
    const spy = stubFetch({ put: { status: 409, body: { error: 'conflict' } } })

    render(<NormRegistry />)
    const sheet = await openEditor('Bauordnung für Wien')
    await user().click(within(sheet).getByRole('button', { name: 'Apply' }))

    await user().click(screen.getByRole('button', { name: 'Save registry' }))

    expect(await screen.findByText('The catalog changed elsewhere')).toBeDefined()
    // Saving again would push a version the user has never seen.
    expect(screen.getByRole('button', { name: 'Save registry' })).toBeDisabled()

    await user().click(screen.getByRole('button', { name: /Discard and reload/ }))

    await waitFor(() => expect(screen.queryByText('The catalog changed elsewhere')).toBeNull())
    expect(await screen.findByText('Bauordnung für Wien')).toBeDefined()
    expect(putCalls(spy)).toHaveLength(1)
  })

  test('deletes an entry only after the confirmation, and only locally until saved', async () => {
    const spy = stubFetch()

    render(<NormRegistry />)
    const sheet = await openEditor('Bauordnung für Wien')
    await user().click(within(sheet).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('Delete entry?')).toBeDefined()
    await user().click(screen.getByTestId('norm-delete-confirm'))

    await waitFor(() => expect(screen.queryByText('Bauordnung für Wien')).toBeNull())
    // Nothing was written yet — the removal lives in the pending registry.
    expect(putCalls(spy)).toHaveLength(0)
  })

  test('refuses a new entry that reuses an existing ID', async () => {
    stubFetch()
    const { toast } = await import('sonner')

    render(<NormRegistry />)
    await screen.findByText('Bauordnung für Wien')
    await user().click(screen.getByRole('button', { name: 'New entry' }))

    const sheet = await screen.findByRole('dialog')
    await user().type(within(sheet).getByPlaceholderText('e.g. oib-rl2-2023'), 'bauo-wien')
    await user().type(within(sheet).getByPlaceholderText('e.g. OIB-RL 2'), 'BO W')
    await user().type(within(sheet).getByPlaceholderText('Full title of the norm'), 'Duplikat')
    await user().click(within(sheet).getByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('The ID “bauo-wien” is already taken'),
    )
    expect(screen.getByRole('dialog')).toBeDefined()
  })

  test('a 422 reports the backend detail without pretending the save went through', async () => {
    const spy = stubFetch({ put: { status: 422, body: { error: 'entry oib-rl2-2023 has no application' } } })
    const { toast } = await import('sonner')

    render(<NormRegistry />)
    const sheet = await openEditor('Bauordnung für Wien')
    await user().click(within(sheet).getByRole('button', { name: 'Apply' }))
    await user().click(screen.getByRole('button', { name: 'Save registry' }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('entry oib-rl2-2023 has no application'),
    )
    // No conflict banner — 422 is our data being wrong, not someone else's write.
    expect(screen.queryByText('The catalog changed elsewhere')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save registry' })).not.toBeDisabled()
    expect(putCalls(spy)).toHaveLength(1)
  })
})
