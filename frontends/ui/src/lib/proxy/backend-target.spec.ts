/**
 * @vitest-environment node
 */
/**
 * Which aiq-agent address a chat socket dials (`server.js`, ADR-0028 / ADR-0080).
 *
 * With `GRID_CHAT_AFFINITY` on the route is the conversation-id hash it has
 * always been, byte for byte; with it off every socket goes to the Service.
 */
import { describe, expect, it } from 'vitest'
import { affinityEnabled, createBackendTargetPicker, hashToIndex } from './backend-target.js'

const SERVICE = 'ws://aiq-agent:8000'
const POD = 'ws://aiq-agent-{i}.aiq-agent-headless:8000'

const picker = (over: Partial<Parameters<typeof createBackendTargetPicker>[0]> = {}) =>
  createBackendTargetPicker({ replicas: 3, podTemplate: POD, affinity: true, serviceUrl: SERVICE, ...over })

describe('GRID_CHAT_AFFINITY', () => {
  it.each([undefined, '', '1', 'true', 'on', 'yes'])('reads %j as on, so an unset variable keeps today\'s routing', (v) => {
    // An empty string is not an off value: only an explicit one switches affinity off.
    expect(affinityEnabled(v)).toBe(true)
  })

  it.each(['0', 'false', 'FALSE', ' off ', 'no'])('reads %j as off', (v) => {
    expect(affinityEnabled(v)).toBe(false)
  })
})

describe('with affinity on', () => {
  it('pins a conversation to the replica its id hashes to, every time', () => {
    const pick = picker()
    const first = pick('conv-1')
    expect(first).toBe(POD.replace('{i}', String(hashToIndex('conv-1', 3))))
    expect(pick('conv-1')).toBe(first)
  })

  it('keeps the FNV-1a mapping fixed, so a deploy does not move live conversations', () => {
    // Pinned from the function as it stood in server.js before it moved here:
    // changing the hash remaps every open conversation at once.
    expect([hashToIndex('conv-1', 3), hashToIndex('conversation-42', 5), hashToIndex('abc', 1000)]).toEqual([1, 1, 331])
    expect(hashToIndex('', 7)).toBe(0x811c9dc5 % 7)
  })

  it('spreads conversations over every replica', () => {
    const pick = picker()
    const seen = new Set(Array.from({ length: 60 }, (_, i) => pick(`c-${i}`)))
    expect(seen.size).toBe(3)
  })

  it.each([
    ['one replica', { replicas: 1 }],
    ['no pod template', { podTemplate: '' }],
  ])('uses the Service with %s', (_label, over) => {
    expect(picker(over)('conv-1')).toBe(SERVICE)
  })

  it('uses the Service when the socket names no conversation', () => {
    expect(picker()(undefined)).toBe(SERVICE)
    expect(picker()('')).toBe(SERVICE)
  })
})

describe('with affinity off', () => {
  it('sends every conversation to the Service, whatever the replica count', () => {
    const pick = picker({ affinity: false, replicas: 3 })
    expect(new Set(['a', 'b', 'c', 'd'].map(pick))).toEqual(new Set([SERVICE]))
  })
})
