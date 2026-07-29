import { describe, test, expect } from 'vitest'
import { buildGraph, planFan, type ReasoningFlowProps } from './ReasoningFlow'
import type { CitedDocument } from '../../lib/citations'
import type { Translator } from '@/i18n'

// Identity translator — the graph structure (nodes/edges/handles) is what these
// regression tests assert, not the copy, so echoing the key is enough.
const t = ((key: string) => key) as unknown as Translator

const card = (id: string): CitedDocument => ({
  id,
  title: id,
  kind: 'baurecht',
  tint: 'law',
  loci: [{ key: 'whole', isCited: true }],
})

const base: ReasoningFlowProps = { steps: [], userQuestion: 'Frage?' }

/** A desktop chat column; a phone viewport. */
const DESKTOP_W = 680
const PHONE_W = 340

/** Handle ids a framing node exposes (its bottom/source handles). */
const framingHandles = (g: ReturnType<typeof buildGraph>): string[] =>
  ((g.nodes.find((n) => n.id === 'framing')!.data as { sources: Array<{ id: string }> }).sources).map((h) => h.id)

/** Target handle ids a converge node exposes (its top handles). */
const targetHandles = (g: ReturnType<typeof buildGraph>, id: string): string[] =>
  ((g.nodes.find((n) => n.id === id)!.data as { targets: Array<{ id: string }> }).targets).map((h) => h.id)

const columnToColumnEdges = (g: ReturnType<typeof buildGraph>) =>
  g.edges.filter((e) => e.source.startsWith('col-') && e.target.startsWith('col-'))

/** Cards each column node carries, left→right. */
const columnCards = (g: ReturnType<typeof buildGraph>): string[][] =>
  g.nodes
    .filter((n) => n.type === 'sourceColumn')
    .map((n) => (n.data as unknown as { cards: CitedDocument[] }).cards.map((c) => c.id))

