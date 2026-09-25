/**
 * Schematic labels stay legible when the drawing shrinks (`legibleLabelSize`,
 * `SvgLabel` inside `SchematicCanvas`): the geometry is to scale, a label is
 * not, and a label is never enlarged past the room its template left for it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MAX_LABEL_GROWTH, MIN_LABEL_PX, SchematicCanvas, SvgLabel, legibleLabelSize } from './kit'

describe('legibleLabelSize', () => {
  it('leaves the label alone before the canvas is measured', () => {
    expect(legibleLabelSize(8, null)).toBe(8)
    expect(legibleLabelSize(8, 0)).toBe(8)
  })

  it('leaves a label that already reads at the minimum', () => {
    expect(legibleLabelSize(10, 1)).toBe(10)
    expect(legibleLabelSize(8, 1.25)).toBe(8)
  })

  it('enlarges a shrunken label to the minimum on screen', () => {
    // 9 units at 0.8 would be 7.2px; 12.5 units at 0.8 is exactly 10px.
    expect(legibleLabelSize(9, 0.8)).toBeCloseTo(MIN_LABEL_PX / 0.8)
    expect(legibleLabelSize(9, 0.8) * 0.8).toBeCloseTo(MIN_LABEL_PX)
  })

  it('caps the growth at 1.6×, even when the minimum is not reached', () => {
    expect(MAX_LABEL_GROWTH).toBe(1.6)
    // 8 units at 0.5 would need 20 units to read at 10px; it gets 12.8.
    expect(legibleLabelSize(8, 0.5)).toBeCloseTo(8 * MAX_LABEL_GROWTH)
  })
})

describe('SvgLabel on a SchematicCanvas', () => {
  afterEach(() => vi.restoreAllMocks())

  const drawnAt = (width: number) => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect)
    const { container } = render(
      <SchematicCanvas viewW={500} viewH={200} label="Schnitt">
        <SvgLabel x={0} y={0} size={8}>
          3,00 m
        </SvgLabel>
      </SchematicCanvas>
    )
    const text = container.querySelector('text') as SVGTextElement
    return { size: Number(text.getAttribute('font-size')), halo: Number(text.getAttribute('stroke-width')) }
  }

  it('draws the label larger on a narrow canvas and scales its halo with it', () => {
    // 500 units in 350px: scale 0.7, so 8 units would be 5.6px; capped at 12.8.
    const { size, halo } = drawnAt(350)
    expect(size).toBeCloseTo(8 * MAX_LABEL_GROWTH)
    expect(halo).toBeCloseTo((3 * size) / 8)
  })

  it('draws the authored size on a canvas wide enough to read it', () => {
    expect(drawnAt(1000).size).toBe(8)
  })
})
