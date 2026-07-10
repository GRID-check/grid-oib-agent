'use client'

import * as React from 'react'
import Link from 'next/link'
import { Building2, Check, Globe, LayoutDashboard, LogOut, Monitor, Moon, Sun, UserRound } from 'lucide-react'

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
import { motion, springSnappy } from '@/components/motion'
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
}: SidebarUserMenuProps) {
  const { signOut } = useAuth()
  const theme = useLayoutStore((s) => s.theme)
  const setTheme = useLayoutStore((s) => s.setTheme)
  const t = useTranslations('nav')
  const tc = useTranslations('common')
  const { locale, setLocale, localeNames } = useLocale()

  const displayName = user?.name || user?.email || t('userMenu.defaultUser')
  const initial = String(displayName).charAt(0).toUpperCase()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex items-center gap-2.5 text-left text-sm',
          'transition-colors duration-200 ease-out hover:bg-accent',
          'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
          compact ? 'w-auto rounded-full p-1' : 'h-9 w-full rounded-lg px-2',
        )}
        aria-label={t('userMenu.label', { name: displayName })}
      >
        <motion.span className="flex shrink-0" whileTap={{ scale: 0.95 }} transition={springSnappy}>
          <Avatar className="size-6">
            {user?.image && <AvatarImage src={user.image} alt="" />}
            <AvatarFallback className="text-xs font-medium">{initial}</AvatarFallback>
          </Avatar>
        </motion.span>
        {!compact && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{displayName}</span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={menuAlign} side={menuSide} className="w-56">
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