describe('planFan — sources pack into columns, never a forced single column', () => {
  test('a desktop chat column fans out one column per source for a typical turn', () => {
    for (const n of [1, 2, 3, 4]) {
      const fan = planFan(DESKTOP_W, n)
      expect(fan.columns).toHaveLength(n)
      expect(fan.grouped).toBe(false)
    }
  })

  test('REGRESSION: more sources than fit widen into stacked columns — not one vertical chain', () => {
    // The old layout compared a fixed natural width against the container and
    // dropped to a SINGLE grouped column as soon as it did not fit, which is
    // what made real turns render as one long vertical list on desktop.
    const fan = planFan(DESKTOP_W, 8)
    expect(fan.columns.length).toBeGreaterThan(1)
    expect(fan.grouped).toBe(false)
    // Every card is placed exactly once, in reading order.
    expect(fan.columns.flat()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  test('columns are balanced, remainder on the left', () => {
    const fan = planFan(DESKTOP_W, 7)
    const sizes = fan.columns.map((c) => c.length)
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a))
    expect(fan.columns.flat()).toHaveLength(7)
  })

  test('a narrow container always collapses to one grouped column, whatever the arithmetic', () => {
    // A phone fits two ~160px columns on paper, but the card name is a two-line
    // clamp — side-by-side there it degenerates into columns of ellipses.
    for (const width of [280, 340, 400, 420]) {
      const fan = planFan(width, 5)
      expect(fan.columns).toHaveLength(1)
      expect(fan.grouped).toBe(true)
    }
  })

  test('the fan never overflows the container width', () => {
    for (const width of [280, 340, 460, 680, 900]) {
      for (const n of [1, 3, 5, 9]) {
        const fan = planFan(width, n)
        const fanW = fan.columns.length * fan.colW + (fan.columns.length - 1) * fan.gap
        expect(fan.fanX + fanW).toBeLessThanOrEqual(fan.contentW)
      }
    }
  })

  test('phone width collapses to the single grouped column', () => {
    const fan = planFan(PHONE_W, 4)
    expect(fan.columns).toEqual([[0, 1, 2, 3]])
    expect(fan.grouped).toBe(true)
    expect(fan.colW).toBe(fan.contentW)
  })

  test('no sources → no columns', () => {
    expect(planFan(DESKTOP_W, 0).columns).toEqual([])
  })
})

describe('buildGraph — parallel wiring (P1-4)', () => {
  test('framing fans out to every column, each column converges — never a chain', () => {
    const cards = [card('a'), card('b'), card('c')]
    const g = buildGraph({ ...base, answerConfidence: 'high' }, t, planFan(DESKTOP_W, 3), cards)

    // One column per source at this width, wired framing → column → findings.
    expect(columnCards(g)).toEqual([['a'], ['b'], ['c']])
    expect(framingHandles(g)).toEqual(['c-bottom'])
    for (const cid of ['col-0', 'col-1', 'col-2']) {
      expect(g.edges).toContainEqual(expect.objectContaining({ source: 'framing', target: cid }))
      expect(g.edges).toContainEqual(expect.objectContaining({ source: cid, target: 'findings' }))
    }
    // The bug was framing→src1→src2→…: there must be NO column→column edge.
    expect(columnToColumnEdges(g)).toHaveLength(0)
  })

  test('stacked columns keep exactly two straight edges each — nothing pierces a card', () => {
    const cards = Array.from({ length: 8 }, (_, i) => card(`s${i}`))
    const fan = planFan(DESKTOP_W, 8)
    const g = buildGraph({ ...base, answerConfidence: 'high' }, t, fan, cards)

    const columnIds = g.nodes.filter((n) => n.type === 'sourceColumn').map((n) => n.id)
    expect(columnIds.length).toBe(fan.columns.length)
    // Two edges per column (in + out) and nothing else touches them.
    expect(g.edges.filter((e) => e.target.startsWith('col-'))).toHaveLength(columnIds.length)
    expect(g.edges.filter((e) => e.source.startsWith('col-'))).toHaveLength(columnIds.length)
    expect(columnToColumnEdges(g)).toHaveLength(0)
    // Every source card is rendered exactly once across the columns.
    expect(columnCards(g).flat().sort()).toEqual(cards.map((c) => c.id).sort())
  })

  test('phone: the single grouped column takes one centred edge in and one out', () => {
    const g = buildGraph({ ...base, answerConfidence: 'high' }, t, planFan(PHONE_W, 2), [card('a'), card('b')])

    expect(g.nodes.map((n) => n.id)).toEqual(['framing', 'col-0', 'findings'])
    expect((g.nodes.find((n) => n.id === 'col-0')!.data as unknown as { grouped: boolean }).grouped).toBe(true)
    expect(framingHandles(g)).toEqual(['c-bottom'])
    expect(g.edges).toHaveLength(2)
    expect(g.edges).toContainEqual(
      expect.objectContaining({ source: 'framing', sourceHandle: 'c-bottom', target: 'col-0', targetHandle: 'in' })
    )
    expect(g.edges).toContainEqual(
      expect.objectContaining({ source: 'col-0', sourceHandle: 'out', target: 'findings', targetHandle: 'c-top' })
    )
    expect(g.rows).toEqual([['framing'], ['col-0'], ['findings']])
  })
})

describe('buildGraph — the fan splits from one line and merges back into one', () => {
  test('every column edge shares the framing exit and the assessment entry point', () => {
    const fan = planFan(DESKTOP_W, 4)
    const g = buildGraph({ ...base, answerConfidence: 'high' }, t, fan, [card('a'), card('b'), card('c'), card('d')])

    // A single centred anchor per banner in each direction: the connectors share
    // their first and last segment, so the graph reads as one line splitting
    // into the sources and merging back out — not N parallel drops landing
    // side by side on the assessment's top edge.
    expect(framingHandles(g)).toEqual(['c-bottom'])
    expect(targetHandles(g, 'findings')).toEqual(['c-top'])

    const out = g.edges.filter((e) => e.source === 'framing')
    const back = g.edges.filter((e) => e.target === 'findings')
    expect(out).toHaveLength(4)
    expect(back).toHaveLength(4)
    expect(new Set(out.map((e) => e.sourceHandle))).toEqual(new Set(['c-bottom']))
    expect(new Set(back.map((e) => e.targetHandle))).toEqual(new Set(['c-top']))

    // Both anchors are centred, and the banners span the full width at x=0.
    expect(framingHandles(g)).toEqual(['c-bottom'])
    for (const id of ['framing', 'findings']) {
      expect(g.nodes.find((n) => n.id === id)!.position.x).toBe(0)
    }
  })
})

describe('buildGraph — the fan-in shares one centred anchor (P1-5)', () => {
  test('choice prompt without findings: every column merges into the branches node centre handle', () => {
    const g = buildGraph(
      {
        ...base,
        choicePrompt: { promptId: 'p', text: 'weiter?', options: ['A', 'B'], isResponded: false },
      },
      t,
      planFan(DESKTOP_W, 2),
      [card('a'), card('b')]
    )

    expect(g.nodes.find((n) => n.id === 'findings')).toBeUndefined()
    // Every column lands on the same centred target handle on the branches node.
    expect(targetHandles(g, 'branches')).toEqual(['c-top'])
    expect(g.edges).toContainEqual(
      expect.objectContaining({ source: 'col-0', target: 'branches', targetHandle: 'c-top' })
    )
    expect(g.edges).toContainEqual(
      expect.objectContaining({ source: 'col-1', target: 'branches', targetHandle: 'c-top' })
    )
  })

  test('findings + branches: columns fan into findings, findings feeds branches on a single centre handle', () => {
    const g = buildGraph(
      {
        ...base,
        answerConfidence: 'medium',
        choicePrompt: { promptId: 'p', text: 'weiter?', options: ['A'], isResponded: false },
      },
      t,
      planFan(DESKTOP_W, 2),
      [card('a'), card('b')]
    )

    expect(targetHandles(g, 'findings')).toEqual(['c-top'])
    expect(targetHandles(g, 'branches')).toEqual(['c-top'])
    expect(g.edges).toContainEqual(
      expect.objectContaining({ source: 'findings', target: 'branches', targetHandle: 'c-top' })
    )
  })
})

describe('buildGraph — only the handles a layout needs (P2-8)', () => {
  test('no sources: framing feeds the converge node from a single centre handle', () => {
    const g = buildGraph({ ...base, answerConfidence: 'low' }, t, planFan(DESKTOP_W, 0), [])
    expect(framingHandles(g)).toEqual(['c-bottom'])
    expect(targetHandles(g, 'findings')).toEqual(['c-top'])
    expect(g.edges).toContainEqual(
      expect.objectContaining({ source: 'framing', target: 'findings', sourceHandle: 'c-bottom' })
    )
  })

  test('every node declares its full handle set, whatever the turn is missing', () => {
    // REGRESSION: handles used to be conditional — the framing card of a turn
    // with nothing streamed yet had NO source handle, and the assessment grew
    // its bottom handle only once a branches prompt existed. React Flow measures
    // handle bounds when the node element is measured and re-measures only on a
    // RESIZE, so a handle added to a node already on screen never gets bounds
    // and `getEdgePosition` drops every edge on it: the connectors vanished
    // unless some other change happened to resize the node in the same tick.
    // The anchors are 1x1 and invisible, so carrying them always costs nothing.
    const bare = buildGraph({ ...base, live: true }, t, planFan(DESKTOP_W, 0), [])
    expect(framingHandles(bare)).toEqual(['c-bottom'])

    const streamed = buildGraph({ ...base, live: true }, t, planFan(DESKTOP_W, 1), [card('a')])
    expect(framingHandles(streamed)).toEqual(framingHandles(bare))

    // The assessment keeps its bottom anchor with and without branches, so a
    // prompt arriving under a settled assessment still draws its connector.
    const noBranches = buildGraph({ ...base, answerConfidence: 'high' }, t, planFan(DESKTOP_W, 1), [card('a')])
    const withBranches = buildGraph(
      {
        ...base,
        answerConfidence: 'high',
        choicePrompt: { promptId: 'p', text: 'weiter?', options: ['A'], isResponded: false },
      },
      t,
      planFan(DESKTOP_W, 1),
      [card('a')]
    )
    const bottomHandle = (g: ReturnType<typeof buildGraph>) =>
      (g.nodes.find((n) => n.id === 'findings')!.data as { source: { id: string; left: string } }).source
    expect(bottomHandle(noBranches)).toEqual({ id: 'out', left: '50%' })
    expect(bottomHandle(withBranches)).toEqual(bottomHandle(noBranches))

    // Same for the branches node: one centred target, whether it is the fan-in
    // point itself or merely fed by the assessment.
    const branchesOnly = buildGraph(
      {
        ...base,
        choicePrompt: { promptId: 'p', text: 'weiter?', options: ['A'], isResponded: false },
      },
      t,
      planFan(DESKTOP_W, 1),
      [card('a')]
    )
    expect(targetHandles(branchesOnly, 'branches')).toEqual(targetHandles(withBranches, 'branches'))
  })

  test('every edge lands on a handle its node actually declares', () => {
    // The invariant behind the regression above, asserted directly across the
    // shapes a turn passes through: an edge referencing a handle the node does
    // not render is an edge React Flow silently refuses to draw.
    const declared = (g: ReturnType<typeof buildGraph>, id: string) => {
      const d = g.nodes.find((n) => n.id === id)!.data as {
        sources?: Array<{ id: string }>
        targets?: Array<{ id: string }>
        source?: { id: string }
      }
      return new Set([
        ...(d.sources ?? []).map((h) => h.id),
        ...(d.targets ?? []).map((h) => h.id),
        ...(d.source ? [d.source.id] : []),
        // Column nodes render their two anchors directly, not via node data.
        ...(id.startsWith('col-') ? ['in', 'out'] : []),
      ])
    }
    const shapes: ReasoningFlowProps[] = [
      { ...base, live: true },
      { ...base, live: true },
      { ...base, answerConfidence: 'high' },
      { ...base, choicePrompt: { promptId: 'p', text: '?', options: ['A'], isResponded: false } },
      {
        ...base,
        answerConfidence: 'high',
        choicePrompt: { promptId: 'p', text: '?', options: ['A'], isResponded: false },
      },
    ]
    for (const props of shapes) {
      for (const n of [0, 1, 5]) {
        const cards = Array.from({ length: n }, (_, i) => card(`s${i}`))
        const g = buildGraph(props, t, planFan(DESKTOP_W, n), cards)
        for (const e of g.edges) {
          expect(declared(g, e.source)).toContain(e.sourceHandle!)
          expect(declared(g, e.target)).toContain(e.targetHandle!)
        }
      }
    }
  })
})

describe('buildGraph — a card animates once, not once per re-pack', () => {
  test('only cards in enterOrder carry a cascade slot, and it starts at 0 per batch', () => {
    // The fan re-packs on every card-count change, which moves cards between
    // column NODES; React remounts them there and the CSS entrance replays. The
    // columns therefore animate by card IDENTITY: `enterOrder` holds only the
    // cards that have never entered, numbered from 0 within that batch.
    const cards = [card('a'), card('b'), card('c')]
    const fresh = buildGraph({ ...base, answerConfidence: 'high' }, t, planFan(DESKTOP_W, 3), cards, new Map([['c', 0]]))
    const orders = fresh.nodes
      .filter((n) => n.type === 'sourceColumn')
      .map((n) => (n.data as unknown as { enterOrder: ReadonlyMap<string, number> }).enterOrder)
    // Every column reads the same map, so a card's slot does not depend on
    // which column the re-pack happened to put it in.
    for (const o of orders) expect(o.get('c')).toBe(0)
    for (const o of orders) expect(o.has('a')).toBe(false)
  })

  test('a graph built without an enterOrder animates nothing', () => {
    const g = buildGraph({ ...base, answerConfidence: 'high' }, t, planFan(DESKTOP_W, 2), [card('a'), card('b')])
    const order = (g.nodes.find((n) => n.type === 'sourceColumn')!.data as unknown as {
      enterOrder: ReadonlyMap<string, number>
    }).enterOrder
    expect(order.size).toBe(0)
  })
})
