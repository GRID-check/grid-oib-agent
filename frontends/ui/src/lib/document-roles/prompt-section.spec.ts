/**
 * What the agent is told about a project's documents.
 *
 * The missing half is the point. An agent cannot notice the absence of a line,
 * so a Bebauungsplan that was never attached has to be named as missing or the
 * answer reads as though the plan had been consulted.
 */
import { describe, expect, it } from 'vitest'
import { buildDocumentRolesSection } from './prompt-section'
import type { PromptRoleBinding } from './prompt-section'

function bound(overrides: Partial<PromptRoleBinding> = {}): PromptRoleBinding {
  return {
    role: 'bebauungsplan',
    scopeInstanceId: null,
    confidence: 'declared',
    filename: 'bplan.pdf',
    displayName: null,
    ...overrides,
  }
}

describe('buildDocumentRolesSection', () => {
  it('says nothing when there is nothing to say', () => {
    expect(buildDocumentRolesSection([], [])).toBe('')
  })

  it('names the document that holds a role', () => {
    expect(buildDocumentRolesSection([bound()])).toContain('- Bebauungsplan: bplan.pdf')
  })

  it('prefers the display name a person set over the filename', () => {
    const section = buildDocumentRolesSection([bound({ displayName: 'B-Plan 7/2024' })])
    expect(section).toContain('B-Plan 7/2024')
    expect(section).not.toContain('bplan.pdf')
  })

  it('marks an unconfirmed suggestion so the agent does not treat it as fact', () => {
    expect(buildDocumentRolesSection([bound({ confidence: 'suggested' })])).toContain(
      '[nicht bestätigt]'
    )
  })

  it('names a missing role explicitly rather than leaving it to be inferred', () => {
    const section = buildDocumentRolesSection(
      [],
      [{ role: 'bebauungsplan', scopeInstanceId: null }]
    )
    expect(section).toContain('documents_missing:')
    expect(section).toContain('- Bebauungsplan')
  })

  it('stops reporting a role as missing once it is bound', () => {
    const section = buildDocumentRolesSection(
      [bound()],
      [{ role: 'bebauungsplan', scopeInstanceId: null }]
    )
    expect(section).not.toContain('documents_missing:')
  })

  it('leaves an unrecommended, unbound role out entirely', () => {
    // Every role is offerable, but telling the agent that a project with no
    // demolition lacks a Schadstoffgutachten costs tokens on every turn.
    const section = buildDocumentRolesSection(
      [bound()],
      [{ role: 'bebauungsplan', scopeInstanceId: null }]
    )
    expect(section).not.toContain('Schadstoffgutachten')
  })

  it('says which building a scoped role belongs to, by name', () => {
    const section = buildDocumentRolesSection(
      [bound({ role: 'bestandsplan', scopeInstanceId: 'bw2', filename: 'eg.pdf' })],
      [],
      { bw2: 'Hoftrakt' }
    )
    expect(section).toContain('(Hoftrakt)')
  })

  it('falls back to the id when a building has no name', () => {
    const section = buildDocumentRolesSection(
      [bound({ role: 'bestandsplan', scopeInstanceId: 'bw2' })],
      []
    )
    expect(section).toContain('(bw2)')
  })

  it('collapses a slot holding many documents to a count, not a list', () => {
    // The scaling property: a project with 1000 bound plan sheets must not emit
    // 1000 lines into every prompt template on every turn.
    const sheets = Array.from({ length: 47 }, (_, index) =>
      bound({ role: 'bestandsplan', scopeInstanceId: 'bw1', filename: `blatt-${index}.pdf` })
    )
    const section = buildDocumentRolesSection(sheets, [], { bw1: 'Hoftrakt' })
    expect(section).toContain('- Bestandspläne (Hoftrakt): 47 Dokumente')
    expect(section).not.toContain('blatt-0.pdf')
    expect(section.split('\n')).toHaveLength(2)
  })

  it('stays the same size whether the project has three files or a thousand', () => {
    const small = buildDocumentRolesSection(
      [
        bound({ role: 'bestandsplan', scopeInstanceId: 'bw1' }),
        bound({ role: 'bestandsplan', scopeInstanceId: 'bw1' }),
      ],
      []
    )
    const huge = buildDocumentRolesSection(
      Array.from({ length: 1000 }, () => bound({ role: 'bestandsplan', scopeInstanceId: 'bw1' })),
      []
    )
    expect(huge.split('\n')).toHaveLength(small.split('\n').length)
  })

  it('names the document when a slot holds exactly one', () => {
    const section = buildDocumentRolesSection([bound({ role: 'lageplan', filename: 'lage.pdf' })])
    expect(section).toContain('- Lageplan: lage.pdf')
  })

  it('reports how many of a multi-document slot are unconfirmed', () => {
    const section = buildDocumentRolesSection([
      bound({ role: 'bestandsplan', scopeInstanceId: 'bw1' }),
      bound({ role: 'bestandsplan', scopeInstanceId: 'bw1', confidence: 'suggested' }),
    ])
    expect(section).toContain('2 Dokumente, 1 davon nicht bestätigt')
  })

  it('keeps one building separate from another', () => {
    const section = buildDocumentRolesSection(
      [
        bound({ role: 'bestandsplan', scopeInstanceId: 'bw1' }),
        bound({ role: 'bestandsplan', scopeInstanceId: 'bw2' }),
      ],
      [],
      { bw1: 'Hoftrakt', bw2: 'Straßentrakt' }
    )
    expect(section).toContain('(Hoftrakt): ')
    expect(section).toContain('(Straßentrakt): ')
  })

  it('renders in registry order so the block is stable between turns', () => {
    // An unstable block churns the prompt cache for no benefit.
    const section = buildDocumentRolesSection([
      bound({ role: 'lageplan', filename: 'lage.pdf' }),
      bound({ role: 'bebauungsplan', filename: 'bplan.pdf' }),
    ])
    expect(section.indexOf('bplan.pdf')).toBeLessThan(section.indexOf('lage.pdf'))
  })
})

describe('buildDocumentRolesSection — a recommendation is per scope instance', () => {
  const plan = (bauwerkId: string): PromptRoleBinding => ({
    role: 'bestandsplan',
    scopeInstanceId: bauwerkId,
    confidence: 'declared',
    filename: `bestand-${bauwerkId}.pdf`,
    displayName: null,
  })

  it('still reports the second building when only the first is covered', () => {
    const section = buildDocumentRolesSection(
      [plan('bw1')],
      [
        { role: 'bestandsplan', scopeInstanceId: 'bw1' },
        { role: 'bestandsplan', scopeInstanceId: 'bw2' },
      ],
      { bw1: 'Haupthaus', bw2: 'Hoftrakt' }
    )

    // Keyed on the role alone, binding bw1's plan counted the role as covered
    // and silently dropped bw2 — so the agent could not tell that the Hoftrakt
    // has no plan, which is the one thing this section exists to say.
    expect(section).toContain('documents_missing:')
    expect(section).toContain('Hoftrakt')
    expect(section).not.toContain('- Bestandspläne (Haupthaus)\n')
  })

  it('drops the entry once that building is covered too', () => {
    const section = buildDocumentRolesSection(
      [plan('bw1'), plan('bw2')],
      [
        { role: 'bestandsplan', scopeInstanceId: 'bw1' },
        { role: 'bestandsplan', scopeInstanceId: 'bw2' },
      ],
      { bw1: 'Haupthaus', bw2: 'Hoftrakt' }
    )
    expect(section).not.toContain('documents_missing:')
  })
})
