/**
 * Mermaid's own parser, read into this product's models — nothing mocked.
 *
 * The parser's database is an internal shape of a dependency, so these are the
 * tests that notice when a mermaid upgrade moves it: each grammar the prompt
 * teaches, parsed for real, must come out as the model its view draws.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_GRAPH_NODES } from './model'
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

  it.each([
    ['plain', 'flowchart LR\n  A --> B'],
    ['after frontmatter', '---\ntitle: Verfahren\n---\nflowchart LR\n  A --> B'],
    ['after an init directive', '%%{init: {"theme":"base"}}%%\nflowchart LR\n  A --> B'],
    ['after a comment', '%% Ablauf\nflowchart RL\n  A --> B'],
  ])('reads a left-to-right flowchart as such (%s)', async (_, source) => {
    const model = await parseMermaid(source)
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

describe('parseMermaid, in a time zone east of Greenwich', () => {
  // Mermaid reads `2026-10-01` as LOCAL midnight; in Vienna that instant is
  // still 30 September in UTC. CI runs in UTC, where the two agree, so the
  // zone is set here rather than left to the machine: this is the reader's.
  const zone = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'Europe/Vienna'
  })
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  })

  it('keeps the calendar date the source wrote', async () => {
    expect(new Date(2026, 9, 1).getTimezoneOffset()).not.toBe(0)
    const model = await parseMermaid('gantt\n  dateFormat YYYY-MM-DD\n  section Verfahren\n  Vorprüfung :a1, 2026-10-01, 14d')
    expect(model?.kind === 'schedule' && model.sections[0].tasks[0]).toMatchObject({ start: '2026-10-01', end: '2026-10-15' })
  }, PARSE_BUDGET)
})

describe('what mermaid writes into a label', () => {
  it('decodes its entity syntax instead of printing the placeholders', async () => {
    const model = await parseMermaid('flowchart TD\n  A["Sag #quot;ja#quot; #amp; #35;4"] --> B')
    expect(model?.kind === 'flow' && model.nodes[0].label).toBe('Sag "ja" & #4')
  }, PARSE_BUDGET)

  it('leaves a flowchart with a subgraph to mermaid', async () => {
    expect(await parseMermaid('flowchart TD\n  subgraph S [Gruppe]\n    A --> B\n  end\n  B --> C')).toBeNull()
  }, PARSE_BUDGET)

  it(`leaves a graph of more than ${MAX_GRAPH_NODES} nodes to mermaid`, async () => {
    const chain = (n: number) => Array.from({ length: n - 1 }, (_, i) => `  N${i} --> N${i + 1}`).join('\n')
    expect(await parseMermaid(`flowchart TD\n${chain(MAX_GRAPH_NODES)}`)).not.toBeNull()
    expect(await parseMermaid(`flowchart TD\n${chain(MAX_GRAPH_NODES + 1)}`)).toBeNull()
  }, PARSE_BUDGET)
})

describe('a state diagram', () => {
  it('draws only [*] as a point, whatever the states are called', async () => {
    const model = await parseMermaid('stateDiagram-v2\n  [*] --> start\n  start --> Prüfung_end\n  Prüfung_end --> end\n  end --> [*]')
    if (model?.kind !== 'flow') throw new Error('expected a flow')
    expect(model.nodes.filter((n) => n.shape === 'point')).toHaveLength(2)
    expect(model.nodes.filter((n) => n.shape === 'step').map((n) => n.label)).toEqual(['start', 'Prüfung_end', 'end'])
  }, PARSE_BUDGET)

  it('labels a state by its description', async () => {
    const model = await parseMermaid('stateDiagram-v2\n  state "Lange Bezeichnung" as L\n  [*] --> L\n  L --> [*]')
    expect(model?.kind === 'flow' && model.nodes.find((n) => n.id === 'L')?.label).toBe('Lange Bezeichnung')
  }, PARSE_BUDGET)

  it('leaves a composite state to mermaid rather than lose what is inside it', async () => {
    const source = 'stateDiagram-v2\n  [*] --> Verfahren\n  state Verfahren {\n    [*] --> Vorprüfung\n    Vorprüfung --> [*]\n  }\n  Verfahren --> [*]'
    expect(await parseMermaid(source)).toBeNull()
  }, PARSE_BUDGET)
})

describe('a sequence', () => {
  it('reads every one-way dotted arrow as a reply, and a two-way one as none', async () => {
    const model = await parseMermaid(
      'sequenceDiagram\n  A->>B: frage\n  B-->A: a\n  B--)A: b\n  B--xA: c\n  B-->>A: d\n  A-)B: e\n  B--|\\A: f\n  B/|--A: g\n  A<<-->>B: h\n  A-|\\B: i'
    )
    expect(model?.kind === 'handoff' && model.steps.map((step) => [step.label, step.reply])).toEqual([
      ['frage', false],
      ['a', true],
      ['b', true],
      ['c', true],
      ['d', true],
      ['e', false],
      ['f', true],
      ['g', true],
      ['h', false],
      ['i', false],
    ])
  }, PARSE_BUDGET)
})

