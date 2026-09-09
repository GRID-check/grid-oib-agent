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
import {
  MAX_FOLLOW_UPS,
  MAX_MEMORY_ITEMS,
  sanitizeFollowUpsStage,
  sanitizeMemoryReflectionStage,
  sanitizeStages,
} from './message-stages'

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

const noted = (n: number) =>
  Array.from({ length: n }, (_, index) => ({
    id: `item-${index + 1}`,
    kind: 'derived_fact',
    content: `Notiz ${index + 1}`,
  }))

describe('sanitizeMemoryReflectionStage', () => {
  it('keeps a well-formed item whole', () => {
    // All three fields matter to the reader: the words are what the chip shows,
    // the kind is its icon and label, and the id is what tells two items apart.
    expect(
      sanitizeMemoryReflectionStage({
        items: [{ id: '9d2f6b41', kind: 'constraint', content: 'Das Projekt liegt in Wien.' }],
      }),
    ).toEqual({ items: [{ id: '9d2f6b41', kind: 'constraint', content: 'Das Projekt liegt in Wien.' }] })
  })

  it('drops an item whose kind is not one a project_memory row can carry', () => {
    // Not a display concern: the kind is a closed enum in the database, so a
    // value outside it describes a row that cannot exist — and letting it
    // through would put an arbitrary client string into jsonb on a hot table.
    expect(
      sanitizeMemoryReflectionStage({
        items: [
          { id: 'a', kind: 'sonstiges', content: 'Etwas' },
          { id: 'b', kind: 'preference', content: 'Der Kunde bevorzugt Flachdächer.' },
        ],
      }),
    ).toEqual({ items: [{ id: 'b', kind: 'preference', content: 'Der Kunde bevorzugt Flachdächer.' }] })
  })

  it('drops a malformed item INDIVIDUALLY and keeps its siblings', () => {
    // The opposite rule to `follow_ups`, and deliberately: a half-set of
    // suggestion chips is a worse offer than none, but these are things that
    // were WRITTEN to the reader's project. Losing four of them because a fifth
    // arrived broken would hide four real writes.
    const stage = sanitizeMemoryReflectionStage({
      items: [
        { kind: 'decision', content: 'ohne id' },
        { id: 'c', kind: 'decision', content: '   ' },
        'nicht einmal ein Objekt',
        { id: 'd', kind: 'decision', content: 'Flachdach beschlossen.' },
      ],
    })
    expect(stage?.items).toEqual([{ id: 'd', kind: 'decision', content: 'Flachdach beschlossen.' }])
  })

  it('caps the list and the content', () => {
    expect(sanitizeMemoryReflectionStage({ items: noted(20) })?.items).toHaveLength(MAX_MEMORY_ITEMS)
    const long = sanitizeMemoryReflectionStage({
      items: [{ id: 'a', kind: 'decision', content: 'x'.repeat(5000) }],
    })
    expect(long?.items[0].content).toHaveLength(500)
  })

  it('is null when nothing usable survives', () => {
    expect(sanitizeMemoryReflectionStage({ items: [] })).toBeNull()
    expect(sanitizeMemoryReflectionStage({ items: [{ id: 'a', kind: 'decision' }] })).toBeNull()
    expect(sanitizeMemoryReflectionStage(null)).toBeNull()
  })
})

