import { describe, expect, test } from 'vitest'
import { render, screen, within } from '@/test-utils'
import { en } from '@/i18n/dictionaries/en'
import { EMPTY_SIMILAR_PAGE, SIMILAR_PAGE, SIMILAR_PROJECTS } from '@/app/dev/_fixtures/similar-projects'
import type { SimilarProjectsPage } from '@/lib/references/types'
import { SimilarProjectsTile } from './similar-projects-tile'

const HREF = '/app/projects/p1/settings/references'

const many: SimilarProjectsPage = {
  ...SIMILAR_PAGE,
  projects: Array.from({ length: 5 }, (_, i) => ({ ...SIMILAR_PROJECTS[0], id: `p-${i}`, name: `Projekt ${i + 1}` })),
}

describe('SimilarProjectsTile', () => {
  test('names the three most alike, each linking to its project, and opens the rest in the hub', () => {
    render(<SimilarProjectsTile page={many} href={HREF} />)

    const tile = screen.getByTestId('overview-similar')
    expect(within(tile).getByRole('link', { name: 'Projekt 1' })).toHaveAttribute('href', '/app/projects/p-0')
    expect(within(tile).queryByRole('link', { name: 'Projekt 4' })).not.toBeInTheDocument()
    expect(within(tile).getByRole('link', { name: /All 5 similar projects/ })).toHaveAttribute('href', HREF)
  })

  test('never names a closed project that shares nothing as similar', () => {
    render(<SimilarProjectsTile page={SIMILAR_PAGE} href={HREF} />)

    const tile = screen.getByTestId('overview-similar')
    expect(within(tile).getByRole('link', { name: 'Wohnhaus Mödling' })).toBeInTheDocument()
    expect(within(tile).queryByRole('link', { name: 'Produktionshalle Wels' })).not.toBeInTheDocument()
    expect(within(tile).getByRole('link', { name: /All 2 similar projects/ })).toHaveAttribute('href', HREF)
  })

  test('counts what a project holds, not what the section shows of it', () => {
    render(<SimilarProjectsTile page={SIMILAR_PAGE} href={HREF} />)

    expect(screen.getByText(/3 decisions · 1 permit/)).toBeInTheDocument()
  })

  test('says none is alike yet, and still opens the closed projects, when only unrelated ones exist', () => {
    const unrelated = { ...SIMILAR_PAGE, projects: SIMILAR_PROJECTS.filter((project) => !project.alike) }
    render(<SimilarProjectsTile page={unrelated} href={HREF} />)

    const tile = screen.getByTestId('overview-similar')
    expect(within(tile).getByText(en.references.noneAlike)).toBeInTheDocument()
    expect(within(tile).getByRole('link', { name: en.settings.project.overview.similar.openOthers })).toHaveAttribute(
      'href',
      HREF
    )
  })

  test('says so, and links nowhere, when the office has no closed project', () => {
    render(<SimilarProjectsTile page={EMPTY_SIMILAR_PAGE} href={HREF} />)

    const tile = screen.getByTestId('overview-similar')
    expect(within(tile).getByText(en.settings.project.overview.similar.empty)).toBeInTheDocument()
    expect(within(tile).queryByRole('link')).not.toBeInTheDocument()
  })
})
