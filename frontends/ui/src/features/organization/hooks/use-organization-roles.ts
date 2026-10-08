'use client'

/**
 * The organization's roles, read once per mount (ADR-0086).
 *
 * Two surfaces need them: the custom-roles section, which edits them, and the
 * project Files view, which names them on a restricted folder's lock and offers
 * them in the folder access dialog. `enabled` lets Files skip the read entirely
 * while nothing on screen is restricted and no dialog is open.
 */

import { useCallback, useEffect, useState } from 'react'
import { listOrganizationRoles, type OrganizationRoles } from '@/adapters/api/organization-roles-client'

export interface OrganizationRolesState {
  data: OrganizationRoles | null
  failed: boolean
  /** Read again; resolves once the new answer (or the failure) is in state. */
  reload: () => Promise<void>
}

export function useOrganizationRoles(enabled = true): OrganizationRolesState {
  const [data, setData] = useState<OrganizationRoles | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    setFailed(false)
    try {
      setData(await listOrganizationRoles(signal))
    } catch {
      if (!signal?.aborted) setFailed(true)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [enabled, load])

  return { data, failed, reload: () => load() }
}

/** Slug → name, for showing the roles a folder names. An unknown slug shows as itself. */
export function roleNamesFor(slugs: readonly string[], roles: OrganizationRoles | null): string[] {
  const names = new Map((roles?.roles ?? []).map((role) => [role.slug, role.name]))
  return slugs.map((slug) => names.get(slug) ?? slug)
}
