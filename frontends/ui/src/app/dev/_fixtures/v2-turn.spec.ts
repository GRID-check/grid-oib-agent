/**
 * @vitest-environment node
 */
/**
 * The dev pages' v2 turn is a real one: every frame is a contract event, the
 * turn folds to its recorded answer, and no frame but the two that carry the
 * whole answer is over 4 KB (`chat-wire-v2.md`, definition of done 4).
 *
 * The design names only the terminal as the exception. On these recorded
 * answers the settle is one too: `STATE_SNAPSHOT` carries the verified text and
 * every cited source with its passage, 10 to 13 KB here, mostly sources.
 */
import { describe, expect, it } from 'vitest'
import { parseWireEvent, type WireEvent } from '@/adapters/api/wire-v2'
import { foldTurnEvents } from '@/features/chat/lib/turn-fold'
import { STREAM_FRAMES } from './stream-frames'
import { answerBodies, asSettled, v2Turn } from './v2-turn'

const IDS = { conversationId: 'c', turnId: 't', messageId: 'm' }

describe.each(['oib2', 'varianten'] as const)('the %s turn as v2 events', (name) => {
  const frames = v2Turn(STREAM_FRAMES[name], IDS)
  const events = frames.map(({ frame }) => parseWireEvent(frame))

  it('parses frame for frame, seq 1..n, in time order', () => {
    expect(events.every(Boolean)).toBe(true)
    expect(frames.map(({ frame }) => frame.seq)).toEqual(frames.map((_, index) => index + 1))
    expect(frames.map(({ at }) => at)).toEqual([...frames.map(({ at }) => at)].sort((a, b) => a - b))
  })

  it('folds to the recorded answer', () => {
    const view = foldTurnEvents(undefined, events as WireEvent[])
    expect(view?.phase).toBe('finished')
    expect(view?.text).toBe(STREAM_FRAMES[name].frames.at(-1)?.content)
    expect(view?.cards.length).toBe(STREAM_FRAMES[name].frames.at(-1)?.cards?.length)
  })

  it('keeps every frame but the terminal and the settle under 4 KB', () => {
    const encoder = new TextEncoder()
    const oversized = frames
      .filter(({ frame }) => frame.type !== 'RUN_FINISHED' && frame.type !== 'STATE_SNAPSHOT')
      .filter(({ frame }) => encoder.encode(JSON.stringify(frame)).length > 4096)
    expect(oversized.map(({ frame }) => `${frame.type}/${String(frame.name ?? '')}`)).toEqual([])
  })
})

describe.each(['oib2', 'varianten'] as const)('the %s answer as the product ends it today', (name) => {
  const recorded = answerBodies(STREAM_FRAMES[name], 'm')
  const settled = asSettled(recorded)
  const snapshot = recorded.find(({ body }) => body.type === 'STATE_SNAPSHOT')!.body.snapshot as { text: string; sources: unknown[] }
  const result = settled.find(({ body }) => body.type === 'RUN_FINISHED')!.body.result as { text: string; sources: unknown[] }

  it('ends on the settled text and sources, not the recorded terminal', () => {
    expect(result.text).toBe(snapshot.text)
    expect(result.sources).toEqual(snapshot.sources)
  })

  it('changes nothing but the terminal', () => {
    expect(settled.filter(({ body }) => body.type !== 'RUN_FINISHED')).toEqual(
      recorded.filter(({ body }) => body.type !== 'RUN_FINISHED')
    )
  })
})
