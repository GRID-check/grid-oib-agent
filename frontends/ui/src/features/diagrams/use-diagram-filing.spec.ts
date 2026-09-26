/**
 * The title a mermaid source carries in its front matter, read in time linear
 * in the source: the model writes the source, so its whitespace is not ours to
 * bound, and the title is read on every render of a drawn view.
 */
import { describe, expect, it } from 'vitest'
import { elapsedMs, growthRatio, LINEAR_BOUND } from '@/test-utils/growth'
import { titleFromSource } from './use-diagram-filing'

describe('titleFromSource', () => {
  it('reads the title out of the front matter', () => {
    expect(titleFromSource('---\ntitle: Verfahren\n---\nflowchart LR\n  A --> B')).toBe('Verfahren')
    expect(titleFromSource('\n  ---  \r\nconfig: {}\r\n  title:   Ablauf  \r\n---\nflowchart LR')).toBe('Ablauf')
  })

  it('has none without a closed front matter, or without a title in it', () => {
    expect(titleFromSource('flowchart LR\n  A --> B')).toBeNull()
    expect(titleFromSource('---\ntitle: Offen\nflowchart LR')).toBeNull()
    expect(titleFromSource('---\nconfig: {}\n---\ntitle: danach')).toBeNull()
    expect(titleFromSource('---\ntitle:\n---')).toBeNull()
  })

  it('caps a long title', () => {
    expect(titleFromSource(`---\ntitle: ${'x'.repeat(500)}\n---`)).toHaveLength(200)
  })

  it.each([
    ['a long run of blank lines in unclosed front matter', (n: number) => `---\n${'\n'.repeat(n)}x`],
    ['a long run of spaces inside the title', (n: number) => `---\ntitle: a${' '.repeat(n)}b\n---`],
  ])('is linear in %s', (_, source) => {
    const time = (n: number) => {
      const text = source(n)
      return elapsedMs(() => titleFromSource(text))
    }
    // Quadratic, 8 times the run took ~64 times as long; linear, ~8 times.
    expect(growthRatio(time, { size: 2000, floorMs: 0.05 })).toBeLessThan(LINEAR_BOUND)
  })
})
