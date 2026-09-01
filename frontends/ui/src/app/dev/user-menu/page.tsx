'use client'

/**
 * Dev preview for the avatar menu (visual/registry.mjs → `user-menu`). Not
 * linked anywhere and 404s outside development.
 *
 * What this is evidence of: theme and language are SUBMENU rows now — one row
 * each naming the current value, instead of the eight standing rows that made
 * the menu taller than the rail's footer. The menu is driven open by keyboard
 * (the trigger opens on pointerdown, which a synthetic click never produces),
 * the same way the folder-menu fixture drives its dropdown.
 */

import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { notFound } from 'next/navigation'
import { SidebarUserMenu } from '@/components/shell/sidebar-user-menu'

export default function UserMenuDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  const driven = useRef(false)
  useEffect(() => {
    if (driven.current) return
    driven.current = true
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-testid="user-menu-preview"] button'
    )
    if (!trigger) return
    trigger.focus()
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }, [])

  return (
    <main
      data-testid="user-menu-preview"
      className="bg-background text-foreground flex min-h-dvh items-end p-8"
    >
      <div className="w-56">
        <SidebarUserMenu
          user={{ name: 'Anna Berger', email: 'anna.berger@example.at' }}
          organizationName="Musterarchitektur ZT GmbH"
          authRequired
          canManageOrganization
          canViewOrganization
          canManagePlatform
        />
      </div>
    </main>
  )
}
