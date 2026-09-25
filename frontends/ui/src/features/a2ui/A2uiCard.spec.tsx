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
import { INTERACTIVE_CARD_TYPES } from '@/features/grid-cards/card-decision'
import { SURFACE_EXCLUDED_LEAVES, preflight } from './catalog'
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
    expect(surfaceLeaves(tabs([['A', BASIS], ['B', BASIS]])).map((leaf) => ('type' in leaf ? leaf.type : 'text'))).toEqual([
      'legal_basis',
      'legal_basis',
    ])
  })

  const TABLE = '| Kriterium | Status |\n|---|---|\n| Rauchabzug | offen |'
  const textTabs = {
    type: 'surface',
    components: [
      { id: 'root', component: 'Tabs', tabs: [{ title: 'Außentreppe', child: 'a' }, { title: 'Treppenhaus', child: 'b' }] },
      { id: 'a', component: 'Text', text: TABLE },
      { id: 'b', component: 'legal_basis', law: 'OIB-Richtlinie 2', summary: 'x' },
    ],
  } as unknown as GridCard

  it('draws a Text tab as the answer’s own Markdown, a table included', async () => {
    render(<A2uiCard card={textTabs} surfaceKey="m1:4" render={renderCard} />)
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Außentreppe' })).toBeInTheDocument())
    const text = document.querySelector('[data-a2ui-surface] [data-a2ui-node="Text"]') as HTMLElement
    expect(text.querySelector('table')).not.toBeNull()
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Treppenhaus' }))
    expect(screen.getByTestId('card-b')).toBeInTheDocument()
  })

  it('keeps Text in the fallback when A2UI refuses the surface', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refused = {
      type: 'surface',
      components: [
        { id: 'root', component: 'Carousel', children: ['a', 'b'] },
        { id: 'a', component: 'Text', text: TABLE },
        { id: 'b', component: 'legal_basis', law: 'OIB-Richtlinie 2', summary: 'x' },
      ],
    } as unknown as GridCard
    render(<A2uiCard card={refused} surfaceKey="m1:5" render={renderCard} />)
    await waitFor(() => expect(screen.getByTestId('card-leaf-1')).toBeInTheDocument())
    expect(document.querySelector('[data-a2ui-node="Text"] table')).not.toBeNull()
    warn.mockRestore()
  })

  it('refuses a Text without text before A2UI can draw its error', () => {
    expect(preflight([{ id: 'a', component: 'Text', text: '  ' }])).toMatch(/Text/)
    expect(preflight([{ id: 'a', component: 'Text', text: 'ok' }])).toBeNull()
  })

  it('refuses a leaf the backend keeps out of a surface, an interactive card first', () => {
    // An interactive card's decision is keyed by its position in the message,
    // which a card inside a surface does not have: drawn there, its answer
    // would have nowhere to be kept.
    const surface = [
      { id: 'root', component: 'Column', children: ['a', 'b'] },
      { id: 'a', component: 'Text', text: 'Davor.' },
      // A valid proposal: the catalog's own schema would draw it.
      {
        id: 'b',
        component: 'memory_proposal',
        title: 'Diese Erkenntnis merken?',
        content: 'Das Büro setzt bei GK 4 durchgängig REI 90 an.',
        kind: 'preference',
        confidence: 'high',
      },
    ]
    expect(preflight(surface)).toMatch(/'b': a 'memory_proposal' cannot sit inside a surface/)
    expect(preflight([{ id: 's', component: 'summary', content: 'Kurz.' }])).toMatch(/summary/)
  })

  it('keeps every interactive card type out of a surface', () => {
    // The ratchet: a new interactive card type fails here until it is added
    // to both lists (this one and `SURFACE_EXCLUDED_LEAVES` in cards/models.py).
    for (const type of INTERACTIVE_CARD_TYPES) expect(SURFACE_EXCLUDED_LEAVES.has(type)).toBe(true)
  })
})
