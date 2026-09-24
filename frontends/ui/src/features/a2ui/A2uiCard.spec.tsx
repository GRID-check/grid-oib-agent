/**
 * The real A2UI renderer over the Piloti catalog — nothing mocked below the
 * card renderer. What these pin is the contract ADR-0065 rests on: a stored
 * card and a composed surface both come out of `A2uiSurface` as the card
 * components, with the card's own fields intact, and nothing A2UI refuses
 * costs the reader a card.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { GridCard } from '@/shared/cards/schemas'
import { A2uiCard } from './A2uiCard'
import { surfaceLeaves } from './surface-messages'

const BASIS = {
  type: 'legal_basis',
  law: 'OIB-Richtlinie 2',
  article: '3.1.1',
  summary: 'Brandabschnitte fassen höchstens 1.200 m².',
  reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b' },
} as unknown as GridCard

const renderCard = (card: GridCard, leafId: string) => (
  <div data-testid={`card-${leafId}`} data-type={card.type}>
    {JSON.stringify(card)}
  </div>
)

const tabs = (children: [string, GridCard][]): GridCard =>
  ({
    type: 'surface',
    components: [
      { id: 'root', component: 'Tabs', tabs: children.map(([title], index) => ({ title, child: `c${index}` })) },
      ...children.map(([, card], index) => {
        const { type, ...props } = card as { type: string }
        return { id: `c${index}`, component: type, ...props }
      }),
    ],
  }) as unknown as GridCard

describe('a card through A2UI', () => {
  it('draws a stored card as a one-component surface, fields intact', async () => {
    render(<A2uiCard card={BASIS} surfaceKey="m1:0" render={renderCard} />)
    await waitFor(() => expect(document.querySelector('[data-a2ui-surface="m1:0"]')).not.toBeNull())
    const drawn = screen.getByTestId('card-root')
    expect(drawn).toHaveAttribute('data-type', 'legal_basis')
    expect(JSON.parse(drawn.textContent ?? '{}')).toMatchObject({
      law: 'OIB-Richtlinie 2',
      article: '3.1.1',
      reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b' },
    })
  })

  it('draws a Tabs surface one tab at a time', async () => {
    const other = { ...BASIS, article: '5.2' } as GridCard
    render(<A2uiCard card={tabs([['Variante A', BASIS], ['Variante B', other]])} surfaceKey="m1:1" render={renderCard} />)
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Variante A' })).toBeInTheDocument())
    expect(screen.getByTestId('card-c0')).toBeInTheDocument()
    expect(screen.queryByTestId('card-c1')).toBeNull()
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Variante B' }))
    expect(screen.getByTestId('card-c1').textContent).toContain('5.2')
  })

  it('draws every child of a Row', async () => {
    const card = {
      type: 'surface',
      components: [
        { id: 'root', component: 'Row', children: ['a', 'b'] },
        { id: 'a', component: 'legal_basis', law: 'OIB-Richtlinie 2', summary: 'x' },
        { id: 'b', component: 'legal_basis', law: 'OIB-Richtlinie 4', summary: 'y' },
      ],
    } as unknown as GridCard
    render(<A2uiCard card={card} surfaceKey="m1:2" render={renderCard} />)
    await waitFor(() => expect(screen.getByTestId('card-a')).toBeInTheDocument())
    expect(screen.getByTestId('card-b')).toBeInTheDocument()
  })

  it('falls back to the cards themselves when A2UI refuses the surface', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refused = {
      type: 'surface',
      components: [
        { id: 'root', component: 'Carousel', children: ['a'] },
        { id: 'a', component: 'legal_basis', law: 'OIB-Richtlinie 2', summary: 'x' },
      ],
    } as unknown as GridCard
    render(<A2uiCard card={refused} surfaceKey="m1:3" render={renderCard} />)
    await waitFor(() => expect(screen.getByTestId('card-leaf-0')).toHaveAttribute('data-type', 'legal_basis'))
    warn.mockRestore()
  })

  it('lists a surface’s cards in document order', () => {
    expect(surfaceLeaves(tabs([['A', BASIS], ['B', BASIS]])).map((leaf) => leaf.type)).toEqual([
      'legal_basis',
      'legal_basis',
    ])
  })
})
