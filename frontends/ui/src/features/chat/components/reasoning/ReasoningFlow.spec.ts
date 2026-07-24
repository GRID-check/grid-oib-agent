import { describe, test, expect } from 'vitest'
import { buildGraph, naturalWidth, type ReasoningFlowProps } from './ReasoningFlow'
import type { TraceSourceCard } from '../../lib/trace-lanes'
import type { Translator } from '@/i18n'

// Identity translator — the graph structure (nodes/edges/handles) is what these
// regression tests assert, not the copy, so echoing the key is enough.
const t = ((key: string) => key) as unknown as Translator

const card = (id: string): TraceSourceCard => ({
  id,
  laneKey: id,
  tabLabel: id,
  signal: 'law',
  name: id,
  hitCount: 1,
  kind: 'hit',
})

const base: ReasoningFlowProps = { steps: [], userQuestion: 'Frage?' }

/** Handle ids a framing node exposes (its bottom/source handles). */
const framingHandles = (g: ReturnType<typeof buildGraph>): string[] =>
  ((g.nodes.find((n) => n.id === 'framing')!.data as { sources: Array<{ id: string }> }).sources).map((h) => h.id)

/** Target handle ids a converge node exposes (its top handles). */
const targetHandles = (g: ReturnType<typeof buildGraph>, id: string): string[] =>
  ((g.nodes.find((n) => n.id === id)!.data as { targets: Array<{ id: string }> }).targets).map((h) => h.id)

const sourceToSourceEdges = (g: ReturnType<typeof buildGraph>) =>
  g.edges.filter((e) => e.source.startsWith('src-') && e.target.startsWith('src-'))

describe('buildGraph — parallel wiring (P1-4)', () => {
  test('horizontal: framing fans out to every source, each source converges — never a chain', () => {
    const g = buildGraph({ ...base, answerConfidence: 'high' }, t, false, [card('a'), card('b'), card('c')])

    // framing → each source (per-source aligned handles), each source → findings.
    expect(framingHandles(g)).toEqual(['to-src-a', 'to-src-b', 'to-src-c'])
    for (const sid of ['src-a', 'src-b', 'src-c']) {
      expect(g.edges).toContainEqual(expect.objectContaining({ source: 'framing', target: sid }))
      expect(g.edges).toContainEqual(expect.objectContaining({ source: sid, target: 'findings' }))
    }
    // The bug was framing→src1→src2→…: there must be NO source→source edge.
    expect(sourceToSourceEdges(g)).toHaveLength(0)
  })

  test('vertical (mobile): sources stay parallel — fan from framing centre, no source→source chain', () => {
    const g = buildGraph({ ...base, answerConfidence: 'high' }, t, true, [card('a'), card('b')])

    // On mobile the framing node fans out from a single centre handle to BOTH
    // sources (parallel), and every source is its own row (a readable column).
    expect(framingHandles(g)).toEqual(['c-bottom'])
    expect(g.edges.filter((e) => e.source === 'framing' && e.sourceHandle === 'c-bottom')).toHaveLength(2)
    expect(sourceToSourceEdges(g)).toHaveLength(0)
    expect(g.rows).toEqual([['framing'], ['src-a'], ['src-b'], ['findings']])
  })
})

describe('buildGraph — fan-in never collapses onto one handle (P1-5)', () => {
  test('choice prompt without findings: sources fan IN to the branches node via per-source handles', () => {
    const g = buildGraph(
      {
        ...base,
        choicePrompt: { promptId: 'p', text: 'weiter?', options: ['A', 'B'], isResponded: false },
      },
      t,
      false,
      [card('a'), card('b')]
    )

    expect(g.nodes.find((n) => n.id === 'findings')).toBeUndefined()
    // Each source lands on its OWN target handle on the branches node.
    expect(targetHandles(g, 'branches')).toEqual(['from-src-a', 'from-src-b'])
    expect(g.edges).toContainEqual(
      expect.objectContaining({ source: 'src-a', target: 'branches', targetHandle: 'from-src-a' })
    )
    expect(g.edges).toContainEqual(
      expect.objectContaining({ source: 'src-b', target: 'branches', targetHandle: 'from-src-b' })
    )
  })

  test('findings + branches: sources fan into findings, findings feeds branches on a single centre handle', () => {
    const g = buildGraph(
      {
        ...base,
        answerConfidence: 'medium',
        choicePrompt: { promptId: 'p', text: 'weiter?', options: ['A'], isResponded: false },
      },
      t,
      false,
      [card('a'), card('b')]
    )

    expect(targetHandles(g, 'findings')).toEqual(['from-src-a', 'from-src-b'])
    expect(targetHandles(g, 'branches')).toEqual(['c-top'])
    expect(g.edges).toContainEqual(
      expect.objectContaining({ source: 'findings', target: 'branches', targetHandle: 'c-top' })
    )
  })
})

describe('buildGraph — only the handles an orientation needs (P2-8)', () => {
  test('no sources: framing feeds the converge node from a single centre handle', () => {
    const g = buildGraph({ ...base, answerConfidence: 'low' }, t, false, [])
    expect(framingHandles(g)).toEqual(['c-bottom'])
    expect(targetHandles(g, 'findings')).toEqual(['c-top'])
    expect(g.edges).toContainEqual(
      expect.objectContaining({ source: 'framing', target: 'findings', sourceHandle: 'c-bottom' })
    )
  })

  test('findings without branches carries no dangling bottom (source) handle', () => {
    const g = buildGraph({ ...base, answerConfidence: 'high' }, t, false, [card('a')])
    const findings = g.nodes.find((n) => n.id === 'findings')!.data as { source?: unknown }
    expect(findings.source).toBeUndefined()
  })
})

describe('naturalWidth', () => {
  test('never below the banner width; grows with the source count', () => {
    expect(naturalWidth(0)).toBe(460)
    expect(naturalWidth(1)).toBe(460)
    expect(naturalWidth(4)).toBeGreaterThan(naturalWidth(2))
  })
})
