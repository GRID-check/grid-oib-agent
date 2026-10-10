/**
 * The closing debrief (docs/roadmap/office-experience.md, step 3): what a
 * project leaves the office, asked in the close dialog while its memory can
 * still be written. It names the open facts of the fingerprint the ranking
 * reads, offers only the memory other projects search (active decisions and
 * constraints), confirms one so other projects cite it as a person's, records a
 * lesson as a decision, and offers none of that to a reader who may not write
 * the memory.
 *
 * It also shows what the closing extraction read from the documents
 * (docs/design/closed-project-experience.md): the suggested facts, with their
 * evidence, which a person accepts or leaves open, and the source-grounded
 * decisions, which a person confirms or dismisses.
 */
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@/test-utils'
import { makeMemoryItem } from '@/test-utils/db-fixtures'
import { buildIntakeProfile, projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import type { ProjectAssumption, ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'
import { ClosingDebrief } from './closing-debrief'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }))

const wire = (overrides: Parameters<typeof makeMemoryItem>[0]) => ({
  ...makeMemoryItem(overrides),
  createdAt: '2026-10-01T09:00:00Z',
  updatedAt: '2026-10-02T09:00:00Z',
  lastReferencedAt: null,
})

// Built by the intake's own producer, so the debrief is tested on the shape
// production stores (a building's answers under `@bw1`).
const built = (answers: Record<string, ProjectPrimitiveValue>) =>
  buildIntakeProfile(answers, projectIntakeDefinitionV1, { bauwerke: [{ id: 'bw1', name: 'Bauwerk 1' }] })

const profile: ProjectProfile = built({
  A2_country: 'at',
  A2_land: 'niederoesterreich',
  'C1@bw1': 'gebaeude',
  'C10@bw1': ['holzbau'],
})

/** A value the closing extraction read from a document, as the profile stores it. */
const suggestion = (value: ProjectPrimitiveValue, reason: string): ProjectAssumption => ({
  value,
  status: 'unconfirmed',
  reason,
  source: 'agent_suggested',
  updatedAt: '2026-10-07T09:00:00Z',
})

const memory = [
  wire({ id: 'd1', kind: 'decision', content: 'Kapselung K₂60 mit Gipsfaserplatten, Prüfbericht liegt vor.' }),
  wire({ id: 'c1', kind: 'constraint', content: 'Die Behörde verlangt die Fluchtwegbreite in jedem Grundriss.', pinned: true }),
  wire({ id: 'f1', kind: 'derived_fact', content: 'Die Dachlast beträgt 2 kN/m².' }),
  wire({ id: 'old', kind: 'decision', content: 'Verworfene Variante mit Stahlbeton.', status: 'superseded' }),
]

const drafted = wire({
  id: 'g1',
  kind: 'decision',
  content: 'Fluchttreppe außen in Stahl statt eines zweiten Stiegenhauses.',
  verification: 'source_grounded',
  provenanceType: 'distillation',
  evidence: [{ fileName: 'Bescheid.pdf', page: '3' }],
})

const EXTRACTED = { suggested: 3, drafted: 4, documentsRead: ['Baubeschreibung.pdf', 'Bescheid.pdf'], error: null }

interface StubOptions {
  memory?: ReturnType<typeof wire>[]
  experience?: () => Promise<Response>
}

function stubFetch({ memory: items = memory, experience }: StubOptions = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/experience')) return experience ? experience() : Response.json(EXTRACTED)
    if (url.endsWith('/profile/patches')) return Response.json({ profile })
    if (init?.method === 'PATCH') {
      const id = url.split('/').pop()
      const found = items.find((entry) => entry.id === id) ?? items[0]
      return Response.json({ item: { ...found, ...(JSON.parse(String(init.body)) as object) } })
    }
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { kind: string; content: string }
      return Response.json({ item: wire({ id: 'new', kind: 'decision', content: body.content, provenanceType: 'user' }) }, { status: 201 })
    }
    return Response.json({ items })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const memoryGets = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([url, init]) => url === '/api/projects/p1/memory' && !init?.method).length

