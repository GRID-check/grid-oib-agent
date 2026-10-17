'use client'

/**
 * The project's inbound mail address, as the settings section needs it.
 *
 * The wire shape is `lib/inbound-mail/contract.ts`, shared with the routes, and
 * every response is parsed against it here: a body that does not match is an
 * error state, never an `undefined` address rendered into the copy field.
 *
 * `hidden` folds the answers the section draws nothing for into one:
 * `enabled: false`, which the service answers when the deployment has no
 * inbound mail domain or the organization's `project-mail-inbox` flag is off
 * (always with `address: null`), and a refusal from the route (404/403, the
 * caller lacks document write access). The page already gates on that
 * permission, so a refusal only happens when a grant changed since the page
 * rendered.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  inboundAddressResponseSchema,
  rotateInboundAddressResponseSchema,
} from '@/lib/inbound-mail/contract'

export type InboundAddressState =
  | { status: 'loading' }
  | { status: 'hidden' }
  | { status: 'error' }
  | { status: 'ready'; address: string; canRotate: boolean }

const addressUrl = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/inbound-address`

async function loadInboundAddress(projectId: string): Promise<InboundAddressState> {
  const response = await fetch(addressUrl(projectId))
  if (response.status === 404 || response.status === 403) return { status: 'hidden' }
  if (!response.ok) return { status: 'error' }
  const parsed = inboundAddressResponseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) return { status: 'error' }
  const { enabled, address, canRotate } = parsed.data
  if (!enabled || address === null) return { status: 'hidden' }
  return { status: 'ready', address, canRotate }
}

/**
 * Mint a new address, revoking the old one. Throws when the route refuses or
 * answers something that is not the contract, so the caller keeps its confirm
 * dialog open.
 */
async function requestRotation(projectId: string): Promise<string> {
  const response = await fetch(`${addressUrl(projectId)}/rotate`, { method: 'POST' })
  if (!response.ok) throw new Error(`rotate failed (${response.status})`)
  const parsed = rotateInboundAddressResponseSchema.safeParse(
    await response.json().catch(() => null)
  )
  if (!parsed.success) throw new Error('rotate answered outside the contract')
  return parsed.data.address
}

export function useInboundAddress(projectId: string): {
  state: InboundAddressState
  reload: () => void
  rotate: () => Promise<void>
} {
  const [state, setState] = useState<InboundAddressState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    loadInboundAddress(projectId)
      .catch((): InboundAddressState => ({ status: 'error' }))
      .then((next) => {
        if (!cancelled) setState(next)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, attempt])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  const rotate = useCallback(async () => {
    const address = await requestRotation(projectId)
    setState((prev) => (prev.status === 'ready' ? { ...prev, address } : prev))
  }, [projectId])

  return { state, reload, rotate }
}
