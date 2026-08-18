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
 * A rail on `lg` and up (labels always visible — an admin surface visited
 * rarely should not ask you to decode icons), a horizontally scrolling tab
 * strip below that. Section switches `replace` the URL: the tabs are a
 * switcher, not a stack, so Back leaves the organization shell in one step
 * instead of walking Overview → Models → Knowledge.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Building2,
  Cpu,
  Gauge,
  HardDrive,
  ScrollText,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'

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
  { key: 'compliance', href: '/app/organization/compliance', icon: ScrollText },
  { key: 'enterprise', href: '/app/organization/enterprise', icon: ShieldCheck },
] as const satisfies readonly { key: string; href: string; icon: LucideIcon }[]

export type OrganizationSectionKey = (typeof ORGANIZATION_SECTIONS)[number]['key']

export interface OrganizationNavProps {
  /** The sections this session may open, in any order — the nav re-orders them. */
  sections: readonly OrganizationSectionKey[]
}

/**
 * The overview lives at the bare `/app/organization`, so it must match exactly —
 * a prefix test would light it up on every subsection. Subsections match their
 * own route and anything nested under it, but on a path boundary: a bare
 * `startsWith` would also mark `/app/organization/access` active on a sibling
 * route such as `/app/organization/access-log`.
 */
function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false
  if (href === '/app/organization') return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function OrganizationNav({ sections }: OrganizationNavProps): JSX.Element {
  const pathname = usePathname()
  const t = useTranslations('organization')

  const visible = ORGANIZATION_SECTIONS.filter((section) => sections.includes(section.key))

  return (
    <nav aria-label={t('nav.label')} data-testid="organization-nav">
      {/* Mobile / tablet: a scrolling strip. Wide content scrolls in its own
          container so the page body never scrolls horizontally. */}
      <ul className="flex gap-1 overflow-x-auto pb-2 lg:hidden">
        {visible.map(({ key, href, icon: Icon }) => {
          const active = isActive(pathname, href)
          return (
            <li key={key} className="shrink-0">
              <Link
                href={href}
                replace
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
                  active
                    ? 'bg-secondary font-medium text-secondary-foreground'
                    : 'text-muted-foreground hover:bg-accent',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {t(`nav.${key}`)}
              </Link>
            </li>
          )
        })}
      </ul>

      {/* Desktop: a sticky rail beside the content. */}
      <ul className="hidden lg:sticky lg:top-24 lg:flex lg:flex-col lg:gap-0.5">
        {visible.map(({ key, href, icon: Icon }) => {
          const active = isActive(pathname, href)
          return (
            <li key={key}>
              <Link
                href={href}
                replace
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
                  active
                    ? 'bg-secondary font-medium text-secondary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {t(`nav.${key}`)}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
