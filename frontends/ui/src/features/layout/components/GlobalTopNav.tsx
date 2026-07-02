// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import Link from 'next/link'
import { type FC, useCallback, useState } from 'react'
import { Avatar, Button, Divider, Flex, Logo, Popover, Text } from '@/adapters/ui'
import { Book, Info, Lock, Logout, Moon, OpenExternal, Sun } from '@/adapters/ui/icons'
import { useAuth } from '@/adapters/auth'
import { ProjectSelector } from '@/components/projects/project-selector'
import { useLayoutStore } from '../store'
import type { ThemeMode } from '../types'

const APPEARANCE_SEGMENTS: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'dark', label: 'Dark' },
  { mode: 'light', label: 'Light' },
]

const DOCS_URL = '/docs'

export const GlobalTopNav: FC = () => {
  const { isAuthenticated, authRequired, user, organizationId, signIn, signOut } = useAuth()
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false)

  const handleSignOut = useCallback(() => {
    setIsUserMenuOpen(false)
    signOut()
  }, [signOut])

  return (
    <header className="sticky top-0 z-50 border-b border-base bg-surface-base/95 backdrop-blur-xl">
      <Flex align="center" justify="between" className="h-16 gap-4 px-4 md:px-6">
        <Flex align="center" gap="4" className="min-w-0">
          <Link href="/" className="group flex items-center gap-2 rounded-full px-2 py-1 transition hover:bg-surface-raised-50">
            <Logo kind="logo-only" size="small" />
            <Flex direction="col" gap="0" className="leading-none">
              <Text kind="label/semibold/md" className="text-primary tracking-[-0.02em]">Grid</Text>
              <Text kind="body/regular/xs" className="text-subtle uppercase tracking-[0.18em]">OIB Agent</Text>
            </Flex>
          </Link>
          <nav className="hidden items-center gap-1 rounded-full border border-base bg-surface-raised-30 p-1 md:flex" aria-label="Primary navigation">
            <Link href="/" className="rounded-full px-3 py-1.5 text-sm font-medium text-primary transition hover:bg-surface-sunken">
              Chat
            </Link>
            <Link href="/projects" className="rounded-full px-3 py-1.5 text-sm font-medium text-primary transition hover:bg-surface-sunken">
              Projects
            </Link>
          </nav>
          {isAuthenticated && authRequired && <ProjectSelector />}
        </Flex>

        <Flex align="center" gap="2" className="shrink-0">
          {!authRequired ? (
            <Popover
              open={isUserMenuOpen}
              onOpenChange={setIsUserMenuOpen}
              side="bottom"
              align="end"
              className="bg-surface-base"
              slotContent={<AuthDisabledContent />}
            >
              <Button kind="tertiary" size="small" aria-label="Default user - authentication not configured">
                <Avatar size="small" fallback="D" />
              </Button>
            </Popover>
          ) : isAuthenticated ? (
            <Popover
              open={isUserMenuOpen}
              onOpenChange={setIsUserMenuOpen}
              side="bottom"
              align="end"
              className="bg-surface-base"
              slotContent={
                <UserDropdownContent
                  user={user ?? undefined}
                  organizationId={organizationId}
                  onSignOut={handleSignOut}
                />
              }
            >
              <Button
                kind="tertiary"
                size="small"
                aria-label={`User menu for ${user?.name || user?.email || 'User'}`}
                title="User menu"
              >
                <Avatar
                  size="small"
                  src={user?.image ?? undefined}
                  fallback={String(user?.name || user?.email || 'U').charAt(0).toUpperCase()}
                />
              </Button>
            </Popover>
          ) : (
            <Button kind="primary" size="small" onClick={signIn} aria-label="Sign in with SSO">
              <Flex align="center" gap="1">
                <Lock className="h-4 w-4" />
                <Text kind="label/semibold/sm">Sign In</Text>
              </Flex>
            </Button>
          )}
        </Flex>
      </Flex>
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
    <Flex direction="col" gap="2">
      <Text kind="label/regular/sm" className="text-subtle">Appearance</Text>
      <Flex align="center" gap="1" className="rounded-lg bg-surface-raised-50 p-1" role="radiogroup" aria-label="Theme">
        {APPEARANCE_SEGMENTS.map(({ mode, label }) => {
          const selected = theme === mode
          return (
            <Button
              key={mode}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${label} theme`}
              kind="tertiary"
              size="small"
              onClick={() => setTheme(mode)}
              className={`h-auto min-h-9 flex-1 rounded-md border-0 px-2 py-1.5 shadow-none ${selected ? '!bg-black !text-white hover:!bg-black' : 'bg-transparent'}`}
            >
              <Flex align="center" justify="center" gap="1" className="w-full">
                {mode === 'dark' ? <Moon className={`h-4 w-4 ${selected ? '!text-white' : 'text-primary'}`} /> : null}
                {mode === 'light' ? <Sun className={`h-4 w-4 ${selected ? '!text-white' : 'text-primary'}`} /> : null}
                <Text kind={selected ? 'label/semibold/sm' : 'label/regular/sm'} className={selected ? 'text-white' : 'text-primary'}>{label}</Text>
              </Flex>
            </Button>
          )
        })}
      </Flex>
    </Flex>
  )
}

const DocumentationSection: FC = () => (
  <Flex direction="col" gap="2">
    <Text kind="label/regular/sm" className="text-subtle">Documentation</Text>
    <a
      href={DOCS_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="flex w-full items-center justify-between rounded-md px-2 py-2 text-primary transition-colors hover:bg-surface-raised-50"
    >
      <Flex align="center" gap="2">
        <Book className="h-4 w-4 shrink-0" />
        <Text kind="label/regular/sm">Docs</Text>
      </Flex>
      <OpenExternal className="h-4 w-4 shrink-0 text-subtle" />
    </a>
  </Flex>
)

const UserDropdownContent: FC<UserDropdownContentProps> = ({ user, organizationId, onSignOut }) => (
  <Flex direction="col" gap="3" className="min-w-[240px] p-4">
    <Flex align="center" gap="3">
      <Avatar size="medium" src={user?.image ?? undefined} fallback={String(user?.name || user?.email || 'U').charAt(0).toUpperCase()} />
      <Flex direction="col" gap="1">
        <Text kind="label/bold/md" className="text-primary">{user?.name || 'User'}</Text>
        {user?.email ? <Text kind="body/regular/sm" className="text-subtle">{user.email}</Text> : null}
        {organizationId ? <Text kind="body/regular/sm" className="text-subtle">Org: {organizationId}</Text> : null}
      </Flex>
    </Flex>
    <Divider />
    <AppearanceThemeControl />
    <Divider />
    <DocumentationSection />
    <Divider />
    <Button kind="secondary" size="small" onClick={onSignOut} className="w-full" aria-label="Sign out">
      <Flex align="center" justify="center" gap="2">
        <Logout className="h-4 w-4" />
        <Text kind="label/regular/sm">Sign Out</Text>
      </Flex>
    </Button>
  </Flex>
)

const AuthDisabledContent: FC = () => (
  <Flex direction="col" gap="3" className="min-w-[240px] p-4">
    <Flex align="center" gap="3">
      <Avatar size="medium" fallback="D" />
      <Text kind="label/bold/md" className="text-primary">Default User</Text>
    </Flex>
    <Flex align="center" gap="2" className="rounded border border-base p-3">
      <Info className="h-4 w-4 shrink-0 text-[var(--text-color-subtle)]" />
      <Text kind="body/regular/sm" className="text-subtle">Authentication Not Configured</Text>
    </Flex>
    <Divider />
    <AppearanceThemeControl />
    <Divider />
    <DocumentationSection />
  </Flex>
)
