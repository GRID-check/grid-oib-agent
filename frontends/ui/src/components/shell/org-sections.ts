import type { ComponentType } from 'react'
import { Archive, Building2, Inbox, LayoutGrid, ShieldCheck, UserRound } from 'lucide-react'

/**
 * The ORG-SCOPE rail IA — what the persistent rail shows when the reader is
 * above a project (the projects home, the Archiv, the Postfach, Organisation,
 * Plattform, Profil).
 *
 * Its counterpart is {@link import('./project-sections')}, and the split is the
 * point. The project rail is a list of one project's sections; naming a project
 * while the reader is standing in the Postfach is the single most false claim
 * the frame can make, so in org scope the switcher unmounts and these entries
 * take over — same rail, same geometry, different contents.
 *
 * Every destination here is org-scoped and reachable from the session alone, so
 * the shared layout that mounts the rail needs nothing a project segment would
 * have had to provide.
 */

export type OrgSectionKey =
  | 'projects'
  | 'archiv'
  | 'inbox'
  | 'organization'
  | 'platform'
  | 'profile'

/** How the rail groups consecutive entries. */
export type OrgNavGroup = 'work' | 'account'

/** Capability gates, named exactly as `getNavFlags` returns them. */
export interface OrgSectionFlags {
  /** Org-wide Archiv — `organization-archiv` (ADR-0024). */
  canAccessArchiv?: boolean
  /** Postfach — derived from the inbox item-type registry (ADR-0042). */
  canAccessInbox?: boolean
  /** The organization page, open to any org member (UX-16). */
  canViewOrganization?: boolean
  /** The platform tier, platform owner only (ADR-0016). */
  canManagePlatform?: boolean
}

export interface OrgSection {
  key: OrgSectionKey
  href: string
  icon: ComponentType<{ className?: string }>
  /**
   * Where the visible label comes from. These destinations already have names
   * the reader has seen — in the user menu and in the project rail — so they
   * borrow those keys rather than introducing a second wording for the same
   * place.
   */
  label: { namespace: 'nav' | 'collaboration'; key: string }
  gate?: keyof OrgSectionFlags
  group: OrgNavGroup
}

const ORG_SECTIONS: readonly OrgSection[] = [
  {
    // The listing is the org-scope home and the destination every back control
    // falls back to, so it leads.
    key: 'projects',
    href: '/app/projects',
    icon: LayoutGrid,
    label: { namespace: 'nav', key: 'projectSwitcher.projects' },
    group: 'work',
  },
  {
    key: 'archiv',
    href: '/app/archiv',
    icon: Archive,
    label: { namespace: 'nav', key: 'sections.archiv' },
    gate: 'canAccessArchiv',
    group: 'work',
  },
  {
    // The inbox's copy lives in the collaboration dictionary (ADR-0035), so it
    // is named from there rather than duplicated into `nav`.
    key: 'inbox',
    href: '/app/inbox',
    icon: Inbox,
    label: { namespace: 'collaboration', key: 'inbox.navLabel' },
    gate: 'canAccessInbox',
    group: 'work',
  },
  {
    key: 'organization',
    href: '/app/organization',
    icon: Building2,
    label: { namespace: 'nav', key: 'userMenu.organization' },
    gate: 'canViewOrganization',
    group: 'account',
  },
  {
    key: 'platform',
    href: '/app/platform',
    icon: ShieldCheck,
    label: { namespace: 'nav', key: 'userMenu.platform' },
    gate: 'canManagePlatform',
    group: 'account',
  },
  {
    key: 'profile',
    href: '/app/profile',
    icon: UserRound,
    label: { namespace: 'nav', key: 'userMenu.profile' },
    group: 'account',
  },
]

function isVisible(section: OrgSection, flags: OrgSectionFlags): boolean {
  return section.gate ? Boolean(flags[section.gate]) : true
}

/** The visible org-scope entries, in order. */
export function orgSections(flags: OrgSectionFlags): OrgSection[] {
  return ORG_SECTIONS.filter((section) => isVisible(section, flags))
}

/**
 * The org-scope entries bucketed into consecutive groups, mirroring
 * `railGroups()` so the rail body renders identically in both scopes. Empty
 * groups (every member gated off) are omitted.
 */
export function orgRailGroups(
  flags: OrgSectionFlags
): { group: OrgNavGroup; items: OrgSection[] }[] {
  const groups: { group: OrgNavGroup; items: OrgSection[] }[] = []
  for (const item of orgSections(flags)) {
    const last = groups.at(-1)
    if (last?.group === item.group) last.items.push(item)
    else groups.push({ group: item.group, items: [item] })
  }
  return groups
}

/**
 * Whether `pathname` is inside a project — i.e. whether the rail should show
 * project scope. `/app/projects` (the listing) is deliberately NOT a project:
 * it is the org-scope home, and a switcher naming a project while the reader
 * looks at all of them is the same false claim as on the Postfach.
 */
export function projectIdFromPathname(pathname: string): string | null {
  const segments = pathname.split('?')[0].split('/').filter(Boolean)
  if (segments[0] !== 'app' || segments[1] !== 'projects') return null
  return segments[2] ? decodeURIComponent(segments[2]) : null
}
