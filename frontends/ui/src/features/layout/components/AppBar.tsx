// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AppBar Component
 *
 * Top navigation bar with menu toggle, logo, session title,
 * and action buttons (Add Sources, User Avatar).
 *
 * Shows different states based on authentication:
 * - Auth disabled: Default User avatar with info tooltip (no sign in/out)
 * - Logged out: Sign In button, disabled action buttons
 * - Logged in: User avatar with dropdown menu
 */

'use client'

import { type FC, memo, useCallback, useState } from 'react'
import {
  Globe,
  BookOpen,
  Lock,
  LogOut,
  ExternalLink,
  Info,
  Moon,
  Sun,
  MessageSquareText,
} from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { GridLogo } from './GridLogo'
import { useLayoutStore } from '../store'
import type { ThemeMode } from '../types'

import { useAuth } from '@/adapters/auth'
import { ProjectSelector } from '@/components/projects/project-selector'

interface AppBarProps {
  /** Current session title to display */
  sessionTitle?: string
  /** Callback when a new session is requested */
  onNewSession?: () => void
  /** Disable creating a new session while shallow research/HITL is active */
  isNewSessionDisabled?: boolean
}

/**
 * Main navigation bar at the top of the application.
 * Controls sidebar toggles and navigation actions.
 */
export const AppBar: FC<AppBarProps> = memo(function AppBar({
  sessionTitle = '',
  onNewSession,
  isNewSessionDisabled = false,
}) {
  const { isAuthenticated, authRequired, user, organizationId, signIn, signOut } = useAuth()
  const toggleSessionsPanel = useLayoutStore((s) => s.toggleSessionsPanel)
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false)

  const handleMenuClick = useCallback(() => {
    if (!isAuthenticated) return
    toggleSessionsPanel()
  }, [toggleSessionsPanel, isAuthenticated])

  const handleAddSourcesClick = useCallback(() => {
    if (!isAuthenticated) return
    const { rightPanel, closeRightPanel, openRightPanel } = useLayoutStore.getState()
    if (rightPanel === 'data-sources') {
      closeRightPanel()
    } else {
      openRightPanel('data-sources')
    }
  }, [isAuthenticated])

  const handleNewSessionClick = useCallback(() => {
    if (!isAuthenticated || isNewSessionDisabled) return
    onNewSession?.()
  }, [isAuthenticated, isNewSessionDisabled, onNewSession])

  const handleSignOut = useCallback(() => {
    setIsUserMenuOpen(false)
    signOut()
  }, [signOut])

  return (
    <header className="border-b">
      <div className="flex h-[var(--header-height)] items-center justify-between gap-4 px-4">
        {/* Left section: New session button + Sessions toggle */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleNewSessionClick}
            disabled={!isAuthenticated || isNewSessionDisabled}
            aria-label="Create new session"
            title={
              isNewSessionDisabled
                ? 'Cannot create new session while shallow research is active'
                : 'Create new session'
            }
          >
            <GridLogo size={20} />
            <span className="whitespace-nowrap text-sm font-semibold">Grid</span>
          </Button>
          <Separator orientation="vertical" className="h-5" />
          <Button
            variant="ghost"
            size="sm"
            onClick={handleMenuClick}
            disabled={!isAuthenticated}
            aria-label="Toggle sessions sidebar"
            title="Toggle sessions sidebar"
          >
            <MessageSquareText className="h-4 w-4" aria-hidden="true" />
            <span className="text-sm font-semibold">Sessions</span>
          </Button>
          {isAuthenticated && authRequired && <ProjectSelector />}
          {sessionTitle && <Separator orientation="vertical" className="h-5" />}
          {isAuthenticated && (
            <div className="ml-4 hidden min-w-0 flex-1 items-center md:flex">
              <span className="block w-full max-w-[360px] truncate text-sm text-muted-foreground lg:max-w-[480px] xl:max-w-[560px]">
                {sessionTitle}
              </span>
            </div>
          )}
        </div>

        {/* Right section: Actions + User */}
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleAddSourcesClick}
            disabled={!isAuthenticated}
            aria-label="Add data sources"
            title="Add data sources"
          >
            <Globe className="h-4 w-4" aria-hidden="true" />
            <span className="text-sm">Data Sources</span>
          </Button>

          {/* User section: Auth not required notice, Avatar with dropdown, or Sign In button */}
          {!authRequired ? (
            <Popover open={isUserMenuOpen} onOpenChange={setIsUserMenuOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Default User - Authentication Not Configured"
                  title="Default User set. Authentication Not Configured."
                  className="ml-2"
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
                  className="ml-2"
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
            <Button
              size="sm"
              onClick={signIn}
              aria-label="Sign in with SSO"
              title="Sign in with SSO"
              className="ml-2"
            >
              <Lock className="h-4 w-4" aria-hidden="true" />
              <span className="text-sm font-semibold">Sign In</span>
            </Button>
          )}
        </div>
      </div>
    </header>
  )
})

/**
 * User dropdown content with profile info and sign out button
 */
interface UserDropdownContentProps {
  user?: {
    name?: string | null
    email?: string | null
    image?: string | null
  }
  organizationId?: string
  onSignOut?: () => void
}

const APPEARANCE_SEGMENTS: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'dark', label: 'Dark' },
  { mode: 'light', label: 'Light' },
]

const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL || 'https://docs.grid.ai'

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

const DocumentationSection: FC = () => {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-muted-foreground">Documentation</span>
      <a
        href={DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open documentation"
        className="flex w-full items-center justify-between rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Docs</span>
        </span>
        <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </a>
    </div>
  )
}

const UserDropdownContent: FC<UserDropdownContentProps> = ({ user, organizationId, onSignOut }) => {
  return (
    <div className="flex min-w-[240px] flex-col gap-3 p-4">
      {/* User info section */}
      <div className="flex items-center gap-3">
        <Avatar className="size-10">
          {user?.image && <AvatarImage src={user.image} alt="" />}
          <AvatarFallback>
            {String(user?.name || user?.email || 'U').charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold">{user?.name || 'User'}</span>
          {user?.email && <span className="text-sm text-muted-foreground">{user.email}</span>}
          {organizationId && (
            <span className="text-sm text-muted-foreground">Org: {organizationId}</span>
          )}
        </div>
      </div>

      <Separator />

      <AppearanceThemeControl />

      <Separator />

      <DocumentationSection />

      <Separator />

      {/* Sign out button */}
      <Button
        variant="outline"
        size="sm"
        onClick={onSignOut}
        className="w-full"
        aria-label="Sign out"
        title="Sign out"
      >
        <LogOut className="h-4 w-4" aria-hidden="true" />
        <span className="text-sm">Sign Out</span>
      </Button>
    </div>
  )
}

/**
 * Content shown when authentication is disabled
 * Displays info message instead of sign out option
 */
const AuthDisabledContent: FC = () => {
  return (
    <div className="flex min-w-[240px] flex-col gap-3 p-4">
      {/* User info section */}
      <div className="flex items-center gap-3">
        <Avatar className="size-10">
          <AvatarFallback>D</AvatarFallback>
        </Avatar>
        <span className="text-sm font-semibold">Default User</span>
      </div>

      {/* Info message */}
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
}
