// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Org-level top frame for surfaces that live above a project (the projects
 * list, onboarding). Deliberately lightweight: brand mark on the left, the
 * shared user + theme menu on the right. It reuses {@link SidebarUserMenu} so
 * the identity/theme controls are identical to the in-project sidebar — no
 * second, competing shell.
 */

import Link from 'next/link'

import { Logo } from '@/components/brand/logo'
import { SidebarUserMenu, type SidebarUser } from './sidebar-user-menu'

export interface OrgTopbarProps {
  user?: SidebarUser
  authRequired: boolean
  /** Optional context label shown next to the wordmark (e.g. "Projects"). */
  heading?: string
}

export function OrgTopbar({ user, authRequired, heading }: OrgTopbarProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-4 px-4 md:px-8">
        <div className="flex items-center gap-3">
          <Link
            href="/projects"
            className="rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            aria-label="Grid — all projects"
          >
            <Logo kind="horizontal" size="small" />
          </Link>
          {heading && (
            <>
              <span className="h-4 w-px bg-border" aria-hidden />
              <span className="text-sm font-medium text-muted-foreground">{heading}</span>
            </>
          )}
        </div>
        <SidebarUserMenu
          user={user}
          authRequired={authRequired}
          menuSide="bottom"
          menuAlign="end"
          compact
        />
      </div>
    </header>
  )
}
