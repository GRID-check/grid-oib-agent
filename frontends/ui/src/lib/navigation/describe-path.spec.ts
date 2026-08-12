/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { describeAppPath } from './describe-path'
import { en } from '@/i18n/dictionaries/en'
import { getByPath } from '@/i18n/translate'

describe('describeAppPath', () => {
  test('names a project section from the same key its nav entry uses', () => {
    expect(describeAppPath('/app/projects/p1/files')).toEqual({
      namespace: 'nav',
      key: 'sections.files',
    })
    expect(describeAppPath('/app/projects/p1/chat')).toEqual({
      namespace: 'nav',
      key: 'sections.chat',
    })
  })

  test('names the projects listing and a project root', () => {
    expect(describeAppPath('/app/projects')).toEqual({
      namespace: 'nav',
      key: 'projectSwitcher.projects',
    })
    expect(describeAppPath('/app/projects/p1')).toEqual({
      namespace: 'nav',
      key: 'returnTargets.project',
    })
  })

  test('reads the inbox label from the collaboration dictionary, where its copy lives', () => {
    expect(describeAppPath('/app/inbox')).toEqual({
      namespace: 'collaboration',
      key: 'inbox.navLabel',
    })
  })

  test('names the org-level surfaces', () => {
    expect(describeAppPath('/app/archiv')?.key).toBe('sections.archiv')
    expect(describeAppPath('/app/organization/members')?.key).toBe('returnTargets.organization')
    expect(describeAppPath('/app/platform/storage')?.key).toBe('returnTargets.platform')
    expect(describeAppPath('/app/profile')?.key).toBe('returnTargets.profile')
  })

  test('falls back to the project itself for an unlisted project sub-route', () => {
    expect(describeAppPath('/app/projects/p1/some-future-tab')).toEqual({
      namespace: 'nav',
      key: 'returnTargets.project',
    })
  })

  test('declines to name anything outside /app', () => {
    expect(describeAppPath('/auth/sign-in')).toBeNull()
    expect(describeAppPath('/')).toBeNull()
    expect(describeAppPath('/app/onboarding/organization')).toBeNull()
  })

  test('ignores a query string', () => {
    expect(describeAppPath('/app/projects/p1/history?tag=brandschutz')?.key).toBe(
      'sections.history'
    )
  })

  test('every label it can return resolves to a real string in the dictionary', () => {
    const paths = [
      '/app/projects',
      '/app/projects/p1',
      '/app/projects/p1/chat',
      '/app/projects/p1/files',
      '/app/projects/p1/knowledge',
      '/app/projects/p1/history',
      '/app/projects/p1/skills',
      '/app/projects/p1/jobs',
      '/app/projects/p1/intake',
      '/app/projects/p1/settings',
      '/app/projects/p1/research',
      '/app/projects/p1/members',
      '/app/projects/p1/model',
      '/app/archiv',
      '/app/inbox',
      '/app/chat',
      '/app/organization',
      '/app/platform',
      '/app/profile',
    ]
    for (const path of paths) {
      const label = describeAppPath(path)
      expect(label, path).not.toBeNull()
      expect(typeof getByPath(en, `${label!.namespace}.${label!.key}`), path).toBe('string')
    }
  })
})
