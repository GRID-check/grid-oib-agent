/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { resolveArchivBackLink } from './archiv-back-link'

describe('resolveArchivBackLink', () => {
  test('with an active project returns a link back to that specific project', () => {
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

  test('treats null and empty string as "no project" (fail-open fallback)', () => {
    const fallback = { href: '/app/projects', labelKey: 'backToApp' as const }
    expect(resolveArchivBackLink(null)).toEqual(fallback)
    expect(resolveArchivBackLink('')).toEqual(fallback)
  })
})
