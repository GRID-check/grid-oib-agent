/**
 * @vitest-environment node
 */

/**
 * The ONE mounts state. Four surfaces read it, so what these tests hold is the
 * invariants those surfaces depend on rather than the shape of the state:
 *
 * - a mount produces a chip AND a notice, in one write;
 * - an undo removes the chip and KEEPS the notice, because the mount happened;
 * - a failed undo keeps BOTH, because the project is still in view;
 * - a refusal is stored as a code, never as a sentence.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMountsSlice, canMountMore, initialMountsState } from './mounts-store'
import { MountRefusedError } from '@/adapters/api'
import type { ChatStore } from '../types'

vi.mock('@/adapters/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/adapters/api')>()
  return {
    ...actual,
    mountsClient: {
      list: vi.fn(),
      mount: vi.fn(),
      unmount: vi.fn(),
    },
  }
})

const { mountsClient } = await import('@/adapters/api')
const client = mountsClient as unknown as {
  list: ReturnType<typeof vi.fn>
  mount: ReturnType<typeof vi.fn>
  unmount: ReturnType<typeof vi.fn>
}

/** A minimal zustand-shaped harness: the slice under test and nothing else. */
const makeSlice = () => {
  let state = { ...initialMountsState } as Record<string, unknown>
  const get = (): ChatStore => state as unknown as ChatStore
  const set = (patch: unknown): void => {
    const next = typeof patch === 'function' ? (patch as (s: unknown) => object)(state) : patch
    state = { ...state, ...(next as object) }
  }
  const slice = createMountsSlice(
    set as never,
    get as never,
    {} as never
  )
  state = { ...state, ...slice }
  return { get }
}

