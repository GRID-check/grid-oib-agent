/**
 * @vitest-environment node
 */
/**
 * The BFF's cut of a stored answer to what its asker had on screen. It may
 * only ever shorten the row it holds; the rule itself is held to the agent
 * tier's by `stopped-answer.spec.ts`.
 */
import { describe, expect, it } from 'vitest'
import type { Message } from '@/lib/db/schema'
import { ConflictError } from '@/lib/api/errors'
import { STOP_CUT_WINDOW_MS, answerMessageId, cutStoppedRow } from './stopped-cut'

const NOW = Date.parse('2026-10-09T10:00:00.000Z')
const TEXT = 'Die Höhe beträgt 3 m [1].\n\n[[card:1]]\n\nWeiter [2]. Und [[card:2]] mehr.'
const CITATIONS = { v: 1, sources: [{ number: 1 }, { number: 2 }] }

const row = (overrides: Partial<Message> = {}): Message => ({
  id: 'a',
  conversationId: 'conv_1',
  organizationId: 'org_1',
  role: 'assistant',
  authorUserId: null,
  content: TEXT,
  runId: null,
  metadata: {
    messageType: 'agent_response',
    cards: [{ type: 'summary', title: 'eins' }, { type: 'summary', title: 'zwei' }],
    citations: CITATIONS,
    answerMeta: { kind: 'ruling' },
    provenance: { answerConfidence: 'high' },
  },
  createdAt: new Date(NOW - 2_000),
  ...overrides,
})

describe('cutStoppedRow', () => {
  it('cuts the stored text where the text on screen parts from it, and marks the row stopped', () => {
    const cut = cutStoppedRow(row(), 'Die Höhe beträgt 3 m [1].\n\n[[card:1]]\n\nWei', NOW)

    expect(cut?.content).toBe('Die Höhe beträgt 3 m [1].\n\n[[card:1]]\n\nWei')
    expect(cut?.metadata).toEqual({
      messageType: 'agent_response',
      cards: [{ type: 'summary', title: 'eins' }],
      citations: CITATIONS,
      answerMeta: { kind: 'ruling' },
      provenance: { answerConfidence: 'high', stopped: true },
    })
  })

  it('never stores a byte the browser sent: text past the stored one is ignored', () => {
    expect(cutStoppedRow(row(), `${TEXT} und noch erfunden`, NOW)?.content).toBe(TEXT)
    expect(cutStoppedRow(row(), 'Ganz anders', NOW)?.content).toBe('')
  })

  it('drops the citations and cards when nothing is kept', () => {
    const cut = cutStoppedRow(row(), '', NOW)
    expect(cut?.content).toBe('')
    expect(cut?.metadata).not.toHaveProperty('citations')
    expect(cut?.metadata).not.toHaveProperty('cards')
  })

  it('leaves a row already stored as stopped alone, from either writer', () => {
    expect(cutStoppedRow(row({ metadata: { provenance: { stopped: true } } }), 'Die', NOW)).toBeNull()
    expect(cutStoppedRow(row({ metadata: { stopped: true } }), 'Die', NOW)).toBeNull()
  })

  it('refuses a row that is not a chat answer, and an answer past the window', () => {
    expect(() => cutStoppedRow(row({ role: 'user' }), 'Die', NOW)).toThrow(ConflictError)
    expect(() => cutStoppedRow(row({ runId: 'run_1' }), 'Die', NOW)).toThrow(ConflictError)
    const old = row({ createdAt: new Date(NOW - STOP_CUT_WINDOW_MS - 1) })
    expect(() => cutStoppedRow(old, 'Die', NOW)).toThrow(ConflictError)
  })
})

describe('answerMessageId', () => {
  it('is the id the agent tier derives (`answer_message_id`, uuid5 in the URL namespace)', () => {
    // python -c "import uuid; print(uuid.uuid5(uuid.NAMESPACE_URL,
    //   'grid:assistant:conv_1:4f1a2b3c-1111-4222-8333-444455556666'))"
    expect(answerMessageId('conv_1', '4f1a2b3c-1111-4222-8333-444455556666')).toBe('50c65a0f-a2db-536f-8849-e4263e465bc6')
  })
})
