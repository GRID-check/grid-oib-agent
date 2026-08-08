import { describe, expect, it } from 'vitest'
import { composeTransform, pageTextChunks, textItemToChunk } from './pdf-text-chunks'

/**
 * The viewport matrix pdf.js builds for an unrotated page at scale 1: x passes
 * through, y is flipped and shifted by the page height. A 800pt-tall page here.
 */
const PAGE_HEIGHT = 800
const VIEWPORT = [1, 0, 0, -1, 0, PAGE_HEIGHT]

/** A 12pt run of text with its baseline at PDF-space (72, 700). */
const run = (str: string, x = 72, baseline = 700, size = 12, width = 120) => ({
  str,
  width,
  height: size,
  transform: [size, 0, 0, size, x, baseline],
})

describe('composeTransform', () => {
  it('matches the identity', () => {
    expect(composeTransform([1, 0, 0, 1, 0, 0], [2, 0, 0, 3, 4, 5])).toEqual([2, 0, 0, 3, 4, 5])
  })

  it('composes translation through a flip', () => {
    expect(composeTransform(VIEWPORT, [1, 0, 0, 1, 10, 20])).toEqual([1, 0, 0, -1, 10, 780])
  })

  it('treats a short matrix as zeroes rather than producing NaN', () => {
    expect(composeTransform([], []).every(Number.isFinite)).toBe(true)
  })
})

describe('textItemToChunk', () => {
  it('flips the baseline into a top-left box', () => {
    const chunk = textItemToChunk(run('Der Bescheid'), VIEWPORT)
    expect(chunk.x).toBe(72)
    // Baseline y=700 in PDF space is 100 from the top; the box starts one glyph
    // height above it.
    expect(chunk.y).toBe(PAGE_HEIGHT - 700 - 12)
    expect(chunk.height).toBe(12)
    expect(chunk.width).toBe(120)
    expect(chunk.text).toBe('Der Bescheid')
  })

  it('scales the run width by the same factor as its position', () => {
    const scaled = composeTransform([2, 0, 0, 2, 0, 0], VIEWPORT)
    const chunk = textItemToChunk(run('Der Bescheid'), scaled)
    expect(chunk.x).toBe(144)
    expect(chunk.width).toBe(240)
    expect(chunk.height).toBe(24)
  })

  it('falls back to the reported height when the matrix has no vertical scale', () => {
    const flat = { str: 'x', width: 10, height: 9, transform: [1, 0, 0, 0, 0, 0] }
    expect(textItemToChunk(flat, VIEWPORT).height).toBe(9)
  })
})

describe('pageTextChunks', () => {
  it('drops runs that cannot carry a highlight', () => {
    const items = [
      run('Der Bescheid'),
      { ...run('   '), str: '   ' },
      { ...run('unsichtbar'), width: 0 },
    ]
    const chunks = pageTextChunks(items, VIEWPORT)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toBe('Der Bescheid')
  })

  it('keeps page order so adjacent runs stay adjacent in the search stream', () => {
    const chunks = pageTextChunks(
      [run('Der', 72), run('Bescheid', 100), run('ist', 160)],
      VIEWPORT,
    )
    expect(chunks.map((chunk) => chunk.text)).toEqual(['Der', 'Bescheid', 'ist'])
  })
})
