import { describe, expect, it } from 'vitest'
import { parseSkillDocument, renderSkillDocument, renderSkillDocumentParts } from './skill-document'

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

describe('parseSkillDocument', () => {
  const ok = (raw: string) => {
    const result = parseSkillDocument(raw)
    if (!result.ok) throw new Error(`expected a parse, got ${result.error}`)
    return result.value
  }

  it('round-trips everything the renderer emits', () => {
    // The pair is only useful if it is a pair: whatever the form renders, the
    // advanced section must be able to read back into the same fields.
    const input = {
      name: 'oib-brandschutz',
      description:
        'Prüft Bauteile und Fluchtwege gegen OIB-Richtlinie 2. Einsetzen, wenn ein Brandschutznachweis erstellt oder vor der Einreichung gegengeprüft werden soll.',
      body: '# Brandschutz\n\nSchritt eins.\n\n- a\n- b',
      metadata: { 'grid-execution': 'chat', 'grid-cards': 'summary,legal_basis' },
    }
    expect(ok(renderSkillDocument(input))).toEqual({ ...input, ignoredKeys: [] })
  })

  it('reads a hand-written document: quotes, folded blocks and a body with fences', () => {
    const value = ok(
      [
        '---',
        'name: "oib-check"',
        'description: >-',
        '  Checks the thing.',
        '  Use when somebody asks about the thing.',
        'metadata:',
        "  grid-execution: 'deep-research'",
        '---',
        '',
        'Body with a fence:',
        '',
        '```',
        'name: not-frontmatter',
        '```',
      ].join('\n'),
    )
    expect(value.name).toBe('oib-check')
    // A folded scalar is ONE string, not the lines it was wrapped onto.
    expect(value.description).toBe('Checks the thing. Use when somebody asks about the thing.')
    expect(value.metadata).toEqual({ 'grid-execution': 'deep-research' })
    // The `---` search stops at the first closing fence, so a body that talks
    // about frontmatter is body, not frontmatter.
    expect(value.body).toContain('name: not-frontmatter')
  })

  it('keeps a literal block scalar as lines', () => {
    const value = ok(['---', 'name: x', 'description: |', '  one', '  two', '---'].join('\n'))
    expect(value.description).toBe('one\ntwo')
  })

  it('names the keys it cannot store rather than dropping them in silence', () => {
    const value = ok(
      [
        '---',
        'name: x',
        'description: d',
        'license: MIT',
        'allowed-tools: Read Glob',
        '---',
      ].join('\n'),
    )
    expect(value.ignoredKeys).toEqual(['license', 'allowed-tools'])
  })

  it.each([
    ['no frontmatter at all', 'just prose', 'missing-frontmatter'],
    ['an unclosed block', '---\nname: x\ndescription: d', 'unterminated-frontmatter'],
    ['a nested structure', '---\nname: x\ndescription: d\ntools:\n  - Read\n---', 'malformed-frontmatter'],
    ['no name', '---\ndescription: d\n---', 'missing-name'],
    ['no description', '---\nname: x\n---', 'missing-description'],
  ])('refuses %s', (_label, raw, error) => {
    const result = parseSkillDocument(raw)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toBe(error)
  })

  it('tolerates a leading blank line and CRLF, which is what a paste brings', () => {
    const value = ok('\r\n---\r\nname: x\r\ndescription: d\r\n---\r\n\r\nbody\r\n')
    expect(value).toMatchObject({ name: 'x', description: 'd', body: 'body' })
  })
})
