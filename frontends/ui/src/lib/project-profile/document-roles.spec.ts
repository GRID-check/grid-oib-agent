import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_ROLES,
  DOCUMENT_ROLE_DEFINITIONS,
  documentRoleDefinition,
  isDocumentRole,
  isRoleConfidence,
  isRoleSource,
  isScopeInstanceValid,
  recommendedRoles,
  roleRequiresScopeInstance,
} from './document-roles'
import type { DocumentRole } from './document-roles'

describe('the role registry', () => {
  it('covers exactly the declared vocabulary, in the same order', () => {
    // Two declarations of one list is how they drift. The tuple exists for the
    // union type, the definitions for the data; this is what pins them.
    expect(DOCUMENT_ROLE_DEFINITIONS.map((d) => d.role)).toEqual([...DOCUMENT_ROLES])
  })

  it('gives every role a non-empty German label', () => {
    for (const definition of DOCUMENT_ROLE_DEFINITIONS) {
      expect(definition.label.trim(), definition.role).not.toBe('')
    }
  })

  it('only makes a role single-holder when the project really has one', () => {
    // A cardinality claim is about the world. The plan sets are many; the
    // governing documents are one.
    const single = DOCUMENT_ROLE_DEFINITIONS.filter((d) => d.cardinality === 'one').map((d) => d.role)
    expect(single).toEqual(['bebauungsplan', 'flaechenwidmungsplan', 'grundbuchauszug', 'lageplan'])
  })

  it('rejects an unknown role rather than trusting the wire', () => {
    expect(isDocumentRole('bebauungsplan')).toBe(true)
    expect(isDocumentRole('Bebauungsplan')).toBe(false)
    expect(isDocumentRole('bestandsplaene')).toBe(false)
    expect(() => documentRoleDefinition('nope' as DocumentRole)).toThrow(/Unknown document role/)
  })

  it('validates confidence and source against their closed sets', () => {
    expect(isRoleConfidence('declared')).toBe(true)
    expect(isRoleConfidence('suggested')).toBe(true)
    expect(isRoleConfidence('confirmed')).toBe(false)
    expect(isRoleSource('classifier')).toBe(true)
    expect(isRoleSource('llm')).toBe(false)
  })
})

describe('scope instances', () => {
  it('requires an instance for a bauwerk role and nothing else, for now', () => {
    expect(roleRequiresScopeInstance('bestandsplan')).toBe(true)
    // A project has one plot in v1 and mints no id for it, so demanding one
    // here would make the Bebauungsplan unbindable. Flips when plots go plural.
    expect(roleRequiresScopeInstance('bebauungsplan')).toBe(false)
    expect(roleRequiresScopeInstance('vorbescheid')).toBe(false)
  })

  it('accepts the Bebauungsplan with no instance, since no plot ids exist yet', () => {
    expect(isScopeInstanceValid('bebauungsplan', null)).toBe(true)
    expect(isScopeInstanceValid('bebauungsplan', 'gs1')).toBe(false)
  })

  it('refuses a bauwerk role with no building, which would match every building', () => {
    expect(isScopeInstanceValid('bestandsplan', 'bw2')).toBe(true)
    expect(isScopeInstanceValid('bestandsplan', null)).toBe(false)
    expect(isScopeInstanceValid('bestandsplan', '')).toBe(false)
  })

  it('refuses a project role that carries one, so the column means one thing', () => {
    expect(isScopeInstanceValid('vorbescheid', null)).toBe(true)
    expect(isScopeInstanceValid('vorbescheid', 'bw2')).toBe(false)
  })
})

describe('recommendedRoles', () => {
  it('pushes the Bebauungsplan once the project says one exists', () => {
    expect(recommendedRoles({})).not.toContain('bebauungsplan')
    expect(recommendedRoles({ B2: 'ja' })).toContain('bebauungsplan')
    expect(recommendedRoles({ B2: 'nein' })).not.toContain('bebauungsplan')
  })

  it('reads a bauwerk condition from the building it was asked about', () => {
    const answers = { 'C2@bw1': 'bestand', 'C2@bw2': 'neubau' }
    expect(recommendedRoles(answers, 'bw1')).toContain('bestandsplan')
    expect(recommendedRoles(answers, 'bw2')).not.toContain('bestandsplan')
  })

  it('pushes the Schadstoffgutachten only when the project includes a demolition', () => {
    expect(recommendedRoles({ A5: ['Neubau'] })).not.toContain('gutachten_schadstoffe')
    expect(recommendedRoles({ A5: ['Neubau', 'Abbruch'] })).toContain('gutachten_schadstoffe')
  })

  it('never pushes a role that states no condition', () => {
    // Offerable is not the same as recommended: the checklist lists every role,
    // but only a stated condition claims the project needs one.
    const everything = recommendedRoles({ B2: 'ja', A5: ['Abbruch'], 'C2@bw1': 'bestand' }, 'bw1')
    expect(everything).not.toContain('vorentwurf_studie')
    expect(everything).not.toContain('sonstige_projektgrundlage')
  })
})
