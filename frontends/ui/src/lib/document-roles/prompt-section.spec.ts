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
    expect(buildDocumentRolesSection([bound({ confidence: 'suggested' })])).toContain('[nicht bestätigt]')
  })

  it('names a missing role explicitly rather than leaving it to be inferred', () => {
    const section = buildDocumentRolesSection([], ['bebauungsplan'])
    expect(section).toContain('documents_missing:')
    expect(section).toContain('- Bebauungsplan')
  })

  it('stops reporting a role as missing once it is bound', () => {
    const section = buildDocumentRolesSection([bound()], ['bebauungsplan'])
    expect(section).not.toContain('documents_missing:')
  })

  it('leaves an unrecommended, unbound role out entirely', () => {
    // Every role is offerable, but telling the agent that a project with no
    // demolition lacks a Schadstoffgutachten costs tokens on every turn.
    const section = buildDocumentRolesSection([bound()], ['bebauungsplan'])
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

  it('renders in registry order so the block is stable between turns', () => {
    // An unstable block churns the prompt cache for no benefit.
    const section = buildDocumentRolesSection([
      bound({ role: 'lageplan', filename: 'lage.pdf' }),
      bound({ role: 'bebauungsplan', filename: 'bplan.pdf' }),
    ])
    expect(section.indexOf('bplan.pdf')).toBeLessThan(section.indexOf('lage.pdf'))
  })
})
