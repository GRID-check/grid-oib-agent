import { describe, expect, test } from 'vitest'
import { render, screen, within } from '@/test-utils'
import { SIMILAR_PROJECTS } from '@/app/dev/_fixtures/similar-projects'
import { SimilarProjectsTile } from './similar-projects-tile'

const many = Array.from({ length: 5 }, (_, i) => ({
  ...SIMILAR_PROJECTS[0],
  id: `p-${i}`,
  name: `Projekt ${i + 1}`,
}))

describe('SimilarProjectsTile', () => {
  test('names the three most alike, each linking to its project, and opens the rest in the hub', () => {
    render(<SimilarProjectsTile projects={many} href="/app/projects/p1/settings/references" />)

    const tile = screen.getByTestId('overview-similar')
    expect(within(tile).getByRole('link', { name: 'Projekt 1' })).toHaveAttribute(
      'href',
      '/app/projects/p-0'
    )
    expect(within(tile).queryByRole('link', { name: 'Projekt 4' })).not.toBeInTheDocument()
    expect(within(tile).getByRole('link', { name: /All 5 similar projects/ })).toHaveAttribute(
      'href',
      '/app/projects/p1/settings/references'
    )
  })

  test('says so, and links nowhere, when no closed project is alike yet', () => {
    render(<SimilarProjectsTile projects={[]} href="/app/projects/p1/settings/references" />)

    const tile = screen.getByTestId('overview-similar')
    expect(within(tile).queryByRole('link')).not.toBeInTheDocument()
  })
})
