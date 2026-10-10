'use client'

/**
 * The organization's roles, read once per mount (ADR-0087).
 *
 * The custom-roles section edits them. `enabled` lets a surface skip the read
 * while it does not need them.
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