const mount = (projectId: string, projectName: string) => ({
  projectId,
  projectName,
  mountedBy: 'user' as const,
  mountedAt: '2026-09-08T10:00:00.000Z',
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('loading', () => {
  it('takes the cap from the SERVER, never from a client constant', async () => {
    client.list.mockResolvedValue({ mounts: [mount('a', 'A')], cap: 3 })
    const { get } = makeSlice()

    await get().loadMounts('conv-1')

    expect(get().mountCap).toBe(3)
    expect(get().mounts).toHaveLength(1)
  })

  it('drops the previous conversation’s mounts before the fetch, not after it', async () => {
    client.list.mockResolvedValue({ mounts: [mount('a', 'A')], cap: 5 })
    const { get } = makeSlice()
    await get().loadMounts('conv-1')

    let resolve: ((value: unknown) => void) | undefined
    client.list.mockReturnValue(new Promise((r) => (resolve = r)))
    const pending = get().loadMounts('conv-2')

    // Mid-flight: the chip must not be standing over the new conversation.
    expect(get().mounts).toEqual([])
    resolve?.({ mounts: [], cap: 5 })
    await pending
  })

  it('does not race a write it would overwrite', async () => {
    // `?mount=` creates the conversation and mounts into it, and the surface
    // asks for the list the moment that conversation exists. A GET that landed
    // before the POST committed would answer without the mount and win.
    let settle: ((value: unknown) => void) | undefined
    client.mount.mockReturnValue(new Promise((r) => (settle = r)))
    const { get } = makeSlice()
    const inFlight = get().mountProject('conv-1', 'a', 'A')

    await get().loadMounts('conv-1')
    expect(client.list).not.toHaveBeenCalled()

    settle?.(mount('a', 'A'))
    await inFlight
    expect(get().mounts).toHaveLength(1)
  })

  it('raises no refusal when the LIST fails — the reader asked for nothing', async () => {
    client.list.mockRejectedValue(new Error('offline'))
    const { get } = makeSlice()

    await get().loadMounts('conv-1')

    expect(get().mountRefusal).toBeNull()
    expect(get().mountsLoading).toBe(false)
  })
})

describe('mounting', () => {
  it('produces the chip and the notice in one write', async () => {
    client.mount.mockResolvedValue(mount('a', 'Seestadt Nord'))
    const { get } = makeSlice()

    await expect(get().mountProject('conv-1', 'a', 'Seestadt Nord')).resolves.toBe(true)

    expect(get().mounts.map((m) => m.projectName)).toEqual(['Seestadt Nord'])
    expect(get().mountNotices).toMatchObject([{ projectId: 'a', by: 'user' }])
  })

  it('is idempotent: re-mounting adds no second chip and no second notice', async () => {
    client.mount.mockResolvedValue(mount('a', 'Seestadt Nord'))
    const { get } = makeSlice()

    await get().mountProject('conv-1', 'a', 'Seestadt Nord')
    await get().mountProject('conv-1', 'a', 'Seestadt Nord')

    expect(get().mounts).toHaveLength(1)
    expect(get().mountNotices).toHaveLength(1)
  })

  it('carries the reason the URL gives, so the notice says WHY', async () => {
    client.mount.mockResolvedValue(mount('a', 'Seestadt Nord'))
    const { get } = makeSlice()

    await get().mountProject('conv-1', 'a', undefined, 'fromProject')

    expect(get().mountNotices[0]?.by).toBe('fromProject')
  })

  it('stores a refusal as a CODE plus the numbers its offer needs', async () => {
    client.mount.mockRejectedValue(
      new MountRefusedError('cap', 409, 'cap', { cap: 5, mounted: ['A'] })
    )
    const { get } = makeSlice()

    await expect(get().mountProject('conv-1', 'z', 'Zeta')).resolves.toBe(false)

    expect(get().mountRefusal).toEqual({ code: 'cap', projectName: 'Zeta', cap: 5 })
    expect(get().mounts).toEqual([])
    expect(get().mountNotices).toEqual([])
  })

  it('reads any non-refusal failure as `unavailable` — not the reader’s doing', async () => {
    client.mount.mockRejectedValue(new Error('network'))
    const { get } = makeSlice()

    await get().mountProject('conv-1', 'z', 'Zeta')

    expect(get().mountRefusal?.code).toBe('unavailable')
  })
})

describe('unmounting', () => {
  it('removes the chip and KEEPS the notice, which now says it was undone', async () => {
    client.mount.mockResolvedValue(mount('a', 'Seestadt Nord'))
    client.unmount.mockResolvedValue(undefined)
    const { get } = makeSlice()
    await get().mountProject('conv-1', 'a', 'Seestadt Nord')

    await get().unmountProject('conv-1', 'a')

    expect(get().mounts).toEqual([])
    expect(get().mountNotices).toHaveLength(1)
    expect(get().mountNotices[0]?.undone).toBe(true)
  })

  it('keeps the chip when the undo FAILS — the project is still in view', async () => {
    client.mount.mockResolvedValue(mount('a', 'Seestadt Nord'))
    client.unmount.mockRejectedValue(new Error('boom'))
    const { get } = makeSlice()
    await get().mountProject('conv-1', 'a', 'Seestadt Nord')

    await expect(get().unmountProject('conv-1', 'a')).resolves.toBe(false)

    expect(get().mounts).toHaveLength(1)
    expect(get().mountNotices[0]?.undoFailed).toBe(true)
    expect(get().mountNotices[0]?.undone).toBeFalsy()
  })
})

describe('the agent’s own mount', () => {
  it('lands as a chip and a notice attributed to Piloti', () => {
    const { get } = makeSlice()

    get().applyMountEvent({
      type: 'mount',
      status: 'mounted',
      projectId: 'a',
      projectName: 'Seestadt Nord',
      mountedBy: 'agent',
    })

    expect(get().mounts[0]?.mountedBy).toBe('agent')
    expect(get().mountNotices[0]?.by).toBe('agent')
  })

  it('widens NOTHING when the office refused it', () => {
    const { get } = makeSlice()

    get().applyMountEvent({
      type: 'mount',
      status: 'refused',
      code: 'no_access',
      projectId: 'a',
    })

    expect(get().mounts).toEqual([])
    expect(get().mountNotices).toEqual([])
    expect(get().mountRefusal?.code).toBe('no_access')
  })
})

describe('the cap', () => {
  it('is not reachable before the server has stated it', () => {
    expect(canMountMore({ mounts: [], mountCap: 0 })).toBe(false)
    expect(canMountMore({ mounts: [], mountCap: 5 })).toBe(true)
    expect(canMountMore({ mounts: [mount('a', 'A')], mountCap: 1 })).toBe(false)
  })
})