describe('sanitizeStages', () => {
  it('keeps the stages this build knows', () => {
    expect(sanitizeStages({ followUps: { items: [{ question: 'Und bei Hanglage?' }] } })).toEqual({
      followUps: { items: [{ question: 'Und bei Hanglage?' }] },
    })
  })

  it('keeps two stages side by side, under their own keys', () => {
    // §7.7: two stages target the same turn and neither erases the other. One
    // key each is what makes that true of the stored row as well as of the
    // store, and it is why a stage's output is not written into `cards`.
    expect(
      sanitizeStages({
        followUps: { items: [{ question: 'Und bei Hanglage?' }] },
        memoryReflection: { items: [{ id: 'a', kind: 'decision', content: 'Flachdach beschlossen.' }] },
      }),
    ).toEqual({
      followUps: { items: [{ question: 'Und bei Hanglage?' }] },
      memoryReflection: { items: [{ id: 'a', kind: 'decision', content: 'Flachdach beschlossen.' }] },
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


/**
 * The proposals half of the payload (ADR-0055, C6).
 *
 * The bug this closes is not a rendering one: a proposals-only payload — the
 * ordinary shape of a reflection pass that found one firm-wide thing and wrote
 * nothing — was discarded WHOLE at this boundary, so the offer reached the
 * browser and died here.
 */
describe('sanitizeMemoryReflectionStage — proposals', () => {
  const card = (content = 'Fluchtwegpläne im Maßstab 1:100.') => ({
    type: 'memory_proposal',
    title: 'Neue Erkenntnis merken',
    content,
    kind: 'preference',
    confidence: 'medium',
  })

  it('keeps a proposals-only payload, which used to be thrown away entirely', () => {
    expect(sanitizeMemoryReflectionStage({ items: [], proposals: [card()] })).toEqual({
      items: [],
      proposals: [card()],
    })
  })

  it('keeps both lists, and keeps them SEPARATE', () => {
    // A proposal folded into `items` would claim a firm-wide row that does not
    // exist. The two keys are the contract's own guard against that.
    const out = sanitizeMemoryReflectionStage({
      items: [{ id: 'row-1', kind: 'constraint', content: 'Das Projekt liegt in Wien.' }],
      proposals: [card()],
    })
    expect(out?.items).toHaveLength(1)
    expect(out?.proposals).toHaveLength(1)
  })

  it('omits `proposals` rather than storing an empty list', () => {
    const out = sanitizeMemoryReflectionStage({
      items: [{ id: 'row-1', kind: 'constraint', content: 'Das Projekt liegt in Wien.' }],
      proposals: [],
    })
    expect(out).toEqual({ items: [{ id: 'row-1', kind: 'constraint', content: 'Das Projekt liegt in Wien.' }] })
    expect(out && 'proposals' in out).toBe(false)
  })

  it('is not a general card channel — anything but a memory_proposal is dropped', () => {
    // This key is jsonb on a hot table. A stage that could store any card type
    // would be an unbounded map of client JSON.
    expect(
      sanitizeMemoryReflectionStage({
        items: [],
        proposals: [{ type: 'callout', kind: 'achtung', title: 'x', text: 'y' }],
      }),
    ).toBeNull()
  })

  it('still returns null when neither list survives', () => {
    expect(sanitizeMemoryReflectionStage({ items: [], proposals: [] })).toBeNull()
    expect(sanitizeMemoryReflectionStage({ proposals: 'nope' })).toBeNull()
  })
})

describe('sanitizeMemoryReflectionStage — the note a correction retired', () => {
  const RETIRED = { id: 'old-1', content: 'OIB-RL 2.1 ist hier nicht anwendbar.' }
  const CORRECTION = {
    id: 'new-1',
    kind: 'derived_fact',
    content: 'OIB-RL 2.1 ist anwendbar, es handelt sich um eine Betriebsanlage.',
    supersedes: RETIRED,
  }

  it('keeps the retired note, which is the whole of what the transcript needs', () => {
    // The key set here is CLOSED — an undeclared key is dropped on write. This
    // is the declaration, and until it existed `MemorySupersededNotices` had
    // nothing to render: the correction showed only in the memory panel, which
    // is the inversion ADR-0055 exists to fix.
    expect(sanitizeMemoryReflectionStage({ items: [CORRECTION] })).toEqual({ items: [CORRECTION] })
  })

  it('leaves the key off an item that replaced nothing', () => {
    const stage = sanitizeMemoryReflectionStage({
      items: [{ id: 'a', kind: 'decision', content: 'Flachdach beschlossen.' }],
    })
    expect(stage?.items[0]).not.toHaveProperty('supersedes')
  })

  it('caps the retired words with the item\'s own limit', () => {
    const stage = sanitizeMemoryReflectionStage({
      items: [{ ...CORRECTION, supersedes: { id: 'old-1', content: 'x'.repeat(5000) } }],
    })
    expect(stage?.items[0].supersedes?.content).toHaveLength(500)
  })

  it('drops a half-formed supersession and keeps the finding', () => {
    // Both halves or neither: an id with no words states a correction the
    // reader cannot check, and words with no id have nothing to undo. The
    // finding was written either way, so it stays.
    for (const half of [{ id: 'old-1' }, { content: 'nur Text' }, 'nicht einmal ein Objekt', null]) {
      const stage = sanitizeMemoryReflectionStage({ items: [{ ...CORRECTION, supersedes: half }] })
      expect(stage?.items[0]).toEqual({
        id: CORRECTION.id,
        kind: CORRECTION.kind,
        content: CORRECTION.content,
      })
    }
  })

  it('never lets a retired note in as a recorded finding of its own', () => {
    const stage = sanitizeMemoryReflectionStage({ items: [CORRECTION] })
    expect(stage?.items.map((item) => item.id)).toEqual(['new-1'])
  })
})
