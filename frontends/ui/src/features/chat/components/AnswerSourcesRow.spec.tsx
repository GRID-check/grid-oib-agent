import { render, screen } from '@/test-utils'
import { describe, expect, test, vi } from 'vitest'
import type { CitedDocument } from '../lib/citations'
import { AnswerSourcesRow } from './AnswerSourcesRow'
import type { SourcePreviewChipProps } from './SourcePreview'

/**
 * `AnswerSourcesRow` always renders the lane tints — the provenance signal.
 *
 * The provenance chips render their tint as a CSS-var inline style, which
 * jsdom's CSS parser drops, so the signal is read off a wrapper around the
 * REAL chip instead of off the DOM. Rendering stays real (labels, badges,
 * anchors, links), which is what the text assertions below pin. What is
 * asserted here is this row's half of the contract: the row hands every
 * document through, tint and all — lane tint is provenance, never muted.
 */

vi.mock('./SourcePreview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./SourcePreview')>()
  return {
    ...actual,
    SourcePreviewChip: (props: SourcePreviewChipProps) => (
      <span data-signal={props.citation.document.tint}>
        <actual.SourcePreviewChip {...props} />
      </span>
    ),
  }
})

const oibDoc: CitedDocument = {
  id: 'doc-oib',
  title: 'OIB-Richtlinie 2',
  fileName: 'oib-rl_2.pdf',
  kind: 'baurecht',
  lane: 'baurecht_oib',
  tint: 'oib',
  authority: 'OIB',
  loci: [{ key: 'l1', page: 12, number: 1, isCited: true }],
}

const risDoc: CitedDocument = {
  id: 'doc-ris',
  title: 'Wiener Bauordnung',
  kind: 'baurecht',
  lane: 'baurecht_ris',
  tint: 'law',
  loci: [{ key: 'l1', page: 3, number: 2, isCited: true }],
}

const signalOf = (container: HTMLElement, title: string): string | null => {
  const chips = Array.from(container.querySelectorAll('[data-signal]'))
  const match = chips.find((chip) => chip.textContent?.includes(title))
  return match?.getAttribute('data-signal') ?? null
}

describe('AnswerSourcesRow past the cap', () => {
  const unnumbered = (n: number): CitedDocument => ({
    id: `doc-${n}`,
    title: `Unterlage ${n}`,
    fileName: `unterlage-${n}.pdf`,
    kind: 'projekt',
    tint: 'project',
    loci: [{ key: 'l1', page: 1, isCited: true }],
  })

  test('the sources past the cap fold behind a count and unfold on demand', async () => {
    const docs = Array.from({ length: 11 }, (_, i) => unnumbered(i + 1))
    render(<AnswerSourcesRow documents={docs} anchorPrefix="test-" />)
    expect(screen.queryByText('Unterlage 11')).not.toBeInTheDocument()
    const more = screen.getByTestId('answer-sources-more')
    expect(more.textContent).toContain('3')
    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.setup().click(more)
    expect(screen.getByText('Unterlage 11')).toBeInTheDocument()
  })

  test('a row within the cap offers no fold', () => {
    render(<AnswerSourcesRow documents={[oibDoc, risDoc]} anchorPrefix="test-" />)
    expect(screen.queryByTestId('answer-sources-more')).not.toBeInTheDocument()
  })
})

describe('AnswerSourcesRow lane tints', () => {
  test('by default the chips keep their lane tints', () => {
    const { container } = render(
      <AnswerSourcesRow documents={[oibDoc, risDoc]} anchorPrefix="test-" />
    )

    expect(signalOf(container, 'OIB-Richtlinie 2')).toBe('oib')
    expect(signalOf(container, 'Wiener Bauordnung')).toBe('law')
  })

  test('every chip keeps its tint and what it says beside other chromatic accents', () => {
    // Evidence blocks, takeaways and frist/achtung callouts spend the hue
    // budget elsewhere — the provenance row never mutes its signal for them.
    const { container } = render(
      <AnswerSourcesRow documents={[oibDoc, risDoc]} anchorPrefix="test-" />
    )

    expect(signalOf(container, 'OIB-Richtlinie 2')).toBe('oib')
    expect(signalOf(container, 'Wiener Bauordnung')).toBe('law')
    // … and the labels, the authority badge, the markers and the anchors stay.
    expect(container.textContent).toContain('OIB-Richtlinie 2')
    expect(container.textContent).toContain('Wiener Bauordnung')
    expect(container.textContent).toContain('OIB')
    expect(container.querySelector('#test-1')).not.toBeNull()
    expect(container.querySelector('#test-2')).not.toBeNull()
  })

  test('an already-neutral chip is passed through untouched', () => {
    const { container } = render(
      <AnswerSourcesRow
        documents={[{ ...oibDoc, id: 'doc-web', title: 'Beispiel', tint: 'auto' }]}
        anchorPrefix="test-"
      />
    )

    expect(signalOf(container, 'Beispiel')).toBe('auto')
    expect(container.textContent).toContain('Beispiel')
  })

  test('nothing about the documents changes', () => {
    // The row hands the documents through, tint and all.
    const { container } = render(<AnswerSourcesRow documents={[oibDoc]} anchorPrefix="test-" />)

    expect(signalOf(container, 'OIB-Richtlinie 2')).toBe('oib')
    expect(
      screen.getByRole('list', { name: 'Sources this answer is backed by' })
    ).toBeInTheDocument()
  })
})
