/**
 * Mermaid's own parser, read into this product's models — nothing mocked.
 *
 * The parser's database is an internal shape of a dependency, so these are the
 * tests that notice when a mermaid upgrade moves it: each grammar the prompt
 * teaches, parsed for real, must come out as the model its view draws.
 */
import { describe, expect, it } from 'vitest'
import { parseMermaid } from './parse-mermaid'

const PARSE_BUDGET = 20_000

describe('parseMermaid', () => {
  it('reads a flowchart into steps, a decision, an end and labelled edges', async () => {
    const model = await parseMermaid(
      'flowchart TD\n  A["Einreichung"] --> B{"Vollständig?"}\n  B -->|nein| C["Verbesserung"]\n  C --> A\n  B -->|ja| D(["Bewilligung"])\n  L["Leitfaden"] -.->|erläutert| A'
    )
    expect(model?.kind).toBe('flow')
    if (model?.kind !== 'flow') return
    expect(model.direction).toBe('down')
    expect(model.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([
      ['A', 'Einreichung', 'step'],
      ['B', 'Vollständig?', 'decision'],
      ['C', 'Verbesserung', 'step'],
      ['D', 'Bewilligung', 'end'],
      ['L', 'Leitfaden', 'step'],
    ])
    expect(model.edges.find((e) => e.from === 'B' && e.to === 'C')?.label).toBe('nein')
    expect(model.edges.find((e) => e.from === 'L')?.dashed).toBe(true)
  }, PARSE_BUDGET)

  it('reads a left-to-right flowchart as such', async () => {
    const model = await parseMermaid('flowchart LR\n  A --> B')
    expect(model?.kind === 'flow' && model.direction).toBe('right')
  }, PARSE_BUDGET)

  it('reads a state diagram as a flow with its start and end as points', async () => {
    const model = await parseMermaid('stateDiagram-v2\n  [*] --> Eingereicht\n  Eingereicht --> Bewilligt: ok\n  Bewilligt --> [*]')
    expect(model?.kind).toBe('flow')
    if (model?.kind !== 'flow') return
    expect(model.nodes.filter((n) => n.shape === 'point')).toHaveLength(2)
    expect(model.edges.find((e) => e.label === 'ok')).toMatchObject({ from: 'Eingereicht', to: 'Bewilligt' })
  }, PARSE_BUDGET)

  it('reads a mindmap into a tree, root first', async () => {
    const model = await parseMermaid('mindmap\n  root((OIB-RL 2))\n    Allgemein\n      Tragfähigkeit\n    2.2 Garagen')
    expect(model?.kind).toBe('map')
    if (model?.kind !== 'map') return
    expect(model.root.label).toBe('OIB-RL 2')
    expect(model.root.children.map((c) => c.label)).toEqual(['Allgemein', '2.2 Garagen'])
    expect(model.root.children[0].children.map((c) => c.label)).toEqual(['Tragfähigkeit'])
  }, PARSE_BUDGET)

  it('reads a sequence into parties and hand-overs, replies marked', async () => {
    const model = await parseMermaid(
      'sequenceDiagram\n  participant B as Bauwerber\n  participant M as Baubehörde\n  B->>M: Einreichung\n  M-->>B: Bescheid'
    )
    expect(model).toEqual({
      kind: 'handoff',
      parties: [
        { id: 'B', label: 'Bauwerber' },
        { id: 'M', label: 'Baubehörde' },
      ],
      steps: [
        { from: 'B', to: 'M', label: 'Einreichung', reply: false },
        { from: 'M', to: 'B', label: 'Bescheid', reply: true },
      ],
    })
  }, PARSE_BUDGET)

  it('reads a gantt into sections of dated tasks and milestones', async () => {
    const model = await parseMermaid(
      'gantt\n  dateFormat YYYY-MM-DD\n  section Verfahren\n  Vorprüfung :a1, 2026-10-01, 14d\n  Bescheid :milestone, after a1, 0d'
    )
    expect(model).toEqual({
      kind: 'schedule',
      sections: [
        {
          label: 'Verfahren',
          tasks: [
            { label: 'Vorprüfung', start: '2026-10-01', end: '2026-10-15', milestone: false },
            { label: 'Bescheid', start: '2026-10-15', end: '2026-10-15', milestone: true },
          ],
        },
      ],
    })
  }, PARSE_BUDGET)

  it('reads a pie into shares with its title', async () => {
    const model = await parseMermaid('pie title Nutzfläche\n  "Wohnen" : 62\n  "Büro" : 25')
    expect(model).toEqual({
      kind: 'shares',
      title: 'Nutzfläche',
      items: [
        { label: 'Wohnen', value: 62 },
        { label: 'Büro', value: 25 },
      ],
    })
  }, PARSE_BUDGET)

  it('answers null for a source the parser refuses, and for a grammar with no view', async () => {
    expect(await parseMermaid('flowchart TD\n  A -->')).toBeNull()
    expect(await parseMermaid('journey\n  title Einreichung\n  section Planung\n    Pläne: 3: Planer')).toBeNull()
  }, PARSE_BUDGET)
})