describe('ClosingDebrief', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    refresh.mockClear()
  })

  test('shows the fingerprint, naming each open fact and how many are missing', async () => {
    stubFetch()
    render(<ClosingDebrief projectId="p1" profile={profile} startedOn={null} canWriteMemory />)

    const debrief = screen.getByTestId('closing-debrief')
    expect(within(debrief).getByText('Niederösterreich')).toBeInTheDocument()
    expect(within(debrief).getByText('Holzbau')).toBeInTheDocument()
    // Uses and kind of work are open in the briefing; the class is derived, not
    // the briefing's to fill; the period is open too: three missing.
    expect(within(debrief).getAllByText('open')).toHaveLength(2)
    expect(within(debrief).getByText('open (not set in the brief)')).toBeInTheDocument()
    expect(within(debrief).getByText('3 facts missing')).toBeInTheDocument()
    expect(within(debrief).getByRole('link', { name: 'Add in the brief' })).toHaveAttribute('href', '/app/projects/p1/intake')
    await screen.findByText('Kapselung K₂60 mit Gipsfaserplatten, Prüfbericht liegt vor.')
  })

  test('a structure that is no building is not asked for its construction, and no link promises otherwise', async () => {
    stubFetch()
    const wall = built({ A2_country: 'at', A2_land: 'tirol', A5: ['neubau'], 'C1@bw1': 'sonstig' })
    render(<ClosingDebrief projectId="p1" profile={wall} startedOn="2024-03" canWriteMemory />)

    const debrief = screen.getByTestId('closing-debrief')
    expect(within(debrief).getAllByText('does not apply')).toHaveLength(2)
    expect(within(debrief).queryByText('open (not set in the brief)')).not.toBeInTheDocument()
    await screen.findByText('Kapselung K₂60 mit Gipsfaserplatten, Prüfbericht liegt vor.')
  })

  test('offers only the active decisions and constraints, the memory other projects search', async () => {
    stubFetch()
    render(<ClosingDebrief projectId="p1" profile={profile} startedOn="2024-03" canWriteMemory />)

    await screen.findByText('Kapselung K₂60 mit Gipsfaserplatten, Prüfbericht liegt vor.')
    expect(screen.getByText('Die Behörde verlangt die Fluchtwegbreite in jedem Grundriss.')).toBeInTheDocument()
    expect(screen.queryByText('Die Dachlast beträgt 2 kN/m².')).not.toBeInTheDocument()
    expect(screen.queryByText('Verworfene Variante mit Stahlbeton.')).not.toBeInTheDocument()
  })

  test('confirming a decision records a person’s confirmation, and shows it', async () => {
    const fetchMock = stubFetch()
    render(<ClosingDebrief projectId="p1" profile={profile} startedOn="2024-03" canWriteMemory />)

    await screen.findByText('Kapselung K₂60 mit Gipsfaserplatten, Prüfbericht liegt vor.')
    // The pinned constraint is already a person's; only the decision asks.
    const confirms = screen.getAllByRole('button', { name: 'Confirm' })
    expect(confirms).toHaveLength(1)
    await userEvent.click(confirms[0])

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p1/memory/d1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ verification: 'user_confirmed' }) })
    )
    expect(await screen.findAllByText('Confirmed')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
  })

  test('a lesson in the closer’s words is recorded as a decision', async () => {
    const fetchMock = stubFetch()
    render(<ClosingDebrief projectId="p1" profile={profile} startedOn="2024-03" canWriteMemory />)

    await screen.findByText('Kapselung K₂60 mit Gipsfaserplatten, Prüfbericht liegt vor.')
    expect(screen.getByRole('button', { name: 'Record' })).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Record a lesson'), 'Brandschutzplan früh mit der Feuerwehr abstimmen.')
    await userEvent.click(screen.getByRole('button', { name: 'Record' }))

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p1/memory',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ kind: 'decision', content: 'Brandschutzplan früh mit der Feuerwehr abstimmen.' }),
      })
    )
    expect(await screen.findByText('Brandschutzplan früh mit der Feuerwehr abstimmen.')).toBeInTheDocument()
    expect(screen.getByLabelText('Record a lesson')).toHaveValue('')
  })

  test('a reader who may not write the memory sees what stays, and no control that would change it', async () => {
    stubFetch()
    render(<ClosingDebrief projectId="p1" profile={profile} startedOn="2024-03" canWriteMemory={false} />)

    await screen.findByText('Kapselung K₂60 mit Gipsfaserplatten, Prüfbericht liegt vor.')
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Record a lesson')).not.toBeInTheDocument()
    expect(screen.getByText(/Only people who may edit the project memory/)).toBeInTheDocument()
  })

  test('reading the documents posts the extraction, shows that it is pending, then what it found, and reloads', async () => {
    let answer: (response: Response) => void = () => {}
    const fetchMock = stubFetch({ experience: () => new Promise((resolve) => (answer = resolve)) })
    render(<ClosingDebrief projectId="p1" profile={profile} startedOn="2024-03" canWriteMemory />)
    await screen.findByText('Kapselung K₂60 mit Gipsfaserplatten, Prüfbericht liegt vor.')
    const gets = memoryGets(fetchMock)

    await userEvent.click(screen.getByRole('button', { name: 'Read from the documents' }))
    expect(screen.getByRole('status')).toHaveTextContent('Piloti is reading the documents …')
    expect(screen.getByRole('button', { name: 'Read from the documents' })).toBeDisabled()

    answer(Response.json(EXTRACTED))
    expect(await screen.findByText('3 facts suggested, 4 decisions drafted from 2 documents.')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/experience', expect.objectContaining({ method: 'POST' }))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(memoryGets(fetchMock)).toBe(gets + 1)
  })

  test('a reading that finds nothing new says so', async () => {
    const fetchMock = stubFetch({
      experience: async () => Response.json({ suggested: 0, drafted: 0, documentsRead: ['Plan.pdf'], error: null }),
    })
    render(<ClosingDebrief projectId="p1" profile={profile} startedOn="2024-03" canWriteMemory />)

    await userEvent.click(screen.getByRole('button', { name: 'Read from the documents' }))
    expect(await screen.findByText('Piloti found nothing new in the documents.')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/experience', expect.objectContaining({ method: 'POST' }))
  })

  test.each([
    ['backend_unavailable', 'Piloti could not read the documents just now. Please try again later.'],
    ['no_documents', 'There are no readable documents in the open folders yet.'],
    ['no_model', 'The reading did not work. Please try again later.'],
    ['extraction_failed', 'The reading did not work. Please try again later.'],
  ])('the error %s says its sentence, and changes nothing', async (error, sentence) => {
    const fetchMock = stubFetch({
      experience: async () => Response.json({ suggested: 0, drafted: 0, documentsRead: [], error }),
    })
    render(<ClosingDebrief projectId="p1" profile={profile} startedOn="2024-03" canWriteMemory />)
    const gets = memoryGets(fetchMock)

    await userEvent.click(screen.getByRole('button', { name: 'Read from the documents' }))
    expect(await screen.findByText(sentence)).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
    expect(memoryGets(fetchMock)).toBe(gets)
  })

  test('a request that fails says the reading did not work', async () => {
    stubFetch({ experience: async () => new Response('{}', { status: 500 }) })
    render(<ClosingDebrief projectId="p1" profile={profile} startedOn="2024-03" canWriteMemory />)

    await userEvent.click(screen.getByRole('button', { name: 'Read from the documents' }))
    expect(await screen.findByText('The reading did not work. Please try again later.')).toBeInTheDocument()
  })

  test('a suggested fact shows its reason, still counts as missing, and Accept writes it as a fact', async () => {
    const fetchMock = stubFetch()
    const withSuggestion = { ...profile, assumptions: { vorhabensart: suggestion(['neubau'], 'Baubeschreibung.pdf, S. 2: „Neubau eines Wohnhauses“') } }
    render(<ClosingDebrief projectId="p1" profile={withSuggestion} startedOn="2024-03" canWriteMemory />)

    const debrief = screen.getByTestId('closing-debrief')
    const row = within(debrief).getByText('Baubeschreibung.pdf, S. 2: „Neubau eines Wohnhauses“').closest('li')
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getByText('Suggestion from the documents')).toBeInTheDocument()
    expect(within(row as HTMLElement).getByText('Neubau')).toBeInTheDocument()
    // Accepting is what makes it an answer, so the fact is still missing until then:
    // uses and this suggested kind of work, the period being set.
    expect(within(debrief).getByText('2 facts missing')).toBeInTheDocument()

    await userEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Accept' }))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p1/profile/patches',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ patch: [{ op: 'add', path: '/facts/vorhabensart', value: ['neubau'] }] }),
      })
    )
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })

  test('a suggested Gebäudeklasse keeps its number, and the OIB edition is shown beside the facts', async () => {
    const fetchMock = stubFetch()
    const withSuggestions = {
      ...profile,
      assumptions: {
        gebaeudeklasse: suggestion(4, 'Baubeschreibung.pdf, S. 3: „Gebäudeklasse 4“'),
        oib_ausgabe: suggestion('2019', 'Einreichplan.pdf, S. 1: „OIB-Richtlinien 2019“'),
      },
    }
    render(<ClosingDebrief projectId="p1" profile={withSuggestions} startedOn="2024-03" canWriteMemory />)

    const debrief = screen.getByTestId('closing-debrief')
    expect(within(debrief).getAllByText('Suggestion from the documents')).toHaveLength(2)
    const oibRow = within(debrief).getByText('Einreichplan.pdf, S. 1: „OIB-Richtlinien 2019“').closest('li') as HTMLElement
    expect(within(oibRow).getByText('OIB edition')).toBeInTheDocument()
    expect(within(oibRow).getByText('OIB-Richtlinien 2019')).toBeInTheDocument()

    const classRow = within(debrief).getByText('Baubeschreibung.pdf, S. 3: „Gebäudeklasse 4“').closest('li') as HTMLElement
    expect(within(classRow).getByText('GK 4')).toBeInTheDocument()
    await userEvent.click(within(classRow).getByRole('button', { name: 'Accept' }))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p1/profile/patches',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ patch: [{ op: 'add', path: '/facts/gebaeudeklasse', value: 4 }] }),
      })
    )
  })

  test('a source-grounded decision shows its marker and evidence, and Dismiss removes it', async () => {
    const fetchMock = stubFetch({ memory: [...memory, drafted] })
    render(<ClosingDebrief projectId="p1" profile={profile} startedOn="2024-03" canWriteMemory />)

    const text = await screen.findByText('Fluchttreppe außen in Stahl statt eines zweiten Stiegenhauses.')
    const entry = text.closest('li') as HTMLElement
    expect(within(entry).getByText('Drawn from the documents')).toBeInTheDocument()
    expect(within(entry).getByText('Bescheid.pdf, p. 3')).toBeInTheDocument()
    expect(within(entry).getByRole('button', { name: 'Confirm' })).toBeInTheDocument()

    await userEvent.click(within(entry).getByRole('button', { name: 'Dismiss' }))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p1/memory/g1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ status: 'dismissed' }) })
    )
    await waitFor(() =>
      expect(screen.queryByText('Fluchttreppe außen in Stahl statt eines zweiten Stiegenhauses.')).not.toBeInTheDocument()
    )
  })

  test('a reader who may not write the memory or the profile sees the suggestions, and no control that would change them', async () => {
    stubFetch({ memory: [...memory, drafted] })
    const withSuggestion = { ...profile, assumptions: { vorhabensart: suggestion(['neubau'], 'Baubeschreibung.pdf, S. 2: „Neubau“') } }
    render(<ClosingDebrief projectId="p1" profile={withSuggestion} startedOn="2024-03" canWriteMemory={false} />)

    await screen.findByText('Fluchttreppe außen in Stahl statt eines zweiten Stiegenhauses.')
    expect(screen.getByText('Baubeschreibung.pdf, S. 2: „Neubau“')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Read from the documents' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
  })
})
