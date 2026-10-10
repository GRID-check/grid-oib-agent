'use client'

/**
 * Section nav for a settings tier: a sticky rail beside the content on `lg` and
 * up, a horizontally scrolling strip below that.
 *
 * Written once for the organization tier and lifted here when the project
 * settings needed the same thing, so the two tiers move between their sections
 * the same way and a token retune reaches both. The caller decides which
 * sections exist and in which order; this only draws them and works out which
 * one is current.
 *
 * Labels are always visible: a settings surface is visited rarely and should
 * not ask anyone to decode icons. Switching `replace`s the URL, because the
 * sections are a switcher, not a stack: Back leaves the tier in one step instead
 * of walking every section that was looked at.
 */

import type { JSX } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { motion, springGlide } from '@/components/motion'

export interface SectionNavItem {
  key: string
  href: string
  icon: LucideIcon
  label: string
}

export interface SectionNavProps {
  /** Accessible name of the `<nav>`. */
  label: string
  /** Visible sections, in reading order. */
  items: readonly SectionNavItem[]
  /**
   * The tier's root href. It matches only exactly, because a prefix test would
   * light it up on every section beneath it.
   */
  rootHref: string
  /** Shared-layout id of the active pill; one per tier, so two navs never trade it. */
  pillId: string
  /**
   * `rail` (default): a sticky rail beside the content from `lg`, a strip
   * below. `tabs`: the strip at every width, above the content, for a tier
   * whose pages are wide dashboards rather than forms.
   */
  orientation?: 'rail' | 'tabs'
  /**
   * Where the desktop rail sticks. The organization tier scrolls the whole
   * shell, under its header; a project section scrolls its own body, under
   * nothing.
   */
  railTopClassName?: string
  'data-testid'?: string
}

/**
 * Sections match their own route and anything nested under it, on a path
 * boundary: a bare `startsWith` would also mark `/x/access` active on a sibling
 * such as `/x/access-log`.
 */
export function isSectionActive(pathname: string | null, href: string, rootHref: string): boolean {
  if (!pathname) return false
  if (href === rootHref) return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function SectionNav({
  label,
  items,
  rootHref,
  pillId,
  orientation = 'rail',
  railTopClassName = 'lg:top-24',
  'data-testid': testId,
}: SectionNavProps): JSX.Element {
  const pathname = usePathname()

  return (
    <nav aria-label={label} data-testid={testId}>
      {/* Mobile / tablet: a scrolling strip. Wide content scrolls in its own
          container so the page body never scrolls horizontally. */}
      <ul className={cn('flex gap-1 overflow-x-auto pb-2', orientation === 'rail' && 'lg:hidden')}>
        {items.map((item) => (
          <li key={item.key} className="shrink-0">
            <SectionNavLink
              item={item}
              active={isSectionActive(pathname, item.href, rootHref)}
              pillId={pillId}
              variant="strip"
            />
          </li>
        ))}
      </ul>

      {/* Desktop: a sticky rail beside the content. */}
      {orientation === 'rail' && (
        <ul className={cn('hidden lg:sticky lg:flex lg:flex-col lg:gap-0.5', railTopClassName)}>
          {items.map((item) => (
            <li key={item.key}>
              <SectionNavLink
                item={item}
                active={isSectionActive(pathname, item.href, rootHref)}
                pillId={pillId}
                variant="rail"
              />
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}

function SectionNavLink({
  item,
  active,
  pillId,
  variant,
}: {
  item: SectionNavItem
  active: boolean
  pillId: string
  variant: 'strip' | 'rail'
}): JSX.Element {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      replace
      aria-current={active ? 'page' : undefined}
      className={cn(
        // `relative isolate` + pill `-z-10` is the app-sidebar rail pattern:
        // the active surface glides on `springGlide` below the ink.
        'duration-quick focus-visible:ring-ring/60 relative isolate items-center rounded-md text-sm transition-colors ease-out focus-visible:outline-none focus-visible:ring-2',
        variant === 'strip' ? 'inline-flex gap-1.5 px-3 py-1.5' : 'flex gap-2 px-3 py-2',
        active
          ? 'text-secondary-foreground font-medium'
          : cn(
              'text-muted-foreground hover:bg-accent',
              variant === 'rail' && 'hover:text-foreground'
            )
      )}
    >
      {active && (
        <motion.span
          layoutId={pillId}
          aria-hidden
          data-slot="section-nav-pill"
          className="bg-secondary absolute inset-0 -z-10 rounded-[inherit]"
          transition={springGlide}
        />
      )}
      <Icon className="size-4 shrink-0" aria-hidden />
      {item.label}
    </Link>
  )
}
