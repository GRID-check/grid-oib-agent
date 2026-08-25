/**
 * A ```mermaid fence is a diagram; every other fence is still a listing.
 *
 * The second half is the one worth a test. `code` is the busiest override in
 * this renderer — inline code, fifteen highlighted languages, and now one that
 * is not a language at all — and the way this goes wrong is not that mermaid
 * fails to render but that `typescript` stops being highlighted.
 */
import { render, screen, waitFor } from '@/test-utils'
import { describe, expect, it, vi } from 'vitest'

const renderer = vi.fn()
vi.mock('@/features/diagrams/render-diagram', () => ({
  diagramRendererFor: () => renderer,
}))

import { MarkdownRenderer } from './MarkdownRenderer'
import { isMermaidFence } from './utils'

const DRAWN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

/**
 * How long these waits are, and why it is not a magic number.
 *
 * `MermaidDiagram` is behind `next/dynamic` with `ssr: false`, and the chunk
 * behind that boundary pulls mermaid itself — 214 KB gzipped, measured. Until
 * it resolves the fence renders NOTHING (a deliberate choice, documented on the
 * `dynamic` call: the block is about to be replaced and a spinner would read as
 * a fault), so there is no intermediate element to assert on and the wait has to
 * cover the whole import. Testing Library's default is 1000 ms, and the import
 * plus two renders — the screen copy and the paper copy that gets filed — lands
 * either side of it, which made these two tests fail by the calendar rather
 * than by a defect.
 *
 * 8 s is not a performance budget. It is "long enough that a failure here means
 * the fence stopped drawing", which is what these tests are for.
 */
const DYNAMIC_IMPORT_BUDGET = { timeout: 8000 }

describe('routing a fence', () => {
  it('recognises a mermaid fence by its raw class, not by the highlighting language', () => {
    // `getLanguageFromClassName` answers `bash` for everything it does not know,
    // mermaid included, so the check cannot go through it.
    expect(isMermaidFence('language-mermaid')).toBe(true)
    expect(isMermaidFence('language-typescript')).toBe(false)
    expect(isMermaidFence(undefined)).toBe(false)
    expect(isMermaidFence('language-mermaidish')).toBe(false)
  })

  it('draws a mermaid fence', async () => {
    renderer.mockResolvedValue(DRAWN)
    render(<MarkdownRenderer content={'```mermaid\ngraph TD\n  A --> B\n```'} />)
    await waitFor(
      () => expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-state', 'drawn'),
      DYNAMIC_IMPORT_BUDGET
    )
  }, 15000)

  it('leaves an ordinary fence alone', async () => {
    render(<MarkdownRenderer content={'```typescript\nconst a = 1\n```'} />)
    expect(screen.queryByTestId('mermaid-diagram')).toBeNull()
    expect(screen.getByText(/const a = 1/)).toBeInTheDocument()
  })

  it('shows a streaming mermaid fence as its source', async () => {
    // The stabiliser auto-closes an odd number of fences, so a half-arrived
    // mermaid block reaches this override looking complete. Drawing it would
    // flash a parse error on every token.
    render(<MarkdownRenderer content={'```mermaid\ngraph TD\n  A -->'} isStreaming />)
    await waitFor(
      () => expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-state', 'streaming'),
      DYNAMIC_IMPORT_BUDGET
    )
    expect(renderer).not.toHaveBeenCalled()
  }, 15000)
})
