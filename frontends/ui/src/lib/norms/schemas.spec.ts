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

  it('parses a behoerdliche_info entry with only a source_url (no RIS pointer)', () => {
    const parsed = normEntrySchema.parse({
      id: 'ma37-merkblatt-stellplatz',
      title: 'MA 37 — Merkblatt Stellplatzverpflichtung',
      short: 'MA 37 Stellplatz',
      rank: 'behoerdliche_info',
      source_url: 'https://www.wien.gv.at/stadtentwicklung/ma37/merkblatt.pdf',
    })
    expect(parsed.rank).toBe('behoerdliche_info')
    expect(parsed.source_url).toBe('https://www.wien.gv.at/stadtentwicklung/ma37/merkblatt.pdf')
    expect(parsed.application).toBe('')
    expect(parsed.document_number).toBe('')
  })

  it('parses a norm_extern entry with no pointer at all', () => {
    const parsed = normEntrySchema.parse({
      id: 'oenorm-b-1300',
      title: 'ÖNORM B 1300',
      short: 'ÖNORM B 1300',
      rank: 'norm_extern',
    })
    expect(parsed.rank).toBe('norm_extern')
    expect(parsed.application).toBe('')
    expect(parsed.document_number).toBe('')
    expect(parsed.source_url).toBe('')
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

  it('defaults the CountryProfile override fields when absent', () => {
    const parsed = normsFileSchema.parse({ version: 1, entries: [] })
    expect(parsed.corpus_collection).toBe('oib_knowledge')
    expect(parsed.language).toBe('')
    expect(parsed.states).toEqual({})
    expect(parsed.corpus_note).toBe('')
    expect(parsed.doctrine).toBe('')
    expect(parsed.parcel_tags).toEqual([])
  })

  it('round-trips the CountryProfile override fields verbatim', () => {
    const input = {
      version: 1 as const,
      corpus_collection: 'de_knowledge',
      language: 'de-DE',
      states: { bayern: 'Bayern', ausserhalb: null },
      corpus_note: 'Korpus-Hinweis',
      doctrine: 'Custom doctrine',
      parcel_tags: ['Bebauungsplan'],
      entries: [validEntry],
    }
    const parsed = normsFileSchema.parse(input)
    expect(parsed.corpus_collection).toBe('de_knowledge')
    expect(parsed.language).toBe('de-DE')
    expect(parsed.states).toEqual({ bayern: 'Bayern', ausserhalb: null })
    expect(parsed.corpus_note).toBe('Korpus-Hinweis')
    expect(parsed.doctrine).toBe('Custom doctrine')
    expect(parsed.parcel_tags).toEqual(['Bebauungsplan'])
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

describe('backend null contract (regression: Register konnte nicht geladen werden)', () => {
  it('parses an entry whose verify seed is null (pydantic VerifySeed | None)', () => {
    // The backend serializes a seedless entry as `verify: null`; `.optional()`
    // alone would reject it and fail the whole registry load.
    const parsed = normEntrySchema.parse({
      id: 'ma37-merkblaetter',
      title: 'MA 37 Merkblätter',
      short: 'MA 37',
      rank: 'behoerdliche_info',
      bundesland: 'Wien',
      source_url: 'https://www.wien.gv.at/x',
      binding_note: null,
      review_note: null,
      verify: null,
    })
    expect(parsed.verify).toBeNull()
    expect(parsed.id).toBe('ma37-merkblaetter')
  })

  it('parses the full GET envelope shape with a null-verify entry present', () => {
    const envelope = {
      version: 1,
      registry: {
        version: 1,
        corpus_collection: 'oib_knowledge',
        language: '',
        states: { wien: 'Wien', ausserhalb_oesterreichs: null },
        corpus_note: '',
        doctrine: '',
        parcel_tags: [],
        entries: [
          validEntry,
          { id: 'ma37', title: 'MA 37', short: 'MA 37', rank: 'behoerdliche_info', verify: null },
        ],
      },
    }
    const parsed = putNormRegistryBodySchema.parse(envelope)
    expect(parsed.registry.entries).toHaveLength(2)
    expect(parsed.registry.states.ausserhalb_oesterreichs).toBeNull()
  })
})
