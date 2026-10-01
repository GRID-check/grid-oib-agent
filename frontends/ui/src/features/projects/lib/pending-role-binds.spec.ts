import { describe, expect, it, vi } from 'vitest'
import {
  createUploadTracker,
  pendingBindsFromDraft,
  persistedBauwerkIds,
  sendPendingBinds,
  withPendingBind,
  withoutBauwerk,
  withoutPendingBind,
  type PendingRoleBind,
} from './pending-role-binds'

const plan = (documentId: string, scopeInstanceId = 'bw2'): PendingRoleBind => ({
  documentId,
  filename: `${documentId}.pdf`,
  role: 'bestandsplan',
  scopeInstanceId,
})

describe('pending role binds', () => {
  it('without a stored profile, only the default building is saved', () => {
    expect([...persistedBauwerkIds(null, null)]).toEqual(['bw1'])
  })

  it('a many-holder slot keeps every document, once each', () => {
    const pending = withPendingBind(withPendingBind([plan('a')], plan('b')), plan('a'))

    expect(pending.map((bind) => bind.documentId)).toEqual(['b', 'a'])
  })

  it('a single-holder slot keeps only the newest choice', () => {
    const first: PendingRoleBind = { ...plan('a'), role: 'lageplan' }
    const second: PendingRoleBind = { ...plan('b'), role: 'lageplan' }

    expect(withPendingBind([first], second)).toEqual([second])
  })

  it('removing a building drops its held bindings and no other', () => {
    const pending = [plan('a', 'bw2'), plan('b', 'bw3')]

    expect(withoutBauwerk(pending, 'bw2')).toEqual([plan('b', 'bw3')])
  })

  it('taking one back leaves the rest', () => {
    expect(withoutPendingBind([plan('a'), plan('b')], plan('a'))).toEqual([plan('b')])
  })

  it('reads back only well-formed entries from a stored draft', () => {
    expect(pendingBindsFromDraft('nope')).toEqual([])
    expect(pendingBindsFromDraft([plan('a'), { documentId: 1 }, null])).toEqual([plan('a')])
  })

  it('sends each binding in order and returns the refused ones', async () => {
    const post = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockRejectedValueOnce(new Error('offline'))

    const refused = await sendPendingBinds('proj-1', [plan('a'), plan('b'), plan('c')], post)

    expect(refused.map((bind) => bind.documentId)).toEqual(['b', 'c'])
    expect(post).toHaveBeenCalledTimes(3)
    const [url, init] = post.mock.calls[0]
    expect(url).toBe('/api/projects/proj-1/document-roles')
    expect(JSON.parse(String(init?.body))).toEqual({
      documentId: 'a',
      role: 'bestandsplan',
      scopeInstanceId: 'bw2',
    })
  })

  it('settles only once every tracked upload has, including one started while waiting', async () => {
    const tracker = createUploadTracker()
    const order: string[] = []
    let finishFirst!: () => void
    let finishLate!: () => void
    tracker.track(new Promise<void>((resolve) => (finishFirst = resolve)).then(() => order.push('first')))

    const settled = tracker.settled().then(() => order.push('settled'))
    tracker.track(new Promise<void>((resolve) => (finishLate = resolve)).then(() => order.push('late')))
    finishFirst()
    await Promise.resolve()
    finishLate()
    await settled

    expect(order).toEqual(['first', 'late', 'settled'])
  })

  it('settles even when a tracked upload fails', async () => {
    const tracker = createUploadTracker()
    tracker.track(Promise.reject(new Error('offline')))

    await expect(tracker.settled()).resolves.toBeUndefined()
  })
})
