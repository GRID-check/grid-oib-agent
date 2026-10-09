import { describe, expect, test } from 'vitest'
import { settingsSectionHref, visibleSettingsSections } from './settings-sections'

describe('visibleSettingsSections', () => {
  test('a project admin sees every section, in reading order', () => {
    expect(visibleSettingsSections({ manageMembers: true, manageBudget: true })).toEqual([
      'general',
      'profile',
      'members',
      'memory',
      'usage',
      'documents',
    ])
  })

  test('a viewer is offered no section whose API would refuse them', () => {
    // The roster endpoint needs members:manage, the usage read needs
    // project:manage or an org budget admin.
    expect(visibleSettingsSections({ manageMembers: false, manageBudget: false })).toEqual([
      'general',
      'profile',
      'memory',
      'documents',
    ])
  })
})

describe('settingsSectionHref', () => {
  test('General owns the bare settings route, the rest nest under it', () => {
    expect(settingsSectionHref('p1', 'general')).toBe('/app/projects/p1/settings')
    expect(settingsSectionHref('p1', 'usage')).toBe('/app/projects/p1/settings/usage')
  })
})
