/**
 * The closing debrief (docs/roadmap/office-experience.md, step 3): what a
 * project leaves the office, asked in the close dialog while its memory can
 * still be written. It names the open facts of the fingerprint the ranking
 * reads, offers only the memory other projects search (active decisions and
 * constraints), confirms one so other projects cite it as a person's, records a
 * lesson as a decision, and offers none of that to a reader who may not write
 * the memory.
 */
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { render, screen, within } from '@/test-utils'
import { makeMemoryItem } from '@/test-utils/db-fixtures'
import { buildIntakeProfile, projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import type { ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'
import { ClosingDebrief } from './closing-debrief'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

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

const memory = [
  wire({ id: 'd1', kind: 'decision', content: 'Kapselung K₂60 mit Gipsfaserplatten, Prüfbericht liegt vor.' }),
  wire({ id: 'c1', kind: 'constraint', content: 'Die Behörde verlangt die Fluchtwegbreite in jedem Grundriss.', pinned: true }),
  wire({ id: 'f1', kind: 'derived_fact', content: 'Die Dachlast beträgt 2 kN/m².' }),
  wire({ id: 'old', kind: 'decision', content: 'Verworfene Variante mit Stahlbeton.', status: 'superseded' }),
]

function stubFetch() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      return Response.json({ item: { ...memory[0], verification: 'user_confirmed' } })
    }
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { kind: string; content: string }
      return Response.json({ item: wire({ id: 'new', kind: 'decision', content: body.content, provenanceType: 'user' }) }, { status: 201 })
    }
    return Response.json({ items: memory })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('ClosingDebrief', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
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
})
