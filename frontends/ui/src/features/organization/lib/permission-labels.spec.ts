/**
 * Every permission a custom role can carry has a human label, in both
 * languages. A new organization permission in the catalog fails here until
 * somebody writes the line an office will read in the role editor.
 */
import { describe, expect, it } from 'vitest'
import { ORG_PERMISSION_SPECS } from '@/lib/authz/catalog'
import { de } from '@/i18n/dictionaries/de'
import { en } from '@/i18n/dictionaries/en'
import { createTranslator } from '@/i18n/translate'
import { PERMISSION_LABEL_KEYS, permissionLabel } from './permission-labels'

const ORG_TIER = ORG_PERMISSION_SPECS.filter((spec) => spec.tier === 'org').map((spec) => spec.slug)

describe('permission labels', () => {
  it('labels exactly the organization tier of the catalog', () => {
    expect(Object.keys(PERMISSION_LABEL_KEYS).sort()).toEqual([...ORG_TIER].sort())
  })

  it.each([
    ['en', en],
    ['de', de],
  ])('resolves a name and a hint for every label in %s', (_locale, dictionary) => {
    const t = createTranslator(dictionary, 'organization')
    for (const slug of ORG_TIER) {
      const label = permissionLabel(t, slug)
      expect(label.name, slug).not.toMatch(/customRoles\./)
      expect(label.hint, slug).not.toMatch(/customRoles\./)
    }
  })

  it('falls back to the catalog name, then the slug, for a permission it does not label', () => {
    const t = createTranslator(en, 'organization')
    expect(permissionLabel(t, 'project:view')).toEqual({ name: 'View project', hint: null })
    expect(permissionLabel(t, 'org:unknown')).toEqual({ name: 'org:unknown', hint: null })
  })
})
