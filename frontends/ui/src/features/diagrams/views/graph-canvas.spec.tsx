/**
 * The graph canvas: what a screen reader is given, and the room an edge label
 * is laid out with.
 */
import { render, screen, within } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { edgeLabelBox, GraphCanvas, type GraphSpec } from './graph-canvas'

describe('an edge label', () => {
  it('is as wide as its text on one line', () => {
    expect(edgeLabelBox('ja')).toEqual({ width: Math.ceil(2 * 6.4 + 14), height: 22 })
  })

  it('wraps at the cap and is one line taller for each line it wraps to', () => {
    const long = 'nach Vorlage des vollständigen Brandschutzkonzepts'
    const box = edgeLabelBox(long)
    expect(box.width).toBe(160)
    // Three lines of ~22 characters: „nach Vorlage des", „vollständigen", „Brandschutzkonzepts".
    expect(box.height).toBe(Math.ceil(3 * 11 * 1.375 + 6))
  })

  it('counts a line break the label carries', () => {
    expect(edgeLabelBox('ja\nnein').height).toBe(edgeLabelBox('ja').height + Math.ceil(11 * 1.375) - 1)
  })

  it('runs a word too long for one line over the lines it fills', () => {
    expect(edgeLabelBox('x'.repeat(50)).height).toBe(Math.ceil(3 * 11 * 1.375 + 6))
  })
})

describe('the canvas, to a screen reader', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
  })
  afterEach(() => vi.restoreAllMocks())

  const Step = ({ data }: { data: { label: string } }) => <div>{data.label}</div>
  const build = (): GraphSpec => ({
    nodes: [
      { id: 'a', type: 'step', data: { label: 'Einreichung' }, width: 120 },
      { id: 'b', type: 'step', data: { label: 'Bescheid' }, width: 120 },
    ],
    edges: [{ id: 'e', source: 'a', target: 'b' }],
  })

  it('names the graph and leaves the node text readable inside it', () => {
    render(<GraphCanvas build={build} label="Ablauf" nodeTypes={{ step: Step }} />)
    expect(screen.queryByRole('img', { name: 'Ablauf' })).toBeNull()
    const graph = screen.getByRole('group', { name: 'Ablauf' })
    expect(within(graph).getByText('Einreichung')).toBeInTheDocument()
    expect(within(graph).getByText('Bescheid')).toBeInTheDocument()
  })
})
