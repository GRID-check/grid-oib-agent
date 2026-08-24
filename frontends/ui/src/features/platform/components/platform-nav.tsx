'use client'

/**
 * Section nav for the platform dashboard.
 *
 * The platform tier used to be seven unrelated admin domains stacked in one
 * scrolling column — every one loading on mount, every one with its own
 * skeleton, error card and retry button, and no way to link to any of them.
 * Each is now its own route; this is how you move between them.
 *
 * A rail on `lg` and up (labels always visible — an admin surface visited
 * rarely should not ask you to decode icons), a horizontally scrolling tab
 * strip below that. Section switches `replace` the URL: the tabs are a
 * switcher, not a stack, so Back leaves the platform shell in one step
 * instead of walking Overview → Models → Knowledge.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  BookOpenCheck,
  Building2,
  Cpu,
  DatabaseZap,
  HardDrive,
  LayoutGrid,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'

/** Section order = reading order: what you own, then what it produces, then upkeep. */
export const PLATFORM_SECTIONS = [
  { key: 'overview', href: '/app/platform', icon: Building2 },
  // Second, right after the fleet itself: a curated skill is the most direct
  // thing this dashboard makes — write one here and every organization is
  // offered it, no deploy and no per-tenant action.
  { key: 'skills', href: '/app/platform/skills', icon: Sparkles },
  { key: 'models', href: '/app/platform/models', icon: Cpu },
  { key: 'retrieval', href: '/app/platform/retrieval', icon: SlidersHorizontal },
  { key: 'quality', href: '/app/platform/quality', icon: ShieldCheck },
  { key: 'cards', href: '/app/platform/cards', icon: LayoutGrid },
  { key: 'knowledge', href: '/app/platform/knowledge', icon: BookOpenCheck },
  { key: 'norms', href: '/app/platform/norms', icon: Scale },
  { key: 'storage', href: '/app/platform/storage', icon: HardDrive },
  { key: 'maintenance', href: '/app/platform/maintenance', icon: DatabaseZap },
] as const satisfies readonly { key: string; href: string; icon: LucideIcon }[]

export type PlatformSectionKey = (typeof PLATFORM_SECTIONS)[number]['key']

/**
 * The overview lives at the bare `/app/platform`, so it must match exactly —
 * a prefix test would light it up on every subsection. Subsections match their
 * own route and anything nested under it, but on a path boundary: a bare
 * `startsWith` would also mark `/app/platform/norms` active on a sibling route
 * such as `/app/platform/norms-draft`.
 */
function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false
  if (href === '/app/platform') return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function PlatformNav(): JSX.Element {
  const pathname = usePathname()
  const t = useTranslations('platform')

  return (
    <nav aria-label={t('nav.label')} data-testid="platform-nav">
      {/* Mobile / tablet: a scrolling strip. Wide content scrolls in its own
          container so the page body never scrolls horizontally. */}
      <ul className="flex gap-1 overflow-x-auto pb-2 lg:hidden">
        {PLATFORM_SECTIONS.map(({ key, href, icon: Icon }) => {
          const active = isActive(pathname, href)
          return (
            <li key={key} className="shrink-0">
              <Link
                href={href}
                replace
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors duration-quick ease-out focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
                  active ? 'bg-secondary font-medium text-secondary-foreground' : 'text-muted-foreground hover:bg-accent',
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
        {PLATFORM_SECTIONS.map(({ key, href, icon: Icon }) => {
          const active = isActive(pathname, href)
          return (
            <li key={key}>
              <Link
                href={href}
                replace
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors duration-quick ease-out focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
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
