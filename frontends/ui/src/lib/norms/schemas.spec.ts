import { describe, expect, it } from 'vitest'

import {
  normEntrySchema,
  normsFileSchema,
  putNormRegistryBodySchema,
  verifyNormResponseSchema,
} from './schemas'

const validEntry = {
  id: 'oib-rl2-2023',
  title: 'OIB-Richtlinie 2 — Brandschutz (Ausgabe 2023)',
  short: 'OIB-RL 2',
  rank: 'verordnung',
  bundesland: 'Wien',
  topics: ['Brandschutz', 'Fluchtwege'],
  relevance: 'hoch',
  application: 'LrKons',
  document_number: 'NOR40251234',
  citation_url: 'https://ris.example/cite',
  full_law_url: 'https://ris.example/full',
  aliases: ['Richtlinie 2'],
  binding_note: 'Verbindlich in Wien.',
  review_note: 'Neuauflage 2024 prüfen.',
  verify: { title_query: 'OIB Richtlinie 2', exclude: ['Salzburg'], gesetzesnummer: '20000123' },
  verified_at: '2026-01-15',
}

describe('normEntrySchema', () => {
  it('parses a fully-populated valid entry', () => {
    const parsed = normEntrySchema.parse(validEntry)
    expect(parsed.id).toBe('oib-rl2-2023')
    expect(parsed.rank).toBe('verordnung')
    expect(parsed.topics).toEqual(['Brandschutz', 'Fluchtwege'])
    expect(parsed.verify?.exclude).toEqual(['Salzburg'])
  })

  it('applies defaults for a minimal entry (federal, unverified)', () => {
    const parsed = normEntrySchema.parse({
      id: 'bo-wien',
      title: 'Bauordnung',
      short: 'BO',
      rank: 'landesgesetz',
    })
    expect(parsed.bundesland).toBe('')
    expect(parsed.topics).toEqual([])
    expect(parsed.aliases).toEqual([])
    expect(parsed.verified_at).toBe('')
    expect(parsed.verify).toBeUndefined()
    expect(parsed.binding_note).toBeUndefined()
  })

  it('rejects an invalid rank', () => {
    const result = normEntrySchema.safeParse({ ...validEntry, rank: 'richtlinie' })
    expect(result.success).toBe(false)
  })

  it('rejects a missing id', () => {
    const { id: _omit, ...withoutId } = validEntry
    expect(normEntrySchema.safeParse(withoutId).success).toBe(false)
  })

  it('rejects an empty id', () => {
    expect(normEntrySchema.safeParse({ ...validEntry, id: '' }).success).toBe(false)
  })
})

describe('normsFileSchema', () => {
  it('requires the file-format version literal 1', () => {
    expect(normsFileSchema.safeParse({ version: 2, entries: [] }).success).toBe(false)
    expect(normsFileSchema.safeParse({ version: 1, entries: [validEntry] }).success).toBe(true)
  })
})

describe('putNormRegistryBodySchema', () => {
  it('accepts the concurrency-version envelope', () => {
    const parsed = putNormRegistryBodySchema.parse({
      version: 7,
      registry: { version: 1, entries: [validEntry] },
    })
    expect(parsed.version).toBe(7)
    expect(parsed.registry.entries).toHaveLength(1)
  })
})

describe('verifyNormResponseSchema', () => {
  it('parses candidates and verified_at', () => {
    const parsed = verifyNormResponseSchema.parse({
      candidates: [
        { title: 'OIB-RL 2', document_number: 'NOR1', citation_url: 'https://a', full_law_url: 'https://b' },
      ],
      verified_at: '2026-07-18',
    })
    expect(parsed.candidates[0].document_number).toBe('NOR1')
    expect(parsed.verified_at).toBe('2026-07-18')
  })
})
