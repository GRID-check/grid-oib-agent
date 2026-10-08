'use client'

/**
 * Which `platform:*` permissions the viewer holds, for the platform shell's
 * client components.
 *
 * The shell's gate (`layout.tsx`) admits every platform staff member, including
 * the read-only `org-platform-support` role, and each route underneath checks its
 * own permission. The UI used to ignore that split: a support member saw the
 * price-list Save, the storage pencil, Reconcile, Kill all and the base-knowledge
 * Upload/Delete, and every one of them answered 403. This context lets a write
 * control ask before it renders.
 *
 * It is a rendering hint, never authorization: the route stays the gate. With no
 * provider mounted (the `/dev` previews) every permission reads as held, so a
 * preview shows the full surface.
 */

import type { JSX, ReactNode } from 'react'
import { createContext, useContext, useMemo } from 'react'

import type { PlatformPermission } from '@/lib/authz/permissions'

const PlatformAccessContext = createContext<ReadonlySet<string> | null>(null)

export function PlatformAccessProvider({
  permissions,
  children,
}: {
  permissions: readonly string[]
  children: ReactNode
}): JSX.Element {
  const value = useMemo(() => new Set(permissions), [permissions])
  return <PlatformAccessContext.Provider value={value}>{children}</PlatformAccessContext.Provider>
}

/** True when the viewer holds `permission` (or no provider is mounted). */
export function usePlatformCan(permission: PlatformPermission): boolean {
  const permissions = useContext(PlatformAccessContext)
  return permissions === null || permissions.has(permission)
}
