import { describe, it, expect } from 'vitest'
import type { Message } from '@/lib/db/schema'
import { mapServerMessageToChatMessage, mapServerMessagesToChatMessages } from './server-message-mapper'

const serverMessage = (overrides: Partial<Message> = {}): Message =>
  ({
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    conversationId: 's_conv_1',
    role: 'user',
    content: 'Hello',
    metadata: {},
    // Over JSON, timestamps arrive as ISO strings despite the Date type.
    createdAt: '2026-07-01T10:00:00.000Z' as unknown as Date,
    ...overrides,
  }) as Message

describe('mapServerMessageToChatMessage', () => {
  it('maps core fields and parses the ISO timestamp', () => {
    const mapped = mapServerMessageToChatMessage(serverMessage())

    expect(mapped).not.toBeNull()
    expect(mapped!.id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(mapped!.role).toBe('user')
    expect(mapped!.content).toBe('Hello')
    expect(mapped!.timestamp).toBeInstanceOf(Date)
    expect(mapped!.timestamp.toISOString()).toBe('2026-07-01T10:00:00.000Z')
  })

  it('uses the persisted messageType from metadata', () => {
    const mapped = mapServerMessageToChatMessage(
      serverMessage({ role: 'assistant', metadata: { messageType: 'agent_response' } })
    )

    expect(mapped!.messageType).toBe('agent_response')
  })

  it('infers messageType from role when metadata has none (legacy rows)', () => {
    expect(mapServerMessageToChatMessage(serverMessage({ role: 'user' }))!.messageType).toBe('user')
    expect(
      mapServerMessageToChatMessage(serverMessage({ role: 'assistant' }))!.messageType
    ).toBe('agent_response')
  })

  it('ignores an unknown messageType value and falls back to the role', () => {
    const mapped = mapServerMessageToChatMessage(
      serverMessage({ role: 'assistant', metadata: { messageType: 'not-a-real-type' } })
    )

    expect(mapped!.messageType).toBe('agent_response')
  })

  it('drops system and tool rows the chat window never renders', () => {
    expect(mapServerMessageToChatMessage(serverMessage({ role: 'system' }))).toBeNull()
    expect(mapServerMessageToChatMessage(serverMessage({ role: 'tool' }))).toBeNull()
  })

  it('restores persisted metadata payloads (errorData, cards, data sources, files)', () => {
    const mapped = mapServerMessageToChatMessage(
      serverMessage({
        role: 'assistant',
        metadata: {
          messageType: 'error',
          errorData: { errorCode: 'system.unknown', errorMessage: 'boom' },
          cards: [{ kind: 'test' }],
          enabledDataSources: ['web_search'],
          messageFiles: [{ id: 'f1', fileName: 'a.pdf' }],
        },
      })
    )

    expect(mapped!.messageType).toBe('error')
    expect(mapped!.errorData).toEqual({ errorCode: 'system.unknown', errorMessage: 'boom' })
    expect(mapped!.cards).toEqual([{ kind: 'test' }])
    expect(mapped!.enabledDataSources).toEqual(['web_search'])
    expect(mapped!.messageFiles).toEqual([{ id: 'f1', fileName: 'a.pdf' }])
  })

  it('restores interactive-card decisions so a settled card cannot be re-answered', () => {
    // Regression: when a history rehydrates from the server (localStorage wiped,
    // other device) an already-applied project_profile_patch used to come back
    // pending, re-offering an Accept that writes the same patch again.
    const mapped = mapServerMessageToChatMessage(
      serverMessage({
        role: 'assistant',
        metadata: {
          cards: [{ type: 'project_profile_patch' }],
          cardInteractions: {
            'project_profile_patch-0': { decision: 'accepted', decidedAt: '2026-07-28T09:00:00.000Z' },
          },
        },
      })
    )

    expect(mapped!.cardInteractions).toEqual({
      'project_profile_patch-0': { decision: 'accepted', decidedAt: '2026-07-28T09:00:00.000Z' },
    })
  })

  it('drops card decisions that are not in the closed union', () => {
    const mapped = mapServerMessageToChatMessage(
      serverMessage({
        role: 'assistant',
        metadata: { cardInteractions: { 'memory_proposal-0': { decision: 'whatever' } } },
      })
    )

    expect(mapped!.cardInteractions).toBeUndefined()
  })

  it('carries the author through, so a colleague’s message stays attributable (spec CC-3)', () => {
    const mapped = mapServerMessageToChatMessage(
      serverMessage({ role: 'user', authorUserId: 'user_anna' })
    )

    // A colleague's contribution arrives as role `user` — the same role as our own
    // messages — so authorship is the ONLY thing that tells them apart.
    expect(mapped).not.toBeNull()
    expect(mapped!.messageType).toBe('user')
    expect(mapped!.authorUserId).toBe('user_anna')
  })

  it('leaves the author absent on an unattributed row rather than inventing one', () => {
    expect(mapServerMessageToChatMessage(serverMessage({ authorUserId: null }))!.authorUserId).toBeUndefined()
    // NULL on an assistant row is correct: the agent wrote it.
    expect(
      mapServerMessageToChatMessage(serverMessage({ role: 'assistant', authorUserId: null }))!.authorUserId
    ).toBeUndefined()
  })

  it('restores structured mentions and the server’s addressee ruling', () => {
    const mapped = mapServerMessageToChatMessage(
      serverMessage({
        metadata: {
          messageType: 'user',
          mentions: [{ targetId: 'user_anna', display: 'Anna Berger' }],
          addressees: { agent: false, users: ['user_anna'] },
        },
      })
    )

    expect(mapped!.mentions).toEqual([{ targetId: 'user_anna', display: 'Anna Berger' }])
    expect(mapped!.addressees).toEqual({ agent: false, users: ['user_anna'] })
  })

  it('drops malformed mentions and a malformed addressee set', () => {
    const mapped = mapServerMessageToChatMessage(
      serverMessage({
        metadata: {
          mentions: [{ display: 'no target' }, 'nonsense', null],
          addressees: { agent: 'yes', users: 'anna' },
        },
      })
    )

    expect(mapped!.mentions).toBeUndefined()
    expect(mapped!.addressees).toBeUndefined()
  })

  it('defaults a mention display to its target id rather than rendering "undefined"', () => {
    const mapped = mapServerMessageToChatMessage(
      serverMessage({ metadata: { mentions: [{ targetId: 'user_anna' }] } })
    )

    expect(mapped!.mentions).toEqual([{ targetId: 'user_anna', display: 'user_anna' }])
  })

  it('tolerates a null metadata column', () => {
    const mapped = mapServerMessageToChatMessage(serverMessage({ metadata: null }))

    expect(mapped!.messageType).toBe('user')
    expect(mapped!.errorData).toBeUndefined()
  })
})

describe('mapServerMessagesToChatMessages', () => {
  it('maps a history in order and filters unrenderable rows', () => {
    const mapped = mapServerMessagesToChatMessages([
      serverMessage({ id: 'm1', role: 'user', content: 'q' }),
      serverMessage({ id: 'm2', role: 'system', content: 'internal' }),
      serverMessage({ id: 'm3', role: 'assistant', content: 'a' }),
    ])

    expect(mapped.map((m) => m.id)).toEqual(['m1', 'm3'])
  })

  it('keeps every human author in a multi-author history', () => {
    // The regression this guards: the role filter above drops anything that is not
    // user/assistant, and a colleague's message arrives as `user`. If that ever
    // narrowed to "the session owner", a shared thread would render half of itself.
    const mapped = mapServerMessagesToChatMessages([
      serverMessage({ id: 'm1', role: 'user', authorUserId: 'user_me' }),
      serverMessage({ id: 'm2', role: 'user', authorUserId: 'user_anna' }),
      serverMessage({ id: 'm3', role: 'assistant', authorUserId: null }),
      serverMessage({ id: 'm4', role: 'user', authorUserId: 'user_tobias' }),
    ])

    expect(mapped.map((m) => m.authorUserId)).toEqual([
      'user_me',
      'user_anna',
      undefined,
      'user_tobias',
    ])
  })
})

/**
 * The provenance round-trip (ADR-0037).
 *
 * This is what an OBSERVER's whole view of the reasoning rests on. A colleague
 * holds no agent socket by design (ADR-0033 §7), so they never receive the
 * intermediate frames — this row is the only place the Herleitung can come from.
 * The same path is what restores it for the asker on a second device.
 */
describe('mapServerMessageToChatMessage — the answer’s provenance', () => {
  const provenance = {
    thinkingSteps: [
      {
        id: 's1',
        userMessageId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        functionName: 'oib_lookup',
        displayName: 'OIB-Richtlinie durchsucht',
        category: 'tools',
        timestamp: '2026-07-01T10:00:05.000Z',
        isComplete: true,
        isTopLevel: true,
        traceLanes: [{ kind: 'oib', label: 'OIB 2.3' }],
      },
    ],
    answerConfidence: 'high',
    answerConfidenceReason: 'Zwei übereinstimmende Quellen.',
    routingDecision: 'shallow',
    routingReason: 'Direkte Normfrage.',
    citationsRemoved: { count: 1, reasons: ['ungrounded'] },
    deepResearchJobId: 'job_1',
    showViewReport: true,
  }

  it('restores the Herleitung, with its timestamps as Dates', () => {
    const mapped = mapServerMessageToChatMessage(serverMessage({ metadata: { provenance } }))

    expect(mapped!.thinkingSteps).toHaveLength(1)
    const step = mapped!.thinkingSteps![0]
    expect(step.displayName).toBe('OIB-Richtlinie durchsucht')
    // A Date, because that is what the step shape declares and what the renderer
    // sorts on — an ISO string here silently breaks ordering.
    expect(step.timestamp).toBeInstanceOf(Date)
    expect(step.timestamp.toISOString()).toBe('2026-07-01T10:00:05.000Z')
    // The sources fan-out is the part of a step a reader actually reads.
    expect(step.traceLanes).toEqual([{ kind: 'oib', label: 'OIB 2.3' }])
  })

  it('restores the confidence self-assessment and the routing transparency', () => {
    const mapped = mapServerMessageToChatMessage(
      serverMessage({ role: 'assistant', metadata: { provenance } }),
    )

    expect(mapped!.answerConfidence).toBe('high')
    expect(mapped!.answerConfidenceReason).toBe('Zwei übereinstimmende Quellen.')
    expect(mapped!.routingDecision).toBe('shallow')
    expect(mapped!.routingReason).toBe('Direkte Normfrage.')
    expect(mapped!.citationsRemoved).toEqual({ count: 1, reasons: ['ungrounded'] })
    expect(mapped!.deepResearchJobId).toBe('job_1')
    expect(mapped!.showViewReport).toBe(true)
  })

  it('ignores a provenance blob written by some other build', () => {
    // Narrowed, not cast: the server bounds this on write, but a row written
    // earlier is whatever it was, and a bad value must not reach a renderer.
    const mapped = mapServerMessageToChatMessage(
      serverMessage({
        metadata: {
          provenance: {
            answerConfidence: 'extremely-high',
            routingDecision: 'sideways',
            thinkingSteps: 'not-an-array',
            citationsRemoved: { count: 'lots' },
          },
        },
      }),
    )

    expect(mapped!.answerConfidence).toBeUndefined()
    expect(mapped!.routingDecision).toBeUndefined()
    expect(mapped!.thinkingSteps).toBeUndefined()
    expect(mapped!.citationsRemoved).toBeUndefined()
  })

  it('adds nothing when the row has no provenance — the pre-ADR-0037 case', () => {
    const mapped = mapServerMessageToChatMessage(serverMessage())

    expect(mapped!.thinkingSteps).toBeUndefined()
    expect(mapped!.answerConfidence).toBeUndefined()
  })

  it('a non-object provenance is ignored rather than throwing', () => {
    for (const value of [null, 'x', 42, []]) {
      const mapped = mapServerMessageToChatMessage(
        serverMessage({ metadata: { provenance: value } }),
      )
      expect(mapped!.thinkingSteps).toBeUndefined()
    }
  })
})
