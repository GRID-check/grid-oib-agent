/**
 * The real A2UI renderer over the Piloti catalog — nothing mocked below the
 * card renderer. What these pin is the contract ADR-0065 rests on: a stored
 * card and a composed surface both come out of `A2uiSurface` as the card
 * components, with the card's own fields intact, and nothing A2UI refuses
 * costs the reader a card.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { memo, useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { GridCard } from '@/shared/cards/schemas'
import { A2uiCard } from './A2uiCard'
import { INTERACTIVE_CARD_TYPES } from '@/features/grid-cards/card-decision'
import { GridCardItem } from '@/features/grid-cards/components/GridCards'
import { SURFACE_EXCLUDED_LEAVES, preflight, structuralRefusal } from './catalog'
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

  it('draws a lone card the surface excludes through A2UI, without a refusal', async () => {
    // The exclusion is for a leaf INSIDE a surface. A lone card sits in the
    // message itself, so a stored proposal or summary draws like any card.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const proposal = {
      type: 'memory_proposal',
      title: 'Diese Erkenntnis merken?',
      content: 'Das Büro setzt bei GK 4 durchgängig REI 90 an.',
      kind: 'preference',
      confidence: 'high',
    } as unknown as GridCard
    render(<A2uiCard card={proposal} surfaceKey="m1:lone" render={renderCard} />)
    await waitFor(() =>
      expect(document.querySelector('[data-a2ui-surface="m1:lone"] [data-a2ui-node="memory_proposal"]')).not.toBeNull()
    )
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
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
    await waitFor(() => expect(screen.getByTestId('card-a')).toHaveAttribute('data-type', 'legal_basis'))
    warn.mockRestore()
  })

  it('lists a surface’s cards in document order', () => {
    expect(surfaceLeaves(tabs([['A', BASIS], ['B', BASIS]])).map(({ id, leaf }) => [id, 'type' in leaf ? leaf.type : 'text'])).toEqual([
      ['c0', 'legal_basis'],
      ['c1', 'legal_basis'],
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
    await waitFor(() => expect(screen.getByTestId('card-b')).toBeInTheDocument())
    expect(document.querySelector('[data-a2ui-node="Text"] table')).not.toBeNull()
    warn.mockRestore()
  })

  it('refuses a Text without text before A2UI can draw its error', () => {
    expect(preflight([{ id: 'root', component: 'Text', text: '  ' }])).toMatch(/Text/)
    expect(preflight([{ id: 'root', component: 'Text', text: 'ok' }])).toBeNull()
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

  it('refuses what SurfaceCard refuses: a data-bound child list, a blank tab title', () => {
    const leaves = [
      { id: 'a', component: 'Text', text: 'A' },
      { id: 'b', component: 'Text', text: 'B' },
    ]
    const bound = [{ id: 'root', component: 'Column', children: { componentId: 'a', path: '/items' } }, ...leaves]
    const blank = [
      {
        id: 'root',
        component: 'Tabs',
        tabs: [
          { title: ' ', child: 'a' },
          { title: 'B', child: 'b' },
        ],
      },
      ...leaves,
    ]
    expect(preflight(bound)).not.toBeNull()
    expect(preflight(blank)).not.toBeNull()
  })

  it('keeps every interactive card type out of a surface', () => {
    // The ratchet: a new interactive card type fails here until it is added
    // to this hand-kept list; cards/models.py derives its own from the catalog.
    for (const type of INTERACTIVE_CARD_TYPES) expect(SURFACE_EXCLUDED_LEAVES.has(type)).toBe(true)
  })

  const LEAF = { component: 'legal_basis', law: 'OIB-Richtlinie 2', summary: 'x' }

  it('refuses a surface that is not one tree under root', () => {
    // A2UI draws each of these as a grey "[Loading id...]" placeholder and
    // reports the surface drawn, so they are refused before it sees them.
    const column = (children: string[]) => ({ id: 'root', component: 'Column', children })
    expect(preflight([column(['a', 'missing']), { id: 'a', ...LEAF }])).toMatch(/'missing' does not exist/)
    expect(preflight([column(['a']), { id: 'a', component: 'Column', children: ['root'] }])).toMatch(/cycle/)
    expect(preflight([column(['a']), { id: 'a', ...LEAF }, { id: 'a', ...LEAF }])).toMatch(/used twice/)
    expect(preflight([{ id: 'a', ...LEAF }])).toMatch(/no 'root'/)
    expect(preflight([column(['a', 'a']), { id: 'a', ...LEAF }])).toMatch(/more than once/)
    expect(
      preflight([
        { id: 'root', component: 'Tabs', tabs: [{ title: 'A', child: 'a' }, { title: 'B', child: 'a' }] },
        { id: 'a', ...LEAF },
      ])
    ).toMatch(/more than once/)
    expect(preflight([column(['a']), { id: 'a', ...LEAF }, { id: 'b', ...LEAF }])).toMatch(/'b': not reachable/)
    expect(structuralRefusal([column(['a', 'b']), { id: 'a', ...LEAF }, { id: 'b', ...LEAF }])).toBeNull()
  })

  it('draws a surface with a dangling child as its cards, never a placeholder', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const dangling = {
      type: 'surface',
      components: [{ id: 'root', component: 'Column', children: ['a', 'missing'] }, { id: 'a', ...LEAF }],
    } as unknown as GridCard
    const { container } = render(<A2uiCard card={dangling} surfaceKey="m1:6" render={renderCard} />)
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(screen.getByTestId('card-a')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/Loading/)
    expect(container.querySelector('[data-a2ui-surface]')).toBeNull()
    warn.mockRestore()
  })

  it('does not bring a refused interactive leaf back through the fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refused = {
      type: 'surface',
      components: [
        { id: 'root', component: 'Column', children: ['a', 'b'] },
        { id: 'a', ...LEAF },
        { id: 'b', component: 'memory_proposal', title: 'Merken?', content: 'REI 90.', kind: 'preference', confidence: 'high' },
      ],
    } as unknown as GridCard
    render(<A2uiCard card={refused} surfaceKey="m1:7" render={renderCard} />)
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(screen.getByTestId('card-a')).toBeInTheDocument()
    expect(screen.queryByTestId('card-b')).toBeNull()
    expect(surfaceLeaves(refused).map(({ id }) => id)).toEqual(['a'])
    warn.mockRestore()
  })

  it('drops a malformed leaf from the fallback and draws its valid sibling', async () => {
    // A surface's components are open records, so nothing checks a leaf
    // before `preflight` refuses it; the fallback must not hand the renderer a
    // `legal_basis` with no law and lose the whole answer to a TypeError.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const malformed = {
      type: 'surface',
      components: [
        { id: 'root', component: 'Row', children: ['a', 'b'] },
        { id: 'a', component: 'legal_basis', summary: 'no law here' },
        { id: 'b', component: 'legal_basis', law: 'OIB-Richtlinie 2', summary: 'fine' },
      ],
    } as unknown as GridCard
    render(<GridCardItem card={malformed} index={0} messageId="m1" />)
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(await screen.findByText('fine')).toBeInTheDocument()
    expect(surfaceLeaves(malformed).map(({ id }) => id)).toEqual(['b'])
    warn.mockRestore()
  })

  it('mounts a card twice, the direct copy and A2UI’s, and no more', async () => {
    let mounts = 0
    function Counted() {
      useEffect(() => {
        mounts += 1
      }, [])
      return <div data-testid="counted" />
    }
    render(<A2uiCard card={BASIS} surfaceKey="m1:8" render={() => <Counted />} />)
    await waitFor(() => expect(document.querySelector('[data-a2ui-surface="m1:8"]')).not.toBeNull())
    await waitFor(() => expect(screen.getAllByTestId('counted')).toHaveLength(1))
    expect(mounts).toBe(2)
  })

  it('retries A2UI when a surface that failed changes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const first = { ...BASIS, article: '1' } as GridCard
    let failing = true
    // Throws for A2UI's copy only: the direct copy is drawn from the card
    // object itself, A2UI's from a copy of its props.
    const Leaf = memo(function Leaf({ card }: { card: GridCard }) {
      if (failing && card !== first) throw new Error('library bug')
      return <div data-testid="leaf">{(card as { article?: string }).article}</div>
    })
    const renderLeaf = (card: GridCard) => <Leaf card={card} />
    const { rerender } = render(<A2uiCard card={first} surfaceKey="m1:9" render={renderLeaf} />)
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(screen.getByTestId('leaf')).toHaveTextContent('1')

    failing = false
    rerender(<A2uiCard card={{ ...BASIS, article: '2' } as GridCard} surfaceKey="m1:9" render={renderLeaf} />)
    await waitFor(() => expect(document.querySelector('[data-a2ui-surface="m1:9"]:not([aria-hidden])')).not.toBeNull())
    expect(screen.getByTestId('leaf')).toHaveTextContent('2')
    warn.mockRestore()
    error.mockRestore()
  })
})
