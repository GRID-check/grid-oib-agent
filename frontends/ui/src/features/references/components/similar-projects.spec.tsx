import { describe, expect, test } from 'vitest'
import { render, screen } from '@/test-utils'
import { en } from '@/i18n/dictionaries/en'
import type { SimilarProject } from '@/lib/references/types'

import { SimilarProjects } from './similar-projects'

const WOHNHAUS: SimilarProject = {
  id: 'proj-mödling',
  name: 'Wohnhaus Mödling',
  period: { start: '2019-03-01', end: '2021-11-30' },
  bundesland: { value: 'Niederösterreich', confirmed: true },
  oibEdition: { value: '2019', confirmed: false },
  sharedTraits: ['Niederösterreich', 'GK 4', 'Holzbau'],
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
  sharedTraits: ['Niederösterreich'],
  decisions: [],
  permits: [],
}

describe('SimilarProjects', () => {
  test('names each project, what it shares with this one, and links it to the project', () => {
    render(<SimilarProjects projects={[WOHNHAUS]} />)
    expect(screen.getByRole('link', { name: 'Wohnhaus Mödling' })).toHaveAttribute('href', '/app/projects/proj-mödling')
    expect(screen.getByText('GK 4')).toBeInTheDocument()
    expect(screen.getByText('Holzbau')).toBeInTheDocument()
    expect(screen.getByText('2019–2021')).toBeInTheDocument()
  })

  test('marks an edition read from the documents as unconfirmed, and leaves a confirmed one unmarked', () => {
    const { unmount } = render(<SimilarProjects projects={[WOHNHAUS]} />)
    expect(screen.getByText(en.references.fields.unconfirmed)).toBeInTheDocument()
    unmount()

    render(<SimilarProjects projects={[CONFIRMED]} />)
    expect(screen.queryByText(en.references.fields.unconfirmed)).not.toBeInTheDocument()
    expect(screen.getByText('OIB guidelines 2015')).toBeInTheDocument()
  })

  test('shows the decision with its origin and its source, and the permit with its requirement', () => {
    render(<SimilarProjects projects={[WOHNHAUS]} />)
    expect(screen.getByText('Fluchttreppe außen in Stahl statt eines zweiten Stiegenhauses.')).toBeInTheDocument()
    expect(screen.getByText(en.references.decisions.origin.documents)).toBeInTheDocument()
    expect(screen.getByText('Bescheid.pdf, p. 3')).toBeInTheDocument()
    expect(screen.getByText('Brandschutzkonzept vor Baubeginn vorlegen.')).toBeInTheDocument()
  })

  test('says so, and offers nothing to open, when no closed project is like this one', () => {
    render(<SimilarProjects projects={[]} />)
    expect(screen.getByText(en.references.empty.title)).toBeInTheDocument()
    expect(screen.getByText(en.references.empty.description)).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
