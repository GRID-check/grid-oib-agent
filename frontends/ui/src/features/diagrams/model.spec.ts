/**
 * The parser's database read into a model, with the database written by hand.
 *
 * `parse-mermaid.spec.ts` runs mermaid for real; this covers what the test DOM
 * cannot reproduce. Mermaid sanitises a label with DOMPurify, and under
 * happy-dom that drops the text before a tag, so a label with markup arrives
 * here in a shape no browser produces. The shape below is the browser's.
 */
import { describe, expect, it } from 'vitest'

import { flowFromFlowchart, plainLabel } from './model'

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
    const model = flowFromFlowchart(flowchart('Zeile1<br/>Zeile2 <b>fett</b>'), 'flowchart TD')
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
    expect(flowFromFlowchart(flowchart('<img src="x">'), 'flowchart TD')).toBeNull()
    expect(flowFromFlowchart(flowchart('**fett**', 'markdown'), 'flowchart TD')).toBeNull()
  })
})
