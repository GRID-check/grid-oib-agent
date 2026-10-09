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
  })

  it('refuses a cut that would keep no text and no card, and leaves the row whole', () => {
    // Otherwise the asker could blank any answer of theirs of the last minutes.
    expect(() => cutStoppedRow(row(), 'Ganz anders', NOW)).toThrow(ConflictError)
    expect(() => cutStoppedRow(row(), '', NOW)).toThrow(ConflictError)
  })

  it('drops the citations and cards the kept text does not reach', () => {
    const cut = cutStoppedRow(row(), 'Die Höhe', NOW)
    expect(cut?.content).toBe('Die Höhe')
    expect(cut?.metadata).not.toHaveProperty('cards')
    expect(cut?.metadata).toHaveProperty('citations', CITATIONS)
  })

  it('leaves a row a cut already made alone, from any writer, so a retry changes nothing', () => {
    const shown = 'Die Höhe beträgt 3 m [1].\n\n[[card:1]]\n\nWei'
    const once = cutStoppedRow(row(), shown, NOW)
    if (!once) throw new Error('the first cut wrote nothing')
    expect(cutStoppedRow(row({ ...once }), shown, NOW)).toBeNull()
    // The agent tier's cut of the streamed text drops a pending `[N]` the
    // screen still showed: a second cut must not part the two at it.
    const agentCut = row({ content: 'Die Höhe beträgt 3 m.', metadata: { stopped: true } })
    expect(cutStoppedRow(agentCut, 'Die Höhe beträgt 3 m [1].', NOW)).toBeNull()
    const browserCut = row({ content: 'Die Höhe', metadata: { provenance: { stopped: true } } })
    expect(cutStoppedRow(browserCut, 'Die Höhe', NOW)).toBeNull()
  })

  it('still cuts a whole answer the provenance mirror marked stopped before the cut ran', () => {
    // The asker's provenance PATCH (or any collaborator's) can mark the
    // server's whole row stopped first. The mark is not the cut.
    const marked = row({ metadata: { ...(row().metadata as Record<string, unknown>), provenance: { answerConfidence: 'high', stopped: true } } })
    expect(cutStoppedRow(marked, 'Die Höhe beträgt 3 m [1].', NOW)?.content).toBe('Die Höhe beträgt 3 m [1].')
    expect(cutStoppedRow(row({ metadata: { stopped: true } }), 'Die', NOW)?.content).toBe('Die')
  })

  it('refuses a row that is not a chat answer (a run, a queue notice), and an answer past the window', () => {
    expect(() => cutStoppedRow(row({ role: 'user' }), 'Die', NOW)).toThrow(ConflictError)
    expect(() => cutStoppedRow(row({ runId: 'run_1' }), 'Die', NOW)).toThrow(ConflictError)
    expect(() => cutStoppedRow(row({ metadata: { run: { run_id: 'r' } } }), 'Die', NOW)).toThrow(ConflictError)
    expect(() => cutStoppedRow(row({ metadata: { job_admission_rejected: true } }), 'Die', NOW)).toThrow(
      ConflictError
    )
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
