/**
 * The phone tab bar's destinations: which tabs each scope carries, which one
 * is lit, where the bar stands down, and where the header's back goes.
 */
import { describe, expect, it } from 'vitest'

import {
  orgPhoneTabs,
  phoneBackTarget,
  phoneTabBarHiddenOnRoute,
  projectPhoneTabs,
} from './phone-tabs'
import { projectSection } from './project-sections'

const ALL = { canAccessArchiv: true, canAccessInbox: true }
const NONE = { canAccessArchiv: false, canAccessInbox: false }
const keys = (tabs: { key: string }[]): string[] => tabs.map((tab) => tab.key)
const lit = (tabs: { key: string; active: boolean }[]): string[] =>
  tabs.filter((tab) => tab.active).map((tab) => tab.key)

describe('inside a project', () => {
  it('carries the two work surfaces, the Übersicht, the Postfach and "Mehr", in that order', () => {
    expect(keys(projectPhoneTabs('p1', '/app/projects/p1/chat', ALL))).toEqual([
      'chat',
      'files',
      'settings',
      'inbox',
      'more',
    ])
  })

  it('on the chat route, "Mehr" is there: the door to the drawer, since chat has no menu button of its own', () => {
    const more = projectPhoneTabs('p1', '/app/projects/p1/chat', NONE).find((tab) => tab.key === 'more')
    expect(more).toMatchObject({ href: null })
    expect(phoneTabBarHiddenOnRoute('/app/projects/p1/chat')).toBe(false)
  })

  it('drops the Postfach for a reader without one, and keeps "Mehr" last', () => {
    expect(keys(projectPhoneTabs('p1', '/app/projects/p1/chat', NONE))).toEqual([
      'chat',
      'files',
      'settings',
      'more',
    ])
  })

  it('links where the rail links: a fresh chat, the files, the overview, the org Postfach', () => {
    const hrefs = Object.fromEntries(
      projectPhoneTabs('p1', '/app/projects/p1/files', ALL).map((tab) => [tab.key, tab.href])
    )
    expect(hrefs).toEqual({
      chat: '/app/projects/p1/chat?new=1',
      files: '/app/projects/p1/files',
      settings: '/app/projects/p1/settings',
      inbox: '/app/inbox',
      more: null,
    })
  })

  it('lights exactly one tab', () => {
    expect(lit(projectPhoneTabs('p1', '/app/projects/p1/chat/s-9', ALL))).toEqual(['chat'])
    expect(lit(projectPhoneTabs('p1', '/app/projects/p1/files/bin', ALL))).toEqual(['files'])
    expect(lit(projectPhoneTabs('p1', '/app/inbox', ALL))).toEqual(['inbox'])
  })

  it('keeps the Übersicht lit on its own setup pages', () => {
    for (const path of [
      '/app/projects/p1/settings',
      '/app/projects/p1/settings/members',
      '/app/projects/p1/setup',
    ]) {
      expect(lit(projectPhoneTabs('p1', path, ALL))).toEqual(['settings'])
    }
  })

  it('lights "Mehr" where only the drawer reaches', () => {
    expect(lit(projectPhoneTabs('p1', '/app/projects/p1/automation', ALL))).toEqual(['more'])
    expect(lit(projectPhoneTabs('p1', '/app/archiv', ALL))).toEqual(['more'])
  })

  it('names each tab with the rail label, and marks it as a tour stop', () => {
    const [chat, files, settings, inbox, more] = projectPhoneTabs(
      'p1',
      '/app/projects/p1/chat',
      ALL
    )
    expect(chat).toMatchObject({
      label: { namespace: 'nav', key: 'sections.chat' },
      tourAnchor: 'section-chat',
    })
    expect(files).toMatchObject({
      label: { namespace: 'nav', key: 'sections.files' },
      tourAnchor: 'section-files',
    })
    expect(settings).toMatchObject({
      label: { namespace: 'nav', key: 'sections.settings' },
      tourAnchor: 'section-settings',
    })
    expect(inbox).toMatchObject({ label: { namespace: 'collaboration', key: 'inbox.navLabel' } })
    expect(more).toMatchObject({
      label: { namespace: 'nav', key: 'tabBar.more' },
      tourAnchor: 'tab-more',
    })
  })
})

describe('above a project', () => {
  it('carries Projekte, the Büroablage and the Postfach, and no "Mehr"', () => {
    expect(keys(orgPhoneTabs('/app/projects', ALL))).toEqual(['projects', 'archiv', 'inbox'])
  })

  it('carries only what the organization has', () => {
    expect(keys(orgPhoneTabs('/app/projects', NONE))).toEqual(['projects'])
  })

  it('lights Projekte on the projects home, a doorway while its sheet stands, and nothing on an account page', () => {
    expect(lit(orgPhoneTabs('/app/projects', ALL))).toEqual(['projects'])
    expect(lit(orgPhoneTabs('/app/archiv', ALL))).toEqual(['archiv'])
    expect(lit(orgPhoneTabs('/app/profile', ALL))).toEqual([])
    expect(lit(orgPhoneTabs('/app/organization/access', ALL))).toEqual([])
  })

  it('points the welcome tour at its doorways', () => {
    const [, archiv, inbox] = orgPhoneTabs('/app/projects', ALL)
    expect(archiv?.tourAnchor).toBe('archiv')
    expect(inbox?.tourAnchor).toBe('inbox')
  })
})

describe('where the bar stands down', () => {
  it('on the intake wizard, which has its own footer', () => {
    expect(phoneTabBarHiddenOnRoute('/app/projects/p1/intake')).toBe(true)
    expect(phoneTabBarHiddenOnRoute('/app/projects/p1/intake/step-2')).toBe(true)
  })

  it('nowhere else, chat included', () => {
    for (const path of [
      '/app/projects',
      '/app/projects/p1/chat',
      '/app/projects/p1/files',
      '/app/profile',
    ]) {
      expect(phoneTabBarHiddenOnRoute(path)).toBe(false)
    }
  })
})

describe('the phone header back', () => {
  it('leads out of a page one level below a tab', () => {
    expect(phoneBackTarget('/app/projects/p1/files/bin', 'p1')).toEqual({
      href: '/app/projects/p1/files',
      sectionKey: 'files',
    })
    expect(phoneBackTarget('/app/projects/p1/settings/members', 'p1')).toEqual({
      href: '/app/projects/p1/settings',
      sectionKey: 'settings',
    })
    expect(phoneBackTarget('/app/projects/p1/setup', 'p1')).toEqual({
      href: '/app/projects/p1/settings',
      sectionKey: 'settings',
    })
  })

  it('is absent on a tab root, where the bar is the way out', () => {
    for (const path of [
      '/app/projects/p1/chat',
      '/app/projects/p1/files',
      '/app/projects/p1/settings',
      '/app/projects/p1/automation',
    ]) {
      expect(phoneBackTarget(path, 'p1')).toBeNull()
    }
  })
})

describe('the Postfach looks like itself', () => {
  it('wears one glyph everywhere, and not the Büroablage’s box beside it', () => {
    const inboxTab = orgPhoneTabs('/app/projects', ALL).find((tab) => tab.key === 'inbox')
    const archivTab = orgPhoneTabs('/app/projects', ALL).find((tab) => tab.key === 'archiv')
    expect(inboxTab?.icon).toBe(projectSection('inbox')?.icon)
    expect(inboxTab?.icon).not.toBe(archivTab?.icon)
    expect(projectSection('inbox')?.icon).not.toBe(projectSection('archiv')?.icon)
    expect(projectSection('inbox')?.icon.displayName).toBe('Bell')
  })
})
