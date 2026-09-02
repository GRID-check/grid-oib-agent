/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { buildGraph, planFan, type ReasoningFlowProps } from './ReasoningFlow'
import type { CitedDocument } from '../../lib/citations'
import type { ThinkingStep } from '../../types'
import { de, en } from '@/i18n/dictionaries'
import { createTranslator, getByPath } from '@/i18n/translate'
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

describe('a turn that was CUT OFF says so where the fan converges', () => {
  const budgetStep = (tools: string[]) => ({
    id: 's-budget',
    userMessageId: 'u1',
    category: 'tools' as const,
    functionName: 'status:budget',
    displayName: 'status:budget',
    content: JSON.stringify({
      kind: 'status',
      channel: 'technical',
      slot: 'budget',
      truncated: true,
      tools,
    }),
    timestamp: new Date(),
    isComplete: true,
  })

  const findings = (g: ReturnType<typeof buildGraph>) =>
    g.nodes.find((n) => n.id === 'findings')?.data as
      | { truncation?: { before: string; step?: string; after: string; mono: boolean } }
      | undefined

  test('a truncated turn with nothing found still gets an assessment node', () => {
    // The worst case: cut off before it found anything. Without this the graph
    // simply stops after the framing card with nothing anywhere saying why.
    const props: ReasoningFlowProps = { ...base, steps: [budgetStep(['knowledge_search'])] }
    const g = buildGraph(props, t, planFan(DESKTOP_W, 0), [], new Map())
    expect(g.nodes.find((n) => n.id === 'findings')).toBeDefined()
    expect(findings(g)?.truncation?.step).toBe('thinking.stepName.corpus')
  })

  test('a tool with no reader-facing name is shown as the identifier it is', () => {
    // `light_incidence` matches no naming rule. Title-casing it into "Light
    // Incidence" would dress an identifier as a noun — the one thing this trace
    // must not invent — so it renders verbatim, in mono.
    const props: ReasoningFlowProps = {
      ...base,
      steps: [budgetStep(['use_skill', 'find_elements', 'light_incidence'])],
    }
    const g = buildGraph(props, t, planFan(DESKTOP_W, 0), [], new Map())
    expect(findings(g)?.truncation).toMatchObject({ step: 'light_incidence', mono: true })
  })

  test('truncated with no tool named falls back to saying less', () => {
    const props: ReasoningFlowProps = { ...base, steps: [budgetStep([])] }
    const g = buildGraph(props, t, planFan(DESKTOP_W, 0), [], new Map())
    expect(findings(g)?.truncation).toEqual({
      before: 'thinking.node.findingsTruncated',
      after: '',
      mono: false,
    })
  })

  test('a turn that finished its research carries no truncation line', () => {
    const props: ReasoningFlowProps = { ...base, answerConfidence: 'high' }
    const g = buildGraph(props, t, planFan(DESKTOP_W, 0), [], new Map())
    expect(findings(g)?.truncation).toBeUndefined()
  })

  test('while the turn is still live the graph claims nothing about the ending', () => {
    const props: ReasoningFlowProps = { ...base, steps: [budgetStep(['knowledge_search'])], live: true }
    const g = buildGraph(props, t, planFan(DESKTOP_W, 0), [], new Map())
    expect(findings(g)?.truncation).toBeUndefined()
  })
})

/**
 * A deep run that ran out of clock, and an answer that shipped ungrounded.
 *
 * Both arrive as technical-channel records the reader would otherwise never
 * meet: before this the answer of a run cut off after two of ten planned
 * searches was indistinguishable from a complete one. The assessment node is
 * where they belong, because it is the node that already answers "what was this
 * built on?" — and "less than it looks like" is an answer to that question.
 */
