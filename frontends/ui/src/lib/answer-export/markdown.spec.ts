/**
 * How the Word export treats a fence it cannot draw.
 *
 * Piloti draws mermaid on two surfaces — the chat answer and the filed
 * SVG/PDF — and cannot draw it on this one, because the export runs
 * server-side and mermaid needs a DOM to lay a graph out. The question this
 * spec pins is what the reader of the Word file gets instead, and the answer
 * must not be "the source, unannounced": `graph TD; A-->B` sitting in a
 * paragraph reads as content the answer meant to state.
 */

import { describe, expect, it } from 'vitest'
import { markdownToBlocks } from './markdown'
import type { DocBlock } from './blocks'

const runsText = (block: DocBlock): string =>
  block.kind === 'paragraph' ? block.runs.map((r) => r.text).join('') : ''

describe('markdownToBlocks — diagram fences', () => {
  it('labels a mermaid fence and keeps its source', () => {
    const blocks = markdownToBlocks('```mermaid\ngraph TD; A-->B\n```')

    // Two blocks, in this order: the label, then the source. The order is the
    // assertion — a label after the source explains a thing the reader has
    // already misread.
    expect(blocks).toHaveLength(2)
    expect(runsText(blocks[0])).toContain('Diagramm')
    expect(runsText(blocks[0])).toContain('mermaid')
    expect(runsText(blocks[1])).toBe('graph TD; A-->B')

    // The source stays monospaced and the label does not, so they cannot be
    // read as one block of code.
    expect(blocks[1].kind === 'paragraph' && blocks[1].runs[0].mono).toBe(true)
    expect(blocks[0].kind === 'paragraph' && blocks[0].runs[0].mono).toBeFalsy()
  })

  it('leaves an ordinary code fence exactly as it was', () => {
    // The narrowness is the point: labelling every fence would caption a
    // TypeScript snippet as a drawing.
    const blocks = markdownToBlocks('```ts\nconst a = 1\n```')

    expect(blocks).toHaveLength(1)
    expect(runsText(blocks[0])).toBe('const a = 1')
  })

  it('labels every kind the product knows how to draw', () => {
    // Reads the shared vocabulary rather than restating it, so a kind added to
    // DIAGRAM_SOURCE_KINDS reaches this export without anyone remembering to.
    for (const lang of ['mermaid', 'excalidraw']) {
      const blocks = markdownToBlocks('```' + lang + '\nx\n```')
      expect(runsText(blocks[0])).toContain(lang)
    }
  })

  it('is not fooled by case or padding in the fence info string', () => {
    const blocks = markdownToBlocks('```  MERMAID  \ngraph TD; A-->B\n```')
    expect(blocks).toHaveLength(2)
    expect(runsText(blocks[0])).toContain('Diagramm')
  })

  it('treats a bare fence as code, not as a drawing', () => {
    const blocks = markdownToBlocks('```\nplain\n```')
    expect(blocks).toHaveLength(1)
  })
})
