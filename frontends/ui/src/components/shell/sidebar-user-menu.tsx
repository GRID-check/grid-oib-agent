// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import * as React from 'react'
import { Check, LogOut, Monitor, Moon, Sun } from 'lucide-react'

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
import { cn } from '@/lib/utils'

export interface SidebarUser {
  name?: string | null
  email?: string | null
  image?: string | null
}

export interface SidebarUserMenuProps {
  user?: SidebarUser
  authRequired: boolean
}

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { mode: 'system', label: 'System', icon: Monitor },
  { mode: 'light', label: 'Light', icon: Sun },
  { mode: 'dark', label: 'Dark', icon: Moon },
]

export function SidebarUserMenu({ user, authRequired }: SidebarUserMenuProps) {
  const { signOut } = useAuth()
  const theme = useLayoutStore((s) => s.theme)
  const setTheme = useLayoutStore((s) => s.setTheme)

  const displayName = user?.name || user?.email || 'Default User'
  const initial = String(displayName).charAt(0).toUpperCase()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm',
          'transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
        )}
        aria-label={`User menu for ${displayName}`}
      >
        <Avatar className="size-6">
          {user?.image && <AvatarImage src={user.image} alt="" />}
          <AvatarFallback className="text-[10px] font-medium">{initial}</AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{displayName}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">{displayName}</span>
            {user?.email && user?.name && (
              <span className="text-xs font-normal text-muted-foreground">{user.email}</span>
            )}
            {!authRequired && (
              <span className="text-xs font-normal text-muted-foreground">Authentication not configured</span>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Theme</DropdownMenuLabel>
        {THEME_OPTIONS.map(({ mode, label, icon: Icon }) => (
          <DropdownMenuItem key={mode} onSelect={(e) => { e.preventDefault(); setTheme(mode) }} className="gap-2">
            <Icon className="size-4 text-muted-foreground" />
            <span className="flex-1">{label}</span>
            {theme === mode && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
        {authRequired && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => signOut()} className="gap-2">
              <LogOut className="size-4 text-muted-foreground" />
              Sign out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
