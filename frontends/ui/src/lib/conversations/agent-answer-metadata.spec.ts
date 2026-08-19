/**
 * @vitest-environment node
 */
/**
 * The translation between the backend's wire spelling and the stored contract.
 *
 * What these tests pin is that an answer persisted by the BACKEND (the client
 * dropped mid-turn — the case where the server row is the only copy) comes back
 * carrying the same three trust signals a browser-persisted one does: the
 * source's authority fields, the confidence level WITH its reason, and the
 * locators a citation needs to be clickable. Plus the two properties that make
 * that safe: the stored blob always decodes, and nothing is invented.
 */
import { describe, expect, it } from 'vitest'

import { CITATIONS_PAYLOAD_VERSION, decodeCitations } from '@/features/chat/lib/citations'
import {
  encodeBackendSources,
  normalizeAgentAnswerMetadata,
  provenanceFromBackendMetadata,
} from './agent-answer-metadata'

/** One source as `source_entry_to_wire` emits it for a knowledge-base passage. */
const kbSource = (overrides: Record<string, unknown> = {}) => ({
  number: 1,
  document_id: 'oib-rl-2:2019',
  content: '[KB] OIB-Richtlinie 2, S. 18',
  title: 'OIB-Richtlinie 2',
  citation_key: 'OIB-RL-2.pdf, p.18',
  collection: 'oib_base',
  shelf: 'base',
  source_type: 'knowledge_layer',
  tool: 'knowledge_search',
  origin: 'kb',
  kind: 'baurecht',
  lane: 'oib',
  lane_label: 'OIB-Richtlinie',
  file_name: 'OIB-RL-2.pdf',
  page: 18,
  ...overrides,
})

describe('encodeBackendSources', () => {
  it('carries the authority fields the backend stated, verbatim', () => {
    const encoded = encodeBackendSources([kbSource()])

    expect(encoded?.sources[0]).toMatchObject({
      source_type: 'knowledge_layer',
      origin: 'kb',
      shelf: 'base',
      kind: 'baurecht',
      lane: 'oib',
      lane_label: 'OIB-Richtlinie',
      collection: 'oib_base',
    })
  })

  it('carries the norm registry binding note when there is one, and nothing when there is not', () => {
    const ris = encodeBackendSources([
      kbSource({
        origin: 'ris',
        source_type: 'ris',
        binding_note: 'In Wien durch die Bauordnung verbindlich erklärt.',
      }),
    ])
    expect(ris?.sources[0].binding_note).toBe('In Wien durch die Bauordnung verbindlich erklärt.')

    // The absence of a binding note is a fact about the registry, not a licence
    // to derive one from `source_type`.
    const withoutNote = encodeBackendSources([kbSource()])
    expect(withoutNote?.sources[0]).not.toHaveProperty('binding_note')
  })

  it('keeps the click-through locators rather than only the display text', () => {
    const encoded = encodeBackendSources([kbSource()])

    expect(encoded?.sources[0]).toMatchObject({
      document_id: 'oib-rl-2:2019',
      file_name: 'OIB-RL-2.pdf',
      page: 18,
      citation_key: 'OIB-RL-2.pdf, p.18',
      number: 1,
    })
  })

  it('stores the versioned envelope the reader decodes', () => {
    const encoded = encodeBackendSources([kbSource()])
    expect(encoded?.v).toBe(CITATIONS_PAYLOAD_VERSION)
  })

  it('round-trips through the client decoder with the locators intact', () => {
    const encoded = encodeBackendSources([kbSource()])
    const [citation] = decodeCitations(encoded, new Date('2026-08-18T09:00:00.000Z')) ?? []

    expect(citation).toMatchObject({
      sourceType: 'knowledge_layer',
      origin: 'kb',
      documentId: 'oib-rl-2:2019',
      fileName: 'OIB-RL-2.pdf',
      page: 18,
      number: 1,
    })
  })

  it('drops an entry the reader would choke on rather than losing the whole row', () => {
    // `page: 0` fails the decoder's positive-int constraint, and the decoder
    // parses the envelope as a unit — one bad entry would take every citation
    // on the answer with it.
    const encoded = encodeBackendSources([
      kbSource({ page: 0 }),
      kbSource({ file_name: 'B.pdf', page: 4 }),
    ])

    expect(encoded?.sources).toHaveLength(2)
    expect(encoded?.sources[0]).not.toHaveProperty('page')
    expect(decodeCitations(encoded, new Date())).toHaveLength(2)
  })

  it('drops a source with nothing identifying on it', () => {
    expect(encodeBackendSources([{ source_type: 'web' }])).toBeUndefined()
  })

  it('drops non-object entries without failing the rest', () => {
    const encoded = encodeBackendSources([null, 'nonsense', kbSource()])
    expect(encoded?.sources).toHaveLength(1)
  })

  it('is undefined for an empty or non-array payload, so no key is written', () => {
    expect(encodeBackendSources([])).toBeUndefined()
    expect(encodeBackendSources(undefined)).toBeUndefined()
    expect(encodeBackendSources({ sources: [] })).toBeUndefined()
  })

  it('bounds the array and the free text, because this lands in jsonb', () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      kbSource({ file_name: `doc-${index}.pdf` })
    )
    expect(encodeBackendSources(many)?.sources).toHaveLength(200)

    const long = encodeBackendSources([kbSource({ content: 'x'.repeat(1000) })])
    expect(long?.sources[0].content).toHaveLength(400)
  })
})

