import { describe, expect, test } from 'vitest'
import { orgRailGroups, orgSections, projectIdFromPathname } from './org-sections'

/**
 * The scope decision, in isolation from the rail that renders it. It is one
 * function and it decides which of two navigations the reader gets, so it is
 * worth more than the incidental coverage a mounted component gives it (see
 * AGENTS.md on logic that lives in a render function).
 */
describe('projectIdFromPathname', () => {
  test('reads the id out of any page inside a project', () => {
    expect(projectIdFromPathname('/app/projects/p-1')).toBe('p-1')
    expect(projectIdFromPathname('/app/projects/p-1/files')).toBe('p-1')
    expect(projectIdFromPathname('/app/projects/p-1/chat?new=1')).toBe('p-1')
  })

  test('treats the listing as org scope, not as a project', () => {
    // A switcher naming a project while the reader looks at all of them is the
    // same false claim it makes on the Postfach.
    expect(projectIdFromPathname('/app/projects')).toBeNull()
    expect(projectIdFromPathname('/app/projects/')).toBeNull()
  })

  test('is org scope for every surface above a project', () => {
    for (const path of [
      '/app/archiv',
      '/app/inbox',
      '/app/profile',
      '/app/organization/models',
      '/app/platform',
      '/app',
    ]) {
      expect(projectIdFromPathname(path)).toBeNull()
    }
  })

  test('decodes an id that had to be escaped in the URL', () => {
    expect(projectIdFromPathname('/app/projects/a%2Fb/files')).toBe('a/b')
  })

  test('ignores paths outside the app', () => {
    expect(projectIdFromPathname('/dev/app-rail')).toBeNull()
    expect(projectIdFromPathname('')).toBeNull()
  })
})

describe('orgSections', () => {
  test('offers only what the reader can reach; the listing and Profil always', () => {
    expect(orgSections({}).map((s) => s.key)).toEqual(['projects', 'profile'])
  })

  test('adds each gated destination with its own flag', () => {
    expect(
      orgSections({
        canAccessArchiv: true,
        canAccessInbox: true,
        canViewOrganization: true,
        canManagePlatform: true,
      }).map((s) => s.key)
    ).toEqual(['projects', 'archiv', 'inbox', 'organization', 'platform', 'profile'])
  })
})

describe('orgRailGroups', () => {
  test('buckets consecutive entries and drops groups that gate away entirely', () => {
    expect(
      orgRailGroups({ canAccessArchiv: true }).map((g) => [g.group, g.items.map((i) => i.key)])
    ).toEqual([
      ['work', ['projects', 'archiv']],
      ['account', ['profile']],
    ])
  })
})
