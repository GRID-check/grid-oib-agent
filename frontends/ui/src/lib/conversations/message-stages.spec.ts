/**
 * @vitest-environment node
 */
/**
 * The bound on `metadata.stages`.
 *
 * A stage's output is jsonb on a hot table, written by a browser, from a payload
 * a model produced (`docs/architecture/post-answer-stages.md` §7.8). Three
 * untrusted hops, so the column gets the same discipline `sanitizeProvenance`
 * applies: a closed key set, a truncated list, capped strings — and null rather
 * than an empty object when nothing survives, so a caller can skip the write
 * instead of stamping emptiness onto a message.
 *
 * The same function runs on the way OUT of the database as well as in
 * (`server-message-mapper`), so a row written under an older bound is still
 * read under this one.
 */
import { describe, expect, it } from 'vitest'
import { MAX_FOLLOW_UPS, sanitizeFollowUpsStage, sanitizeStages } from './message-stages'

const questions = (n: number) =>
  Array.from({ length: n }, (_, index) => ({ question: `Frage ${index + 1}?` }))

describe('sanitizeFollowUpsStage', () => {
  it('keeps a well-formed question and its hint', () => {
    expect(
      sanitizeFollowUpsStage({
        items: [{ question: 'Wie wird das Fluchtniveau gemessen?', hint: 'Messpunkt und Bezugsebene' }],
      }),
    ).toEqual({
      items: [{ question: 'Wie wird das Fluchtniveau gemessen?', hint: 'Messpunkt und Bezugsebene' }],
    })
  })

  it('drops a hint that is not there rather than storing an empty one', () => {
    expect(sanitizeFollowUpsStage({ items: [{ question: 'Und bei Hanglage?', hint: '  ' }] })).toEqual({
      items: [{ question: 'Und bei Hanglage?' }],
    })
  })

  it('truncates past the fourth question', () => {
    // The set is meant to be taken in at a glance; a fifth is a list, and a list
    // is not an offer.
    const stage = sanitizeFollowUpsStage({ items: questions(9) })
    expect(stage?.items).toHaveLength(MAX_FOLLOW_UPS)
    expect(stage?.items.at(-1)?.question).toBe('Frage 4?')
  })

  it('caps a question that arrived as a paragraph', () => {
    const stage = sanitizeFollowUpsStage({ items: [{ question: 'x'.repeat(5000) }] })
    expect(stage?.items[0].question).toHaveLength(300)
  })

  it('skips an item with no question and keeps its siblings', () => {
    const stage = sanitizeFollowUpsStage({
      items: [{ hint: 'nur ein Hinweis' }, { question: '   ' }, { question: 'Und die Gebäudeklasse?' }],
    })
    expect(stage?.items).toEqual([{ question: 'Und die Gebäudeklasse?' }])
  })

  it('is null when nothing usable survives', () => {
    // Not `{ items: [] }`: an empty offer is an unkept promise, and it would make
    // "the stage produced nothing" indistinguishable from "the stage produced
    // something unreadable".
    expect(sanitizeFollowUpsStage({ items: [{ hint: 'nur ein Hinweis' }] })).toBeNull()
    expect(sanitizeFollowUpsStage({ items: 'Wie wird gemessen?' })).toBeNull()
    expect(sanitizeFollowUpsStage(null)).toBeNull()
    expect(sanitizeFollowUpsStage([{ question: 'Als Array?' }])).toBeNull()
  })
})

describe('sanitizeStages', () => {
  it('keeps the stages this build knows', () => {
    expect(sanitizeStages({ followUps: { items: [{ question: 'Und bei Hanglage?' }] } })).toEqual({
      followUps: { items: [{ question: 'Und bei Hanglage?' }] },
    })
  })

  it('drops a stage key this build has never heard of', () => {
    // An unbounded map of stage ids is how "one more key on a column that
    // already exists" becomes a column of arbitrary client JSON.
    expect(
      sanitizeStages({
        followUps: { items: [{ question: 'Und bei Hanglage?' }] },
        somethingElse: { anything: 'x'.repeat(100000) },
      }),
    ).toEqual({ followUps: { items: [{ question: 'Und bei Hanglage?' }] } })
  })

  it('is null when nothing survives, so the caller can skip the write', () => {
    expect(sanitizeStages({ somethingElse: { items: [] } })).toBeNull()
    expect(sanitizeStages('followUps')).toBeNull()
    expect(sanitizeStages(undefined)).toBeNull()
  })
})
