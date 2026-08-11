import { describe, expect, it } from 'vitest'
import { renderSkillDocument, renderSkillDocumentParts } from './skill-document'

describe('renderSkillDocument', () => {
  it('renders the minimal document the spec requires', () => {
    expect(
      renderSkillDocument({
        name: 'oib-brandschutz',
        description: 'Prüft Brandschutz nach OIB-RL 2.',
        body: '# Brandschutz\n\nSchritt eins.',
      }),
    ).toBe(
      [
        '---',
        'name: oib-brandschutz',
        'description: Prüft Brandschutz nach OIB-RL 2.',
        '---',
        '',
        '# Brandschutz',
        '',
        'Schritt eins.',
        '',
      ].join('\n'),
    )
  })

  it('emits metadata sorted, so one skill never renders two documents', () => {
    const document = renderSkillDocument({
      name: 'x',
      description: 'd',
      body: 'b',
      metadata: { 'grid-schedulable': 'false', 'grid-execution': 'chat' },
    })
    expect(document).toContain('metadata:\n  grid-execution: chat\n  grid-schedulable: "false"')
  })

  it('quotes values that would otherwise read back as another type', () => {
    const { frontmatter } = renderSkillDocumentParts({
      name: 'x',
      description: 'd',
      body: '',
      metadata: { flag: 'false', count: '12', word: 'chat', empty: '' },
    })
    // `false` and `12` would come back as a boolean and a number.
    expect(frontmatter).toContain('flag: "false"')
    expect(frontmatter).toContain('count: "12"')
    expect(frontmatter).toContain('empty: ""')
    // …but an ordinary word stays bare, so the document reads as hand-written.
    expect(frontmatter).toContain('word: chat')
  })

  it('quotes a value carrying YAML-significant punctuation', () => {
    const { frontmatter } = renderSkillDocumentParts({
      name: 'x',
      description: 'd',
      body: '',
      metadata: { note: 'a: b', list: '[1,2]' },
    })
    expect(frontmatter).toContain('note: "a: b"')
    expect(frontmatter).toContain('list: "[1,2]"')
  })

  it('folds a long description the way the shipped skills are written', () => {
    const description =
      'Use this skill when the request concerns fire safety under OIB-Richtlinie 2, ' +
      'including escape routes, fire compartments and cladding requirements for the project at hand.'
    const { frontmatter } = renderSkillDocumentParts({ name: 'x', description, body: '' })

    expect(frontmatter).toContain('description: >-')
    // Every wrapped line is indented under the key, and no word was lost.
    const folded = frontmatter.split('description: >-\n')[1].split('\n---')[0]
    expect(folded.split('\n').every((line) => line.startsWith('  '))).toBe(true)
    expect(folded.replace(/\s+/g, ' ').trim()).toBe(description)
  })

  it('splits at the seam progressive disclosure cares about', () => {
    const { frontmatter, body } = renderSkillDocumentParts({
      name: 'x',
      description: 'd',
      body: '  # Title\n\ninstructions  ',
    })
    // Level 1: always in context.
    expect(frontmatter.startsWith('---')).toBe(true)
    expect(frontmatter.endsWith('---')).toBe(true)
    // Level 2: loaded only on activation, trimmed of authoring whitespace.
    expect(body).toBe('# Title\n\ninstructions')
  })

  it('is deterministic — the preview IS what gets stored', () => {
    const input = {
      name: 'oib-brandschutz',
      description: 'Prüft Brandschutz.',
      body: 'Schritte',
      metadata: { 'grid-execution': 'chat' },
    }
    expect(renderSkillDocument(input)).toBe(renderSkillDocument(input))
  })

  it('omits the body section entirely when there is no body yet', () => {
    expect(renderSkillDocument({ name: 'x', description: 'd', body: '   ' })).toBe(
      '---\nname: x\ndescription: d\n---\n',
    )
  })
})
