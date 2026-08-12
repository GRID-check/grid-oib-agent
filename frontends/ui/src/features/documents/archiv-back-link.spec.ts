/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { resolveArchivBackLink } from './archiv-back-link'

describe('resolveArchivBackLink', () => {
  test('returns the reader to their active project BY NAME when we know it', () => {
    expect(resolveArchivBackLink({ id: 'proj-123', name: 'Stadthaus Wien' })).toEqual({
      href: '/app/projects/proj-123',
      labelKey: 'backToNamedProject',
      name: 'Stadthaus Wien',
    })
  })

  test('still returns them to the project when only its id resolved', () => {
    expect(resolveArchivBackLink({ id: 'proj-123' })).toEqual({
      href: '/app/projects/proj-123',
      labelKey: 'backToProject',
    })
    expect(resolveArchivBackLink({ id: 'proj-123', name: null })).toEqual({
      href: '/app/projects/proj-123',
      labelKey: 'backToProject',
    })
    // A name that is only whitespace is not a name.
    expect(resolveArchivBackLink({ id: 'proj-123', name: '  ' })).toEqual({
      href: '/app/projects/proj-123',
      labelKey: 'backToProject',
    })
  })

  test('accepts a bare project id', () => {
    expect(resolveArchivBackLink('proj-123')).toEqual({
      href: '/app/projects/proj-123',
      labelKey: 'backToProject',
    })
  })

  test('falls back to the projects listing when there is no active project', () => {
    expect(resolveArchivBackLink(undefined)).toEqual({
      href: '/app/projects',
      labelKey: 'backToApp',
    })
  })

  test('treats null, an empty string and an id-less project as "no project"', () => {
    const fallback = { href: '/app/projects', labelKey: 'backToApp' as const }
    expect(resolveArchivBackLink(null)).toEqual(fallback)
    expect(resolveArchivBackLink('')).toEqual(fallback)
    expect(resolveArchivBackLink({ id: '' })).toEqual(fallback)
  })
})