describe('provenanceFromBackendMetadata', () => {
  it('carries the confidence level AND its reason — the level alone is the complaint', () => {
    expect(
      provenanceFromBackendMetadata({
        answer_confidence: 'low',
        answer_confidence_reason: 'Nur eine Quelle, und die ist ein Leitfaden.',
      })
    ).toEqual({
      answerConfidence: 'low',
      answerConfidenceReason: 'Nur eine Quelle, und die ist ein Leitfaden.',
    })
  })

  it('carries the deterministic cap reason alongside the level it capped', () => {
    expect(
      provenanceFromBackendMetadata({
        answer_confidence: 'low',
        answer_confidence_reason: 'Zitat nicht belegbar.',
        answer_confidence_capped_reason: 'quote_unverified',
      })
    ).toMatchObject({ answerConfidenceCappedReason: 'quote_unverified' })
  })

  it('carries the deep-research job pointer', () => {
    expect(provenanceFromBackendMetadata({ deep_research_job_id: 'job_42' })).toEqual({
      deepResearchJobId: 'job_42',
    })
  })

  it('carries the marks the run left on its own answer', () => {
    // The jobs runner is the ONLY writer a deep-research answer ever has, so
    // these four keys are not a backup of a live turn — they are the whole
    // record. Undecoded, a salvaged, partially researched report reopened
    // tomorrow rendered identically to a complete one.
    expect(
      provenanceFromBackendMetadata({
        research_truncated: true,
        truncation_reason: 'wall_clock',
        degraded_reasons: ['no_valid_citations'],
        citations_removed: { count: 2, reasons: ['url_not_in_registry'] },
      })
    ).toEqual({
      researchTruncated: true,
      truncationReason: 'wall_clock',
      degradedReasons: ['no_valid_citations'],
      citationsRemoved: { count: 2, reasons: ['url_not_in_registry'] },
    })
  })

  it('reads only literal true as a cutoff', () => {
    // Presence IS the fact. `false` on the row is one more default to
    // interpret, and telling a reader their research was cut off when nothing
    // recorded a cutoff is worse than telling them nothing.
    expect(
      provenanceFromBackendMetadata({ research_truncated: false, truncation_reason: 'wall_clock' })
    ).toEqual({ truncationReason: 'wall_clock' })
  })

  it('reads the cause even when the flag was lost, matching the backend extractor', () => {
    // `jobs/runner._extract_answer_transparency` reads the two independently: a
    // state that knows WHY it stopped still knows something true.
    expect(provenanceFromBackendMetadata({ truncation_reason: 'step_limit' })).toEqual({
      truncationReason: 'step_limit',
    })
  })

  it('drops a token it has no words for rather than storing it for a renderer', () => {
    expect(
      provenanceFromBackendMetadata({
        research_truncated: true,
        truncation_reason: 'tool_budget',
        degraded_reasons: ['quantum_flux', 'no_report_file'],
      })
    ).toEqual({ researchTruncated: true, degradedReasons: ['no_report_file'] })
  })

  it('yields nothing when the turn reported nothing', () => {
    expect(provenanceFromBackendMetadata({ cards: [] })).toBeNull()
  })

  it('refuses a level outside the enum instead of inventing one', () => {
    expect(
      provenanceFromBackendMetadata({
        answer_confidence: 'certain',
        answer_confidence_reason: 'Sicher.',
      })
    ).toEqual({ answerConfidenceReason: 'Sicher.' })
  })
})

