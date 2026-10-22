/**
 * The waiting count, read once per project and shared by every surface; no
 * number for a reader the project refuses (404), and the last number kept
 * when a read merely fails.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { ApiRequestError } from '@/adapters/api/api-error'
import { fixtureClient, LIST_VARIANTS } from '@/app/dev/inbound-mail/fixtures'
import { refreshInboundMailWaiting, resetInboundMailWaitingForTests, useInboundMailWaiting } from './use-inbound-mail-waiting'

beforeEach(() => resetInboundMailWaitingForTests())

describe('useInboundMailWaiting', () => {
  it('counts the waiting mails, one read for every surface', async () => {
    const client = fixtureClient({ list: LIST_VARIANTS.many })
    const list = vi.spyOn(client, 'list')
    const first = renderHook(() => useInboundMailWaiting('p', true, client))
    const second = renderHook(() => useInboundMailWaiting('p', true, client))
    await waitFor(() => expect(first.result.current.count).toBe(8))
    expect(second.result.current).toEqual({ count: 8, more: true })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('reads nothing while off', () => {
    const client = fixtureClient({ list: LIST_VARIANTS.many })
    const list = vi.spyOn(client, 'list')
    const { result } = renderHook(() => useInboundMailWaiting('p', false, client))
    expect(result.current.count).toBeNull()
    expect(list).not.toHaveBeenCalled()
  })

  it('shows no number to a reader the project refuses, and never asks again', async () => {
    const client = fixtureClient()
    const list = vi.spyOn(client, 'list').mockRejectedValue(new ApiRequestError('no', 404))
    const { result } = renderHook(() => useInboundMailWaiting('p', true, client))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    await refreshInboundMailWaiting('p', client)
    expect(list).toHaveBeenCalledTimes(1)
    expect(result.current.count).toBeNull()
  })

  it('keeps the last number when a read fails', async () => {
    const client = fixtureClient({ list: LIST_VARIANTS.one })
    const { result } = renderHook(() => useInboundMailWaiting('p', true, client))
    await waitFor(() => expect(result.current.count).toBe(1))
    vi.spyOn(client, 'list').mockRejectedValue(new ApiRequestError('down', 503))
    await refreshInboundMailWaiting('p', client)
    expect(result.current.count).toBe(1)
  })
})
