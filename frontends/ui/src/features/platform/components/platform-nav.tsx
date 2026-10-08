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

import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Bandage,
  BookOpenCheck,
  Building2,
  Cpu,
  DatabaseZap,
  HardDrive,
  LayoutGrid,
  MessageSquarePlus,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'

/**
 * Sections in four groups, in reading order: the fleet you run, how well it
 * answers, what it knows, and upkeep. Twelve links in one flat column was a list
 * to read top to bottom every visit; grouped, the rail is a map. Lessons and
 * Feedback sit under quality because that is what they are: what the down-votes
 * were distilled into, and what members tell us directly.
 */
export const PLATFORM_SECTION_GROUPS = [
  {
    key: 'operate',
    sections: [
      { key: 'overview', href: '/app/platform', icon: Building2 },
      { key: 'models', href: '/app/platform/models', icon: Cpu },
      { key: 'retrieval', href: '/app/platform/retrieval', icon: SlidersHorizontal },
      // A curated skill is the most direct thing this dashboard makes: write
      // one here and every organization is offered it, no deploy.
      { key: 'skills', href: '/app/platform/skills', icon: Sparkles },
    ],
  },
  {
    key: 'quality',
    sections: [
      { key: 'quality', href: '/app/platform/quality', icon: ShieldCheck },
      { key: 'lessons', href: '/app/platform/lessons', icon: Bandage },
      { key: 'feedback', href: '/app/platform/feedback', icon: MessageSquarePlus },
    ],
  },
  {
    key: 'content',
    sections: [
      { key: 'knowledge', href: '/app/platform/knowledge', icon: BookOpenCheck },
      { key: 'norms', href: '/app/platform/norms', icon: Scale },
      { key: 'cards', href: '/app/platform/cards', icon: LayoutGrid },
    ],
  },
  {
    key: 'system',
    sections: [
      { key: 'storage', href: '/app/platform/storage', icon: HardDrive },
      { key: 'maintenance', href: '/app/platform/maintenance', icon: DatabaseZap },
    ],
  },
] as const satisfies readonly {
  key: string
  sections: readonly { key: string; href: string; icon: LucideIcon }[]
}[]

export const PLATFORM_SECTIONS = PLATFORM_SECTION_GROUPS.flatMap((group) => group.sections)

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

const LINK_BASE =
  'flex items-center gap-2 rounded-md text-sm transition-colors duration-quick ease-out focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none'

export function PlatformNav(): JSX.Element {
  const pathname = usePathname()
  const t = useTranslations('platform')
  const stripRef = useRef<HTMLUListElement>(null)

  // On a phone the strip scrolls; the section you are on can start off-screen
  // (Maintenance is twelfth). Bring it into view whenever the route changes.
  useEffect(() => {
    const active = stripRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
    active?.scrollIntoView?.({ block: 'nearest', inline: 'center' })
  }, [pathname])

  return (
    <nav aria-label={t('nav.label')} data-testid="platform-nav">
      {/* Mobile / tablet: one scrolling strip. Wide content scrolls in its own
          container so the page body never scrolls horizontally. */}
      <ul
        ref={stripRef}
        className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-2 [scrollbar-width:none] lg:hidden"
      >
        {PLATFORM_SECTIONS.map(({ key, href, icon: Icon }) => {
          const active = isActive(pathname, href)
          return (
            <li key={key} className="shrink-0">
              <Link
                href={href}
                replace
                aria-current={active ? 'page' : undefined}
                className={cn(
                  LINK_BASE,
                  'pointer-coarse:min-h-11 gap-1.5 px-3 py-1.5',
                  active
                    ? 'bg-secondary text-secondary-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {t(`nav.${key}`)}
              </Link>
            </li>
          )
        })}
      </ul>

      {/* Desktop: a sticky rail beside the content, grouped. */}
      <div className="hidden lg:sticky lg:top-24 lg:flex lg:flex-col lg:gap-5">
        {PLATFORM_SECTION_GROUPS.map((group) => (
          <div key={group.key} className="flex flex-col gap-1">
            <SectionLabel as="h2" className="px-3">
              {t(`nav.groups.${group.key}`)}
            </SectionLabel>
            <ul className="flex flex-col gap-0.5">
              {group.sections.map(({ key, href, icon: Icon }) => {
                const active = isActive(pathname, href)
                return (
                  <li key={key}>
                    <Link
                      href={href}
                      replace
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        LINK_BASE,
                        'px-3 py-1.5',
                        active
                          ? 'bg-secondary text-foreground font-medium'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                      )}
                    >
                      <Icon
                        className={cn('size-4 shrink-0', active && 'text-foreground')}
                        aria-hidden
                      />
                      {t(`nav.${key}`)}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  )
}
