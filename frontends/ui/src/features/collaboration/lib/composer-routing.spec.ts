/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { AGENT_MENTION_ID } from '@/lib/mentions/types'
import type { DraftMention } from './mention-text'
import {
  resolveAddressee,
  sendMessageOptions,
  type AddresseeInput,
  type AddresseeMode,
} from './composer-routing'

// `display` carries no leading '@' — mention-text adds it when matching.
const anna: DraftMention = { targetId: 'u-anna', display: 'Anna' }
const piloti: DraftMention = { targetId: AGENT_MENTION_ID, display: 'Piloti' }

const BASE: AddresseeInput = {
  text: '',
  mentions: [],
  awaitingHuman: false,
  canCollaborate: true,
}

const resolve = (patch: Partial<AddresseeInput>) => resolveAddressee({ ...BASE, ...patch })

describe('resolveAddressee', () => {
  test('a plain message in a normal thread goes to the agent, fast', () => {
    const { mode, routing } = resolve({ text: 'Frage' })
    expect(mode).toBe('agent')
    expect(routing).toEqual({ kind: 'fast' })
  })

  test('a plain message while a person is awaited addresses the thread', () => {
    const { mode, routing } = resolve({ text: 'Anmerkung', awaitingHuman: true })
    expect(mode).toBe('thread')
    expect(routing).toEqual({ kind: 'awaiting' })
  })

  test('tagging a person addresses people and sends structured mentions', () => {
    const { mode, humans, routing } = resolve({ text: '@Anna hallo', mentions: [anna] })
    expect(mode).toBe('people')
    expect(humans).toEqual([anna])
    expect(routing).toEqual({ kind: 'mentions', mentions: [anna] })
  })

  test('tagging @Piloti while awaiting takes the wait back (MN-9.3)', () => {
    const { mode, agentTagged } = resolve({
      text: '@Piloti bitte',
      mentions: [piloti],
      awaitingHuman: true,
    })
    expect(mode).toBe('agent')
    expect(agentTagged).toBe(true)
  })

  test('a person plus @Piloti addresses both (MN-1)', () => {
    const { mode, humans, agentTagged } = resolve({
      text: '@Anna @Piloti hallo',
      mentions: [anna, piloti],
    })
    expect(mode).toBe('people')
    expect(humans).toEqual([anna])
    expect(agentTagged).toBe(true)
  })

  test('deleting the token drops the mention (MN-3)', () => {
    // The mention was picked, then the text edited to remove it. Reconciliation
    // is what makes the send match what the user can see.
    const { mentions, routing } = resolve({ text: 'hallo', mentions: [anna] })
    expect(mentions).toEqual([])
    expect(routing).toEqual({ kind: 'fast' })
  })

  describe('with collaboration off (NF-8)', () => {
    test('routing is exactly the pre-feature call', () => {
      expect(resolve({ text: 'Frage', canCollaborate: false }).routing).toEqual({
        kind: 'fast',
      })
    })

    test('…even while a person is awaited', () => {
      expect(
        resolve({ text: 'Frage', canCollaborate: false, awaitingHuman: true }).routing,
      ).toEqual({ kind: 'fast' })
    })

    test('…and even when mention state was populated behind the flag', () => {
      // The divergence this module closes. `mentions` can be seeded by a prefill
      // without consulting canCollaborate; the send used to take the ruled path
      // on that state while the line — gated on the flag — said nothing at all.
      const { routing, mentions } = resolve({
        text: '@Anna hallo',
        mentions: [anna],
        canCollaborate: false,
      })
      expect(routing).toEqual({ kind: 'fast' })
      expect(mentions).toEqual([])
    })
  })

  test('reconciliation is unaffected by surrounding whitespace', () => {
    // The line reconciled the raw text and the send the trimmed text. Neutral
    // today because whitespace is boundary-equivalent to string bounds — pinned
    // so a change to boundary handling fails here, not silently in a send.
    const padded = resolve({ text: '  @Anna hallo  ', mentions: [anna] })
    const tight = resolve({ text: '@Anna hallo', mentions: [anna] })
    expect(padded.routing).toEqual(tight.routing)
    expect(padded.mode).toBe(tight.mode)
  })

  test('the line and the send can never disagree', () => {
    // The invariant the twenty-one component tests were standing in for.
    const allowed: Record<AddresseeMode, SendKind[]> = {
      people: ['mentions'],
      thread: ['awaiting'],
      agent: ['fast', 'mentions'], // @Piloti alone: says "agent", sends structured
    }
    for (const text of ['', 'hallo', '@Anna hallo', '@Piloti hallo', '@Anna @Piloti x'])
      for (const mentions of [[], [anna], [piloti], [anna, piloti]])
        for (const awaitingHuman of [false, true])
          for (const canCollaborate of [false, true]) {
            const { mode, routing } = resolve({
              text,
              mentions,
              awaitingHuman,
              canCollaborate,
            })
            expect(allowed[mode]).toContain(routing.kind)
          }
  })
})

type SendKind = 'fast' | 'mentions' | 'awaiting'

describe('sendMessageOptions', () => {
  test('the fast path has NO options, so the call stays one argument', () => {
    // Load-bearing: three component tests assert toHaveBeenCalledWith(text), and
    // an explicit undefined would route plain messages through the ruling path.
    expect(sendMessageOptions({ kind: 'fast' })).toBeUndefined()
  })

  test('mentions travel structured, not as text', () => {
    expect(sendMessageOptions({ kind: 'mentions', mentions: [anna] })).toEqual({
      mentions: [anna],
    })
  })

  test('a remark into a waiting thread asks the server to rule', () => {
    expect(sendMessageOptions({ kind: 'awaiting' })).toEqual({ awaitingHuman: true })
  })
})
