/**
 * A streamed token re-renders what is already on screen; it must not replace it.
 *
 * Since ADR-0066 a closed diagram and an arrived card are drawn while the
 * answer after them is still arriving. The element overrides used to be
 * rebuilt on every token (they closed over the heading ids, the open fence and
 * the slot renderer), so React saw a new component each time and remounted the
 * whole answer: the drawn diagram went back to `drawing` and queued another
 * parse behind the mermaid lock, and the card played its arrival again.
 */
import { useEffect, type ReactNode } from 'react'
import { render, screen, waitFor } from '@/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { PluggableList } from 'unified'

const renderer = vi.fn()
vi.mock('@/features/diagrams/render-diagram', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/diagrams/render-diagram')>()),
  diagramRendererFor: () => renderer,
}))

import { remarkCardMarkers } from '@/features/grid-cards/card-markers'
import { CardArrival } from '@/features/chat/components/CardSlotArrival'
import { MarkdownRenderer } from './MarkdownRenderer'
import { MarkdownSlotProvider } from './slot-context'

const DRAWN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
/** See `mermaid-fence.spec.tsx`: the wait covers the dynamic import of mermaid. */
const DYNAMIC_IMPORT_BUDGET = { timeout: 8000 }
const PLUGINS: PluggableList = [[remarkCardMarkers, { count: 1, pending: true }]]

const ANSWER = [
  '## Ablauf',
  '',
  '```mermaid',
  'graph TD',
  '  A[Einreichung] --> B[Bescheid]',
  '```',
  '',
  '[[card:1]]',
  '',
  'Danach folgt',
].join('\n')

let cardMounts = 0

/** Stands in for a card: counts how often React creates it. */
function CardProbe() {
  useEffect(() => {
    cardMounts += 1
  }, [])
  return <div data-testid="card-probe">Karte</div>
}

/**
 * The chat's shape: a slot renderer that is a NEW function on every render, the
 * way `AgentResponse`'s is whenever its cards or streaming state move.
 */
function Answer({ content }: { content: string }): ReactNode {
  return (
    <MarkdownSlotProvider
      render={(index) =>
        index === 0 ? (
          <CardArrival live>
            <CardProbe />
          </CardArrival>
        ) : null
      }
    >
      <MarkdownRenderer content={content} isStreaming remarkPlugins={PLUGINS} />
    </MarkdownSlotProvider>
  )
}

describe('a streamed token', () => {
  it('keeps a drawn diagram and an arrived card mounted', async () => {
    renderer.mockResolvedValue(DRAWN)
    cardMounts = 0
    const { rerender } = render(<Answer content={ANSWER} />)
    await waitFor(
      () => expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-state', 'drawn'),
      DYNAMIC_IMPORT_BUDGET
    )
    const figure = screen.getByTestId('mermaid-diagram')
    const card = screen.getByTestId('card-probe')
    const heading = screen.getByRole('heading', { name: 'Ablauf' })
    expect(cardMounts).toBe(1)

    let content = ANSWER
    for (const token of [' noch', ' mehr', ' Text.', '\n\n## Ablauf', '\n\nEnde']) {
      content += token
      rerender(<Answer content={content} />)
      expect(screen.getByTestId('mermaid-diagram')).toBe(figure)
      expect(figure).toHaveAttribute('data-state', 'drawn')
      expect(screen.getByTestId('card-probe')).toBe(card)
    }
    expect(cardMounts).toBe(1)
    // The ids still follow the text: the second „Ablauf" is disambiguated, and
    // the first one keeps both its id and its node.
    expect(screen.getAllByRole('heading', { name: 'Ablauf' })[0]).toBe(heading)
    expect(heading).toHaveAttribute('id', 'ablauf')
    expect(screen.getAllByRole('heading', { name: 'Ablauf' })[1]).toHaveAttribute('id', 'ablauf-2')
  }, 20000)
})
