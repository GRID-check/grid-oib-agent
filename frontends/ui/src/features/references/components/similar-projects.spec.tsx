import { describe, expect, test } from 'vitest'
import { render, screen, within } from '@/test-utils'
import { en } from '@/i18n/dictionaries/en'
import { fingerprintOf } from '@/lib/cross-project/fingerprint'
import type { SimilarProject, SimilarProjectsPage } from '@/lib/references/types'

import { SimilarProjects } from './similar-projects'

const WOHNHAUS: SimilarProject = {
  id: 'proj-mödling',
  name: 'Wohnhaus Mödling',
  period: { start: '2019-03-01', end: '2021-11-30' },
  bundesland: { value: 'Niederösterreich', confirmed: true },
  oibEdition: { value: '2019', confirmed: false },
  alike: true,
  sharedTraits: [
    { value: 'Niederösterreich', confirmed: true },
    { value: 'GK 4', confirmed: false },
    { value: 'Holzbau', confirmed: true },
  ],
  counts: { decisions: 7, permits: 1 },
  decisions: [
    {
      id: 'd1',
      kind: 'decision',
      content: 'Fluchttreppe außen in Stahl statt eines zweiten Stiegenhauses.',
      origin: 'documents',
      sources: [{ fileName: 'Bescheid.pdf', page: '3' }],
    },
  ],
  permits: [
    {
      id: 'p1',
      fileName: 'Baubewilligung.pdf',
      kind: 'bewilligung',
      authority: 'Stadtgemeinde Mödling',
      issuedOn: '2020-06-18',
      requirements: [{ kind: 'auflage', content: 'Brandschutzkonzept vor Baubeginn vorlegen.' }],
    },
  ],
}

const CONFIRMED: SimilarProject = {
  ...WOHNHAUS,
  id: 'proj-tulln',
  name: 'Bürogebäude Tulln',
  oibEdition: { value: '2015', confirmed: true },
  sharedTraits: [{ value: 'Niederösterreich', confirmed: true }],
  decisions: [],
  permits: [],
  counts: { decisions: 0, permits: 0 },
}

const UNRELATED: SimilarProject = { ...CONFIRMED, id: 'proj-wels', name: 'Halle Wels', alike: false, sharedTraits: [] }

/** A page whose current project has only its Land recorded: the briefing can still add the rest. */
function page(projects: SimilarProject[], more = 0): SimilarProjectsPage {
  const basis = fingerprintOf({
    facts: { bundesland: { value: 'niederoesterreich', confidence: 'confirmed', source: 'onboarding', updatedAt: '' } },
    goals: {},
    unknowns: [],
    assumptions: {},
  })
  return { basis: { facts: basis, missing: 3 }, projects, more }
}

describe('SimilarProjects', () => {
  test('names each project, what it shares with this one, and links it to the project', () => {
    render(<SimilarProjects projectId="current" page={page([WOHNHAUS])} />)
    expect(screen.getByRole('link', { name: 'Wohnhaus Mödling' })).toHaveAttribute('href', '/app/projects/proj-mödling')
    expect(screen.getByText('GK 4')).toBeInTheDocument()
    expect(screen.getByText('Holzbau')).toBeInTheDocument()
    expect(screen.getByText('2019–2021')).toBeInTheDocument()
  })

  test('marks an edition read from the documents as unconfirmed, and leaves a confirmed one unmarked', () => {
    const { unmount } = render(<SimilarProjects projectId="current" page={page([{ ...WOHNHAUS, sharedTraits: [] }])} />)
    expect(screen.getByText(en.references.fields.unconfirmed)).toBeInTheDocument()
    unmount()

    render(<SimilarProjects projectId="current" page={page([CONFIRMED])} />)
    expect(screen.queryByText(en.references.fields.unconfirmed)).not.toBeInTheDocument()
    expect(screen.getByText('OIB guidelines 2015')).toBeInTheDocument()
  })

  test('shows the decision with its origin and its source, and the permit with its requirement', () => {
    render(<SimilarProjects projectId="current" page={page([WOHNHAUS])} />)
    expect(screen.getByText('Fluchttreppe außen in Stahl statt eines zweiten Stiegenhauses.')).toBeInTheDocument()
    expect(screen.getByText(en.references.decisions.origin.documents)).toBeInTheDocument()
    expect(screen.getByText('Bescheid.pdf, p. 3')).toBeInTheDocument()
    expect(screen.getByText('Brandschutzkonzept vor Baubeginn vorlegen.')).toBeInTheDocument()
  })

  test('says so, and offers no project to open, when the office has no closed project', () => {
    render(<SimilarProjects projectId="current" page={page([])} />)
    expect(screen.getByText(en.references.empty.title)).toBeInTheDocument()
    expect(screen.getByText(en.references.empty.description)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: en.references.ask.action })).not.toBeInTheDocument()
  })

  test('says what it compared, names the open facts and links to the brief that fills them', () => {
    render(<SimilarProjects projectId="current" page={page([WOHNHAUS])} />)
    expect(screen.getByText('Federal state: Niederösterreich')).toBeInTheDocument()
    expect(screen.getByText('Building class: open')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add in the brief' })).toHaveAttribute('href', '/app/projects/current/intake')
  })

  test('marks a shared trait only one side has from its documents as unconfirmed', () => {
    render(<SimilarProjects projectId="current" page={page([WOHNHAUS])} />)
    // The edition and „GK 4“: two marks, the confirmed Land and Holzbau none.
    expect(screen.getAllByText(en.references.fields.unconfirmed)).toHaveLength(2)
  })

  test('lists a project with nothing in common apart from the alike ones, never as one of them', () => {
    render(<SimilarProjects projectId="current" page={page([WOHNHAUS, UNRELATED], 4)} />)
    const others = screen.getByRole('region', { name: en.references.others.title })
    expect(within(others).getByRole('link', { name: 'Halle Wels' })).toBeInTheDocument()
    expect(within(others).queryByRole('link', { name: 'Wohnhaus Mödling' })).not.toBeInTheDocument()
    expect(screen.getByText('… and 4 more closed projects, which Piloti also searches in chat.')).toBeInTheDocument()
  })

  test('writes a period without an end as running, never as the one year it began in', () => {
    render(<SimilarProjects projectId="current" page={page([{ ...CONFIRMED, period: { start: '2016-09-01', end: null } }])} />)
    expect(screen.getByText('2016–')).toBeInTheDocument()
  })

  test('says when no closed project shares anything, and still lists them', () => {
    render(<SimilarProjects projectId="current" page={page([UNRELATED])} />)
    expect(screen.getByText(en.references.noneAlike)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Halle Wels' })).toBeInTheDocument()
  })

  test('counts what the project holds, not what the card shows, and asks Piloti in a new chat of THIS project', () => {
    render(<SimilarProjects projectId="current" page={page([WOHNHAUS])} />)
    expect(screen.getByText('7 decisions · 1 permit')).toBeInTheDocument()
    const ask = screen.getByRole('link', { name: en.references.ask.action })
    const href = new URL(ask.getAttribute('href') ?? '', 'https://piloti.test')
    expect(href.pathname).toBe('/app/projects/current/chat')
    expect(href.searchParams.get('new')).toBe('1')
    expect(href.searchParams.get('ask')).toBe('What can we take from the project “Wohnhaus Mödling” for this project?')
  })
})