describe('a deep run that was cut off or degraded says so under the assessment', () => {
  const statusStep = (id: string, slot: string, payload: Record<string, unknown>): ThinkingStep => ({
    id,
    userMessageId: 'u1',
    category: 'tools' as const,
    functionName: `status:${slot}`,
    displayName: `status:${slot}`,
    content: JSON.stringify({ kind: 'status', channel: 'technical', slot, ...payload }),
    timestamp: new Date(),
    isComplete: true,
  })

  const cutoffStep = (payload: Record<string, unknown>) =>
    statusStep('s-deep', 'budget:deep', { truncated: true, agent: 'deep', ...payload })
  const degradedStep = (reasons: string[]) =>
    statusStep('s-degraded', 'degraded', { degraded: true, agent: 'deep', reasons })

  const limits = (g: ReturnType<typeof buildGraph>) =>
    (g.nodes.find((n) => n.id === 'findings')?.data as
      | { limits?: { label: string; lines: Array<{ text: string; warn: boolean }> } }
      | undefined)?.limits

  const build = (steps: ThinkingStep[], translator: Translator = t) =>
    buildGraph({ ...base, steps }, translator, planFan(DESKTOP_W, 0), [], new Map())

  test('a cut-off turn with no verdict and no sources still gets an assessment node', () => {
    // Same case the truncation line exists for, reached down the other road: a
    // deep run that died on the clock before producing anything would otherwise
    // be a graph that just stops after the framing card.
    const g = build([cutoffStep({ reason: 'wall_clock', salvaged: false, source_count: 0, report_chars: 0 })])
    expect(g.nodes.find((n) => n.id === 'findings')).toBeDefined()
    expect(limits(g)?.lines[0]).toEqual({
      text: 'thinking.node.limits.deepCutoff.time thinking.node.limits.deepCutoff.nothing',
      warn: false,
    })
  })

  test('the cause and its consequence are one statement; what was gathered is the next', () => {
    const g = build([
      cutoffStep({ reason: 'step_limit', salvaged: true, source_count: 12, report_chars: 4210, elapsed_seconds: 486 }),
    ])
    expect(limits(g)?.lines.map((l) => l.text)).toEqual([
      'thinking.node.limits.deepCutoff.steps thinking.node.limits.deepCutoff.salvaged',
      'thinking.node.limits.deepCutoff.sources thinking.node.limits.deepCutoff.after',
    ])
  })

  test('nothing worth counting is left unsaid rather than counted to zero', () => {
    // "0 Quellen" is a true number that reads as a verdict, and a run cut off
    // after forty seconds did not stop "after 0 minutes".
    const g = build([cutoffStep({ reason: 'wall_clock', salvaged: false, source_count: 0, elapsed_seconds: 41 })])
    expect(limits(g)?.lines).toHaveLength(1)
  })

  test('an unknown cutoff reason still earns the shorter true sentence', () => {
    const g = build([cutoffStep({ reason: 'quota_exhausted', salvaged: true })])
    expect(limits(g)?.lines[0]?.text).toContain('thinking.node.limits.deepCutoff.other')
  })

  test('a degraded answer is marked as one the reader should check', () => {
    const g = build([degradedStep(['no_report_file', 'no_valid_citations', 'cards_generation_failed'])])
    expect(limits(g)?.lines).toEqual([
      { text: 'thinking.node.limits.degraded.noReport', warn: true },
      { text: 'thinking.node.limits.degraded.noCitations', warn: true },
      { text: 'thinking.node.limits.degraded.noCards', warn: true },
    ])
  })

  test('cut off AND degraded reads as one block, cause first', () => {
    const g = build([
      cutoffStep({ reason: 'wall_clock', salvaged: true, source_count: 3 }),
      degradedStep(['no_valid_citations']),
    ])
    expect(limits(g)?.lines.map((l) => l.warn)).toEqual([false, false, true])
  })

  test('a clean turn carries no limits block — there is no "all clear" row', () => {
    // Presence is the fact. A row saying nothing went wrong would be true on
    // almost every turn, which makes it a constant rather than an event.
    const g = buildGraph({ ...base, answerConfidence: 'high' }, t, planFan(DESKTOP_W, 0), [], new Map())
    expect(limits(g)).toBeUndefined()
  })

  test('while the turn is still live the graph claims nothing about the answer', () => {
    const g = buildGraph(
      { ...base, steps: [degradedStep(['no_valid_citations'])], live: true },
      t,
      planFan(DESKTOP_W, 0),
      [],
      new Map()
    )
    expect(limits(g)).toBeUndefined()
  })

  test.each(['de', 'en'])('%s says all of it in words, never a dictionary path', (locale) => {
    // These keys are built from template literals, so `key-coverage.spec` — which
    // only sees fully-literal keys — cannot reach them. Every shape a cutoff can
    // take is rendered through the real dictionary instead, and a miss shows up
    // as the key itself, which is exactly what must never render.
    const translator = createTranslator(locale === 'de' ? de : en, 'chat') as Translator
    const shapes = [
      [cutoffStep({ reason: 'wall_clock', salvaged: true, source_count: 1, elapsed_seconds: 62 })],
      [cutoffStep({ reason: 'step_limit', salvaged: false, source_count: 9, elapsed_seconds: 900 })],
      [cutoffStep({ reason: 'quota_exhausted', salvaged: false })],
      [degradedStep(['no_report_file', 'no_valid_citations', 'cards_generation_failed'])],
    ]
    for (const steps of shapes) {
      const block = limits(build(steps, translator))
      expect(block).toBeDefined()
      expect(block!.label).not.toContain('thinking.')
      for (const line of block!.lines) {
        expect(line.text).not.toContain('thinking.')
        // A plural block that never resolved leaves its ICU syntax behind.
        expect(line.text).not.toContain('{')
        expect(line.text.trim().length).toBeGreaterThan(0)
      }
    }
  })

  test('the singular and the plural are both spelled, in both locales', () => {
    // `1 Quellen waren gesichtet` on a panel about rigour undercuts it.
    for (const dictionary of [de, en]) {
      const translator = createTranslator(dictionary, 'chat') as Translator
      const line = (count: number) =>
        limits(build([cutoffStep({ reason: 'wall_clock', salvaged: true, source_count: count })], translator))!
          .lines[1]!.text
      expect(line(1)).not.toEqual(line(4))
      expect(line(1)).toContain('1')
      expect(line(4)).toContain('4')
    }
  })

  test.each(['de', 'en'])('%s has a string for every limits key the node can ask for', (locale) => {
    const dictionary = locale === 'de' ? de : en
    const keys = [
      'label',
      ...['time', 'steps', 'other', 'salvaged', 'nothing', 'sources', 'after'].map(
        (k) => `deepCutoff.${k}`
      ),
      ...['noReport', 'noCitations'].map((k) => `degraded.${k}`),
    ]
    const missing = keys.filter(
      (key) => typeof getByPath(dictionary, `chat.thinking.node.limits.${key}`) !== 'string'
    )
    expect(missing).toEqual([])
  })
})
