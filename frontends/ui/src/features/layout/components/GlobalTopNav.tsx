// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import Link from 'next/link'
import { type FC, useCallback, useState } from 'react'
import { BookOpen, ExternalLink, Info, Lock, LogOut, Moon, Sun } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { useAuth } from '@/adapters/auth'
import { ProjectSelector } from '@/components/projects/project-selector'
import { GridLogo } from './GridLogo'
import { useLayoutStore } from '../store'
import type { ThemeMode } from '../types'

const APPEARANCE_SEGMENTS: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'dark', label: 'Dark' },
  { mode: 'light', label: 'Light' },
]

const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL || 'https://docs.grid.ai'

export const GlobalTopNav: FC = () => {
  const { isAuthenticated, authRequired, user, organizationId, signIn, signOut } = useAuth()
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false)

  const handleSignOut = useCallback(() => {
    setIsUserMenuOpen(false)
    signOut()
  }, [signOut])

  return (
    <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur-xl">
      <div className="flex h-16 items-center justify-between gap-4 px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-4">
          <Link
            href="/"
            className="group flex items-center gap-2 rounded-full px-2 py-1 transition hover:bg-accent"
          >
            <GridLogo size={20} />
            <span className="flex flex-col leading-none">
              <span className="text-sm font-semibold tracking-[-0.02em]">Grid</span>
              <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                OIB Agent
              </span>
            </span>
          </Link>
          <nav
            className="hidden items-center gap-1 rounded-full border bg-muted/40 p-1 md:flex"
            aria-label="Primary navigation"
          >
            <Link
              href="/"
              className="rounded-full px-3 py-1.5 text-sm font-medium transition hover:bg-accent"
            >
              Chat
            </Link>
            <Link
              href="/projects"
              className="rounded-full px-3 py-1.5 text-sm font-medium transition hover:bg-accent"
            >
              Projects
            </Link>
          </nav>
          {isAuthenticated && authRequired && <ProjectSelector />}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!authRequired ? (
            <Popover open={isUserMenuOpen} onOpenChange={setIsUserMenuOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Default user - authentication not configured"
                >
                  <Avatar className="size-7">
                    <AvatarFallback>D</AvatarFallback>
                  </Avatar>
                </Button>
              </PopoverTrigger>
              <PopoverContent side="bottom" align="end" className="w-auto p-0">
                <AuthDisabledContent />
              </PopoverContent>
            </Popover>
          ) : isAuthenticated ? (
            <Popover open={isUserMenuOpen} onOpenChange={setIsUserMenuOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`User menu for ${user?.name || user?.email || 'User'}`}
                  title="User menu"
                >
                  <Avatar className="size-7">
                    {user?.image && <AvatarImage src={user.image} alt="" />}
                    <AvatarFallback>
                      {String(user?.name || user?.email || 'U').charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </Button>
              </PopoverTrigger>
              <PopoverContent side="bottom" align="end" className="w-auto p-0">
                <UserDropdownContent
                  user={user ?? undefined}
                  organizationId={organizationId}
                  onSignOut={handleSignOut}
                />
              </PopoverContent>
            </Popover>
          ) : (
            <Button size="sm" onClick={signIn} aria-label="Sign in with SSO">
              <Lock className="h-4 w-4" aria-hidden="true" />
              <span className="text-sm font-semibold">Sign In</span>
            </Button>
          )}
        </div>
      </div>
    </header>
  )
}

interface UserDropdownContentProps {
  user?: { name?: string | null; email?: string | null; image?: string | null }
  organizationId?: string
  onSignOut?: () => void
}

const AppearanceThemeControl: FC = () => {
  const theme = useLayoutStore((s) => s.theme)
  const setTheme = useLayoutStore((s) => s.setTheme)

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-muted-foreground">Appearance</span>
      <div
        className="flex items-center gap-1 rounded-lg bg-muted p-1"
        role="radiogroup"
        aria-label="Theme"
      >
        {APPEARANCE_SEGMENTS.map(({ mode, label }) => {
          const selected = theme === mode
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${label} theme`}
              onClick={() => setTheme(mode)}
              className={cn(
                'flex min-h-8 flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                selected
                  ? 'bg-background font-semibold shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {mode === 'dark' && <Moon className="h-4 w-4 shrink-0" aria-hidden="true" />}
              {mode === 'light' && <Sun className="h-4 w-4 shrink-0" aria-hidden="true" />}
              <span>{label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

const DocumentationSection: FC = () => (
  <div className="flex flex-col gap-2">
    <span className="text-xs text-muted-foreground">Documentation</span>
    <a
      href={DOCS_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="flex w-full items-center justify-between rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent"
    >
      <span className="flex items-center gap-2">
        <BookOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>Docs</span>
      </span>
      <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </a>
  </div>
)

const UserDropdownContent: FC<UserDropdownContentProps> = ({ user, organizationId, onSignOut }) => (
  <div className="flex min-w-[240px] flex-col gap-3 p-4">
    <div className="flex items-center gap-3">
      <Avatar className="size-10">
        {user?.image && <AvatarImage src={user.image} alt="" />}
        <AvatarFallback>
          {String(user?.name || user?.email || 'U').charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold">{user?.name || 'User'}</span>
        {user?.email ? <span className="text-sm text-muted-foreground">{user.email}</span> : null}
        {organizationId ? (
          <span className="text-sm text-muted-foreground">Org: {organizationId}</span>
        ) : null}
      </div>
    </div>
    <Separator />
    <AppearanceThemeControl />
    <Separator />
    <DocumentationSection />
    <Separator />
    <Button variant="outline" size="sm" onClick={onSignOut} className="w-full" aria-label="Sign out">
      <LogOut className="h-4 w-4" aria-hidden="true" />
      <span className="text-sm">Sign Out</span>
    </Button>
  </div>
)

const AuthDisabledContent: FC = () => (
  <div className="flex min-w-[240px] flex-col gap-3 p-4">
    <div className="flex items-center gap-3">
      <Avatar className="size-10">
        <AvatarFallback>D</AvatarFallback>
      </Avatar>
      <span className="text-sm font-semibold">Default User</span>
    </div>
    <div className="flex items-center gap-2 rounded-md border p-3">
      <Info className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="text-sm text-muted-foreground">Authentication Not Configured</span>
    </div>
    <Separator />
    <AppearanceThemeControl />
    <Separator />
    <DocumentationSection />
  </div>
)
