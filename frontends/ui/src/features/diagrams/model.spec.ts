/**
 * The parser's database read into a model, with the database written by hand.
 *
 * `parse-mermaid.spec.ts` runs mermaid for real; this covers what the test DOM
 * cannot reproduce. Mermaid sanitises a label with DOMPurify, and under
 * happy-dom that drops the text before a tag, so a label with markup arrives
 * here in a shape no browser produces. The shape below is the browser's.
 */
import { describe, expect, it } from 'vitest'

import { flowFromFlowchart, flowFromState, handoffFromSequence, mapFromMindmap, plainLabel, scheduleFromGantt, sharesFromPie } from './model'

const flowchart = (text: string, labelType = 'string') => ({
  getVertices: () =>
    new Map([
      ['A', { id: 'A', text, labelType, type: 'square' }],
      ['B', { id: 'B', text: 'B' }],
    ]),
  getEdges: () => [{ start: 'A', end: 'B', text: '' }],
  getSubGraphs: () => [],
})

describe('a flowchart label', () => {
  it('is plain text: a line break kept, inline formatting dropped', () => {
    const model = flowFromFlowchart(flowchart('Zeile1<br/>Zeile2 <b>fett</b>'))
    expect(model?.nodes[0].label).toBe('Zeile1\nZeile2 fett')
  })

  it('reads every form of the break', () => {
    expect(plainLabel('a<br>b<BR />c<br/>d')).toBe('a\nb\nc\nd')
  })

  it('decodes mermaid’s own entity placeholders and the sanitiser’s entities', () => {
    expect(plainLabel('Sag ﬂ°quot¶ßjaﬂ°quot¶ß &amp; ﬂ°°35¶ß4 &lt;b&gt;')).toBe('Sag "ja" & #4 <b>')
  })

  it('is refused, and the diagram left to mermaid, when markup remains', () => {
    expect(plainLabel('siehe <a href="https://x.at">hier</a>')).toBeNull()
    expect(plainLabel('Maß ﬂ°unbekanntesEntity¶ß')).toBeNull()
    expect(flowFromFlowchart(flowchart('<img src="x">'))).toBeNull()
    expect(flowFromFlowchart(flowchart('**fett**', 'markdown'))).toBeNull()
  })
})

/** Each grammar's database, in the shape a browser's parser leaves it, with `label` wherever it keeps text. */
const grammars = {
  state: (label: string) =>
    flowFromState({
      getRelations: () => [{ id1: 'L', id2: 'E', relationTitle: label }],
      getStates: () => new Map([['L', { id: 'L', descriptions: [label] }], ['E', { id: 'E', descriptions: [] }]]),
    }),
  mindmap: (label: string) => mapFromMindmap({ getMindmap: () => ({ descr: label, children: [{ descr: label, children: [] }] }) }),
  sequence: (label: string) =>
    handoffFromSequence({
      getActors: () => new Map([['B', { name: 'B', description: label }], ['M', { name: 'M', description: 'M' }]]),
      getMessages: () => [{ from: 'B', to: 'M', message: label, type: 0 }],
    }),
  gantt: (label: string) =>
    scheduleFromGantt({ getTasks: () => [{ section: label, task: label, startTime: new Date(2026, 2, 28), endTime: new Date(2026, 2, 31) }] }),
  pie: (label: string) => sharesFromPie({ getSections: () => new Map([[label, 3]]), getDiagramTitle: () => label }),
}

describe.each(Object.entries(grammars))('a %s label', (_, read) => {
  it('is plain text, its line break kept', () => {
    const labels = JSON.stringify(read('Ein<br/>reichung')).match(/"(?:label|title)":"[^"]*"/g) ?? []
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) expect(label).not.toMatch(/<|>/)
    expect(labels.some((label) => label.includes('Ein\\nreichung'))).toBe(true)
  })

  it('leaves the diagram to mermaid when markup remains', () => {
    expect(read('<img src="x">')).toBeNull()
  })
})
