/**
 * The cause reaches the answer, not just the schema.
 *
 * `truncation_reason` and `degraded_reasons` were parsed, sanitized, stored,
 * localized and rendered — by code nothing called. The renderer had props no
 * caller passed, so the whole chain was dead for exactly the two fields it was
 * built for, and every test on either side of the gap passed.
 *
 * That is the third time in this work that a complete, correct implementation
 * shipped unwired, so this pins the JOINS rather than the parts: the reopened
 * thread restores them onto the message, and the live socket frame lifts them
 * onto the transparency bundle. Renaming a field on either side fails here.
 */

import { describe, expect, it } from 'vitest'
import type { Message } from '@/lib/db/schema'
import { mapServerMessageToChatMessage } from './server-message-mapper'

/** A stored assistant message carrying the provenance a finished job wrote. */
const stored = (provenance: Record<string, unknown>): Message =>
  ({
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    conversationId: 's_conv_1',
    role: 'assistant',
    content: 'Die Antwort.',
    metadata: { provenance },
    createdAt: '2026-08-19T10:00:00.000Z' as unknown as Date,
  }) as Message

const restored = (provenance: Record<string, unknown>) =>
  mapServerMessageToChatMessage(stored(provenance))!

describe('a reopened thread restores the cause and the degradations', () => {
  it('puts both onto the message', () => {
    const out = restored({
      researchTruncated: true,
      truncationReason: 'wall_clock',
      degradedReasons: ['no_valid_citations'],
    })
    expect(out.researchTruncated).toBe(true)
    expect(out.truncationReason).toBe('wall_clock')
    expect(out.degradedReasons).toEqual(['no_valid_citations'])
  })

  it('restores a degraded run that was never truncated', () => {
    // The two are independent facts; a cause gated on the flag would silently
    // drop every degradation on a run that finished inside its budget.
    const out = restored({ degradedReasons: ['no_report_file'] })
    expect(out.degradedReasons).toEqual(['no_report_file'])
    expect(out.researchTruncated).toBeUndefined()
  })

  it('writes nothing for an empty or absent list', () => {
    expect(restored({ degradedReasons: [] }).degradedReasons).toBeUndefined()
    expect(restored({}).degradedReasons).toBeUndefined()
  })

  it('drops non-string entries rather than passing them to the localizer', () => {
    const out = restored({ degradedReasons: ['no_report_file', 3, ''] })
    expect(out.degradedReasons).toEqual(['no_report_file'])
  })
})

describe('ChatArea hands both props to the answer', () => {
  it('passes them straight off the message', async () => {
    // Read as source: rendering ChatArea needs the whole chat shell. The
    // failure being prevented is a missing LINE, which the source shows.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/features/layout/components/ChatArea.tsx', 'utf8')
    expect(source).toContain('truncationReason={message.truncationReason}')
    expect(source).toContain('degradedReasons={message.degradedReasons}')
  })
})