describe('normalizeAgentAnswerMetadata', () => {
  const backendMetadata = {
    cards: [{ type: 'memory_proposal' }],
    sources: [kbSource()],
    answer_confidence: 'medium',
    answer_confidence_reason: 'Zwei übereinstimmende Fundstellen.',
    deep_research_job_id: 'job_7',
  }

  it('translates the wire keys into the contract every reader of a message row uses', () => {
    const result = normalizeAgentAnswerMetadata(backendMetadata)

    expect(result?.citations).toMatchObject({ v: CITATIONS_PAYLOAD_VERSION })
    expect(result?.provenance).toEqual({
      answerConfidence: 'medium',
      answerConfidenceReason: 'Zwei übereinstimmende Fundstellen.',
      deepResearchJobId: 'job_7',
    })
  })

  it('leaves the metadata both writers share untouched', () => {
    expect(normalizeAgentAnswerMetadata(backendMetadata)?.cards).toEqual([
      { type: 'memory_proposal' },
    ])
  })

  it('removes the wire spelling so the column holds one dialect', () => {
    const result =
      normalizeAgentAnswerMetadata({
        ...backendMetadata,
        research_truncated: true,
        truncation_reason: 'wall_clock',
        degraded_reasons: ['no_report_file'],
        citations_removed: { count: 1, reasons: ['unverifiable'] },
      }) ?? {}

    for (const key of [
      'sources',
      'answer_confidence',
      'answer_confidence_reason',
      'deep_research_job_id',
      'research_truncated',
      'truncation_reason',
      'degraded_reasons',
      'citations_removed',
    ]) {
      expect(result).not.toHaveProperty(key)
    }
  })

  it("normalizes a row that carries ONLY the run's marks", () => {
    // The row a cut-off deep run writes has no confidence and no sources to
    // translate. If those were what triggered the translation, this row — the
    // one that most needs it — would pass through untouched and the answer
    // would reopen looking finished.
    const result = normalizeAgentAnswerMetadata({
      messageType: 'agent_response',
      research_truncated: true,
      truncation_reason: 'wall_clock',
      degraded_reasons: ['no_valid_citations'],
    })

    expect(result?.provenance).toEqual({
      researchTruncated: true,
      truncationReason: 'wall_clock',
      degradedReasons: ['no_valid_citations'],
    })
    expect(result?.messageType).toBe('agent_response')
  })

  it('never overwrites what the browser wrote — it saw the whole turn', () => {
    const result = normalizeAgentAnswerMetadata({
      ...backendMetadata,
      citations: { v: CITATIONS_PAYLOAD_VERSION, sources: [{ url: 'https://ris.bka.gv.at/x' }] },
      provenance: { answerConfidence: 'high' },
    })

    expect(result?.citations).toEqual({
      v: CITATIONS_PAYLOAD_VERSION,
      sources: [{ url: 'https://ris.bka.gv.at/x' }],
    })
    expect(result?.provenance).toEqual({ answerConfidence: 'high' })
  })

  it('passes a browser-written payload through by identity, so the common path costs nothing', () => {
    const clientMetadata = {
      messageType: 'agent_response',
      citations: { v: CITATIONS_PAYLOAD_VERSION, sources: [] },
    }
    expect(normalizeAgentAnswerMetadata(clientMetadata)).toBe(clientMetadata)
  })

  it('tolerates no metadata at all', () => {
    expect(normalizeAgentAnswerMetadata(undefined)).toBeUndefined()
  })
})
