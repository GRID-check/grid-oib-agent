import type { ComponentType } from 'react'
import { Archive, Bell, FolderKanban, MoreHorizontal } from 'lucide-react'

import { TOUR_ANCHORS, sectionAnchor } from '@/features/onboarding/lib/product-tour'
import {
  projectSection,
  sectionHref,
  sectionLinkHref,
  type ProjectSectionKey,
} from './project-sections'

/**
 * The phone's bottom tab bar, as data: which destinations it carries in each
 * scope, which one is current, and on which pages it stands down.
 *
 * WHY THESE. On a phone the rail is a drawer behind one control, so every
 * destination costs a stretch to the top of the screen and a second tap. The
 * bar takes the places an architect on site goes to several times an hour and
 * puts them under the thumb; the drawer stays, behind "Mehr", for everything
 * else (Automatisierung, the Büroablage, the account).
 *
 * - Inside a project: Frag Piloti, Dateien, Übersicht, Postfach, Mehr. Chat
 *   and Dateien are the two work surfaces. Übersicht is the project's
 *   dashboard, which on a phone is otherwise two taps deep in the drawer and is
 *   the page that says where the project stands. The Postfach is where the
 *   decisions waiting for this person are, and carries the badge. The
 *   Büroablage is a doorway OUT of the project, used less often from a site,
 *   so it waits behind Mehr with Automatisierung.
 * - Above a project: Projekte, Büroablage, Postfach. The org scope's account
 *   destinations (Profil, Organisation, Plattform) are rare and already sit in
 *   the avatar menu, so a "Mehr" here would only be a second door to that menu.
 *
 * Labels are the rail's own (`nav.sections.*`, the inbox's collaboration
 * label), so a destination has one name on every surface.
 */

export type PhoneTabKey = 'chat' | 'files' | 'settings' | 'inbox' | 'projects' | 'archiv' | 'more'

export interface PhoneTabLabel {
  namespace: 'nav' | 'collaboration'
  key: string
}

export interface PhoneTab {
  key: PhoneTabKey
  /** Null for "Mehr", which opens the drawer instead of going anywhere. */
  href: string | null
  icon: ComponentType<{ className?: string }>
  label: PhoneTabLabel
  active: boolean
  /** The product-tour stop this tab stands for on a phone (`data-tour`). */
  tourAnchor: string
}

export interface PhoneTabFlags {
  canAccessArchiv: boolean
  canAccessInbox: boolean
}

const INBOX_HREF = '/app/inbox'
const ARCHIV_HREF = '/app/archiv'
const PROJECTS_HREF = '/app/projects'

function isUnder(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * Project sections that live under the Übersicht on a phone: the dashboard's
 * own setup pages. They are reached from the Übersicht, so it stays lit while
 * the reader is in one.
 */
const UNDER_OVERVIEW: readonly string[] = ['settings', 'setup', 'intake']

function projectTab(
  key: Extract<ProjectSectionKey, 'chat' | 'files' | 'settings'>,
  base: string,
  pathname: string
): PhoneTab {
  const section = projectSection(key)
  if (!section) throw new Error(`unknown project section: ${key}`)
  const active =
    key === 'settings'
      ? UNDER_OVERVIEW.some((segment) => isUnder(pathname, `${base}/${segment}`))
      : isUnder(pathname, sectionHref(section, base))
  return {
    key,
    href: sectionLinkHref(section, base),
    icon: section.icon,
    label: section.label ?? { namespace: 'nav', key: `sections.${section.i18nKey}` },
    active,
    tourAnchor: sectionAnchor(key),
  }
}

function inboxTab(pathname: string, tourAnchor: string): PhoneTab {
  return {
    key: 'inbox',
    href: INBOX_HREF,
    icon: Bell,
    label: { namespace: 'collaboration', key: 'inbox.navLabel' },
    active: isUnder(pathname, INBOX_HREF),
    tourAnchor,
  }
}

/** The bar inside a project. "Mehr" is lit while the reader is somewhere only the drawer reaches. */
export function projectPhoneTabs(
  projectId: string,
  pathname: string,
  flags: PhoneTabFlags
): PhoneTab[] {
  const base = `/app/projects/${projectId}`
  const tabs: PhoneTab[] = [
    projectTab('chat', base, pathname),
    projectTab('files', base, pathname),
    projectTab('settings', base, pathname),
  ]
  if (flags.canAccessInbox) tabs.push(inboxTab(pathname, sectionAnchor('inbox')))
  const somewhereElse = !tabs.some((tab) => tab.active)
  tabs.push({
    key: 'more',
    href: null,
    icon: MoreHorizontal,
    label: { namespace: 'nav', key: 'tabBar.more' },
    active: somewhereElse,
    tourAnchor: TOUR_ANCHORS.more,
  })
  return tabs
}

/** The bar above a project. Nothing is lit on an account page (Profil, Organisation). */
export function orgPhoneTabs(pathname: string, flags: PhoneTabFlags): PhoneTab[] {
  const tabs: PhoneTab[] = [
    {
      key: 'projects',
      href: PROJECTS_HREF,
      icon: FolderKanban,
      label: { namespace: 'nav', key: 'projectSwitcher.projects' },
      active: pathname === PROJECTS_HREF,
      tourAnchor: 'tab-projects',
    },
  ]
  if (flags.canAccessArchiv) {
    tabs.push({
      key: 'archiv',
      href: ARCHIV_HREF,
      icon: Archive,
      label: { namespace: 'nav', key: 'sections.archiv' },
      active: isUnder(pathname, ARCHIV_HREF),
      tourAnchor: TOUR_ANCHORS.archiv,
    })
  }
  if (flags.canAccessInbox) tabs.push(inboxTab(pathname, TOUR_ANCHORS.inbox))
  return tabs
}

/**
 * Pages where the bar stands down. The intake wizard is a guided flow with its
 * own sticky Zurück / Weiter footer: a second bar under it would stack two rows
 * of controls at the thumb and invite leaving a half-answered form. The wizard
 * is left the way it was entered, through its own controls or the header's
 * back.
 */
export function phoneTabBarHiddenOnRoute(pathname: string): boolean {
  return /^\/app\/projects\/[^/]+\/intake(\/|$)/.test(pathname)
}

export interface PhoneBackTarget {
  href: string
  /** Key under `nav.sections`. */
  sectionKey: 'files' | 'settings'
}

/**
 * Where the phone header's back control goes, for a page one level below a
 * tab's root. Tab roots have none: the bar is their way out. The Papierkorb
 * sits under Dateien; a settings page, the Projekterfassung and the
 * Einrichtung sit under the Übersicht.
 */
export function phoneBackTarget(pathname: string, projectId: string): PhoneBackTarget | null {
  const base = `/app/projects/${projectId}`
  if (pathname.startsWith(`${base}/files/`)) return { href: `${base}/files`, sectionKey: 'files' }
  if (pathname.startsWith(`${base}/settings/`))
    return { href: `${base}/settings`, sectionKey: 'settings' }
  if (isUnder(pathname, `${base}/setup`) || isUnder(pathname, `${base}/intake`)) {
    return { href: `${base}/settings`, sectionKey: 'settings' }
  }
  return null
}
