'use client'

import * as React from 'react'
import Link from 'next/link'
import { Archive, Building2, Check, Globe, LayoutDashboard, LogOut, Monitor, Moon, Sun, UserRound } from 'lucide-react'

import { useAuth } from '@/adapters/auth/use-auth'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLayoutStore } from '@/features/layout/store'
import type { ThemeMode } from '@/features/layout/types'
import { useTranslations, useLocale, locales } from '@/i18n'
import { cn } from '@/lib/utils'

export interface SidebarUser {
  name?: string | null
  email?: string | null
  image?: string | null
}

export interface SidebarUserMenuProps {
  user?: SidebarUser
  authRequired: boolean
  /** Dropdown side — 'top' for the sidebar footer (default), 'bottom' for a topbar. */
  menuSide?: 'top' | 'bottom'
  /** Dropdown alignment — defaults to 'start'. */
  menuAlign?: 'start' | 'end'
  /** Hide the name label next to the avatar (compact avatar-only trigger). */
  compact?: boolean
  /** Show the org-management entry (org admins only). */
  canManageOrganization?: boolean
  /**
   * Show the organization entry to any org member. The org page serves
   * capability subsets and a member self-usage view, so it is discoverable
   * beyond full admins (UX-16). Falls back to {@link canManageOrganization}
   * for callers that predate this flag.
   */
  canViewOrganization?: boolean
  /** Show the platform dashboard entry (platform owner only, ADR-0016). */
  canManagePlatform?: boolean
  /** Show the org-wide Archiv entry (any org member, when enabled — ADR-0024). */
  canAccessArchiv?: boolean
  /**
   * Tailwind size class for the trigger avatar. Defaults to the sidebar
   * footer's 30px; the org top bar passes a 36px avatar to match the dummy.
   */
  avatarSizeClass?: string
}

const THEME_ICONS: Record<ThemeMode, React.ComponentType<{ className?: string }>> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}
const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark']

export function SidebarUserMenu({
  user,
  authRequired,
  menuSide = 'top',
  menuAlign = 'start',
  compact = false,
  canManageOrganization = false,
  canViewOrganization = false,
  canManagePlatform = false,
  canAccessArchiv = false,
  avatarSizeClass = 'size-[30px]',
}: SidebarUserMenuProps) {
  const { user: authUser, signOut } = useAuth()
  const theme = useLayoutStore((s) => s.theme)
  const setTheme = useLayoutStore((s) => s.setTheme)
  const t = useTranslations('nav')
  const tc = useTranslations('common')
  const { locale, setLocale, localeNames } = useLocale()

  const displayName = user?.name || user?.email || t('userMenu.defaultUser')
  // Two-letter monogram from the first two words (e.g. "Anna Kaufmann" → "AK"),
  // falling back to a single initial for one-word names / email addresses.
  const initial =
    String(displayName)
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word.charAt(0))
      .join('')
      .toUpperCase() || '?'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex items-center gap-2.5 text-left text-sm',
          'transition-[color,background-color,transform] duration-200 ease-out hover:bg-accent',
          'active:scale-[0.98] motion-reduce:transition-none',
          'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
          compact ? 'w-auto rounded-full p-0' : 'w-full rounded-lg py-1 pl-0 pr-2',
        )}
        aria-label={t('userMenu.label', { name: displayName })}
      >
        <span className="flex shrink-0">
          {/* The hairline is not decoration. `AvatarFallback` fills with
              `bg-muted` (L 0.961), and the rail it sits on is
              `--background-color-surface-sunken` (L 0.958) — a 0.3% lightness
              step, so on this one surface the disc is invisible and the
              monogram reads as loose text on the rail. An alpha-ink ring
              composites on whatever surface the avatar lands on, which is
              exactly what the border ramp is for, and it matches how
              `AvatarStack` already separates overlapping discs. */}
          <Avatar className={cn('ring-border ring-1', avatarSizeClass)}>
            {(authUser?.image ?? user?.image) && <AvatarImage src={authUser?.image ?? user?.image ?? undefined} alt="" />}
            <AvatarFallback className="text-xs font-medium">{initial}</AvatarFallback>
          </Avatar>
        </span>
        {!compact && (
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-muted-foreground">{displayName}</span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={menuAlign} side={menuSide} className="w-56 motion-reduce:animate-none">
        <DropdownMenuLabel>
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">{displayName}</span>
            {user?.email && user?.name && (
              <span className="text-xs font-normal text-muted-foreground">{user.email}</span>
            )}
            {!authRequired && (
              <span className="text-xs font-normal text-muted-foreground">{t('userMenu.authNotConfigured')}</span>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="gap-2">
          <Link href="/app/profile">
            <UserRound className="size-4 text-muted-foreground" aria-hidden />
            {t('userMenu.profile')}
          </Link>
        </DropdownMenuItem>
        {canAccessArchiv && (
          <DropdownMenuItem asChild className="gap-2">
            <Link href="/app/archiv">
              <Archive className="size-4 text-muted-foreground" aria-hidden />
              {t('userMenu.archiv')}
            </Link>
          </DropdownMenuItem>
        )}
        {(canViewOrganization || canManageOrganization) && (
          <DropdownMenuItem asChild className="gap-2">
            <Link href="/app/organization">
              <Building2 className="size-4 text-muted-foreground" aria-hidden />
              {t('userMenu.organization')}
            </Link>
          </DropdownMenuItem>
        )}
        {canManagePlatform && (
          <DropdownMenuItem asChild className="gap-2">
            <Link href="/app/platform">
              <LayoutDashboard className="size-4 text-muted-foreground" aria-hidden />
              {t('userMenu.platform')}
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">{tc('theme.label')}</DropdownMenuLabel>
        {THEME_MODES.map((mode) => {
          const Icon = THEME_ICONS[mode]
          return (
            <DropdownMenuItem key={mode} onSelect={(e) => { e.preventDefault(); setTheme(mode) }} className="gap-2">
              <Icon className="size-4 text-muted-foreground" aria-hidden />
              <span className="flex-1">{tc(`theme.${mode}`)}</span>
              {theme === mode && <Check className="size-4" aria-hidden />}
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">{tc('language.label')}</DropdownMenuLabel>
        {locales.map((code) => (
          <DropdownMenuItem key={code} onSelect={(e) => { e.preventDefault(); setLocale(code) }} className="gap-2">
            <Globe className="size-4 text-muted-foreground" aria-hidden />
            <span className="flex-1">{localeNames[code]}</span>
            {locale === code && <Check className="size-4" aria-hidden />}
          </DropdownMenuItem>
        ))}
        {authRequired && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => signOut()} className="gap-2">
              <LogOut className="size-4 text-muted-foreground" aria-hidden />
              {tc('actions.signOut')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
