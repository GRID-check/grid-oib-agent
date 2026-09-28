/**
 * What a diagram view costs when the answer around it re-renders.
 *
 * A streamed answer re-renders its fences on every token, so a view that
 * rebuilds its graph or runs dagre per render pays that per token. The canvas
 * is replaced by a probe that builds once per render, as the real one does when
 * `build` changes; dagre is watched where the views call it themselves.
 */
import { render, screen } from '@/test-utils'
import dagre from '@dagrejs/dagre'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FlowModel, MapModel, ScheduleModel } from '../model'
import type { GraphSpec } from './graph-canvas'

const builds: ((width: number) => GraphSpec)[] = []
vi.mock('./graph-canvas', () => ({
  GraphCanvas: ({ build }: { build: (width: number) => GraphSpec }) => {
    builds.push(build)
    build(800)
    return null
  },
}))

import { FlowDiagram, MapDiagram, ScheduleDiagram } from './diagram-views'

afterEach(() => {
  builds.length = 0
  vi.restoreAllMocks()
})

const FLOW: FlowModel = {
  kind: 'flow',
  direction: 'right',
  nodes: [
    { id: 'a', label: 'Einreichung', shape: 'step' },
    { id: 'b', label: 'Vollständig?', shape: 'decision' },
    { id: 'c', label: 'Bescheid', shape: 'end' },
  ],
  edges: [
    { id: 'e1', from: 'a', to: 'b' },
    { id: 'e2', from: 'b', to: 'c' },
  ],
}

const MAP: MapModel = {
  kind: 'map',
  root: {
    id: 'root',
    label: 'OIB-RL 2',
    children: [{ id: 'root.0', label: 'Allgemein', children: [] }],
  },
}

describe('a map view', () => {
  it('keeps one graph across re-renders of the same model', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    const { rerender } = render(<MapDiagram model={MAP} label="Karte" />)
    rerender(<MapDiagram model={MAP} label="Karte" />)
    expect(builds.length).toBeGreaterThanOrEqual(2)
    expect(new Set(builds).size).toBe(1)
  })

  it('shows the outline in a narrow column, without the graph', () => {
    // Both used to mount, one hidden by a container query: a phone paid for the tree.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300)
    render(<MapDiagram model={MAP} label="Karte" />)
    expect(builds).toHaveLength(0)
    expect(screen.getAllByRole('list').length).toBeGreaterThan(0)
  })
})

describe('a flow view', () => {
  it('lays a model out once, however often it re-renders, and only in the form shown', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    const layout = vi.spyOn(dagre, 'layout')
    const { rerender } = render(<FlowDiagram model={FLOW} label="Ablauf" />)
    rerender(<FlowDiagram model={FLOW} label="Ablauf" />)
    rerender(<FlowDiagram model={FLOW} label="Ablauf" />)
    // One pass: the widest rank for the graph's direction. No outline pass,
    // because a column this wide shows the graph.
    expect(layout).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('shows the outline in a narrow column, without the graph', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300)
    render(<FlowDiagram model={FLOW} label="Ablauf" />)
    expect(builds).toHaveLength(0)
    expect(screen.getByRole('list')).toHaveTextContent('Einreichung')
  })
})

describe('a schedule', () => {
  it('names the last day a task covers, not mermaid’s exclusive end', () => {
    const model: ScheduleModel = {
      kind: 'schedule',
      sections: [
        {
          label: '',
          tasks: [
            { label: 'Vorprüfung', start: '2026-10-01', end: '2026-10-15', milestone: false },
          ],
        },
      ],
    }
    render(<ScheduleDiagram model={model} />)
    expect(screen.getByText('01.10.–14.10.')).toBeInTheDocument()
  })
})
