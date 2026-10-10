'use client'

/**
 * Section nav for the organization tier.
 *
 * The organization tier used to be one scrolling column: settings, members,
 * models, BYOK, budgets and the audit trail stacked as cards, each gated by a
 * different permission, none of them linkable and all of them loading at once.
 * Each is its own route now; this is how you move between them.
 *
 * Which sections exist for you is decided by the layout, on the server, and
 * handed down as keys. Unlike the platform tier this one is read by plain
 * members as well as admins, so the set genuinely differs per person — and a
 * link that lands on a 403 is worse than no link. Re-deriving the permissions
 * in the browser would put a second, drifting copy of the access rules in the
 * client bundle; the nav is deliberately told, not left to work it out.
 *
 * The rail and strip themselves are `components/shell/section-nav.tsx`, shared
 * with the project settings so both tiers move between sections the same way.
 */

import type { JSX } from 'react'
import {
  Building2,
  Cpu,
  FileDown,
  FileWarning,
  Gauge,
  HardDrive,
  ScanSearch,
  ScrollText,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { useTranslations } from '@/i18n'
import { SectionNav } from '@/components/shell/section-nav'

/**
 * Section order = reading order: the organization itself, then the people in
 * it, then what they may run, what it costs, and finally the upkeep an admin
 * alone touches. The order lives here and only here — callers pass an unordered
 * set of keys and get this sequence back.
 */
export const ORGANIZATION_SECTIONS = [
  { key: 'overview', href: '/app/organization', icon: Building2 },
  { key: 'access', href: '/app/organization/access', icon: Users },
  { key: 'models', href: '/app/organization/models', icon: Cpu },
  { key: 'budgets', href: '/app/organization/budgets', icon: Gauge },
  { key: 'storage', href: '/app/organization/storage', icon: HardDrive },
  { key: 'screening', href: '/app/organization/screening', icon: ScanSearch },
  { key: 'quarantine', href: '/app/organization/quarantine', icon: FileWarning },
  { key: 'downloads', href: '/app/organization/download-log', icon: FileDown },
  { key: 'compliance', href: '/app/organization/compliance', icon: ScrollText },
  { key: 'enterprise', href: '/app/organization/enterprise', icon: ShieldCheck },
] as const satisfies readonly { key: string; href: string; icon: LucideIcon }[]

export type OrganizationSectionKey = (typeof ORGANIZATION_SECTIONS)[number]['key']

export interface OrganizationNavProps {
  /** The sections this session may open, in any order — the nav re-orders them. */
  sections: readonly OrganizationSectionKey[]
}

export function OrganizationNav({ sections }: OrganizationNavProps): JSX.Element {
  const t = useTranslations('organization')

  const items = ORGANIZATION_SECTIONS.filter((section) => sections.includes(section.key)).map(
    (section) => ({ ...section, label: t(`nav.${section.key}`) })
  )

  return (
    <SectionNav
      label={t('nav.label')}
      items={items}
      rootHref="/app/organization"
      pillId="org-nav-pill"
      data-testid="organization-nav"
    />
  )
}
