/**
 * @vitest-environment node
 */
/**
 * The vocabularies, and the copy they oblige.
 *
 * Three tuples meet in this feature — the diagram source kinds, the refusal
 * reasons, and the generated-document producers — and each one is a promise
 * that adding a member is a small change. This spec is what makes that promise
 * true: a member added without its facts, without its copy in BOTH locales, or
 * without the producer that files it, fails here rather than reaching a reader
 * as `undefined`.
 */
import { describe, expect, it } from 'vitest'
import { de } from '@/i18n/dictionaries/de'
import { en } from '@/i18n/dictionaries/en'
import { GENERATED_DOCUMENT_PRODUCERS } from '@/lib/documents/generated'
import {
  DIAGRAM_SOURCE_FACTS,
  DIAGRAM_SOURCE_KINDS,
  MAX_DIAGRAM_SVG_BYTES,
  isDiagramSourceKind,
} from './diagram-sources'
import { DIAGRAM_SVG_REJECTIONS } from './svg'

describe('the diagram source vocabulary', () => {
  it('starts with the two kinds a model can write', () => {
    // Declared, not implemented: the SERVER never renders, so it is indifferent
    // to which kinds a browser can draw. Declaring `excalidraw` now is what
    // makes adding its renderer later one entry in a map rather than a
    // vocabulary migration over stored rows.
    expect([...DIAGRAM_SOURCE_KINDS]).toEqual(['mermaid', 'excalidraw'])
  })

  it('states facts for every member, derived rather than restated', () => {
    for (const kind of DIAGRAM_SOURCE_KINDS) {
      const facts = DIAGRAM_SOURCE_FACTS[kind]
      expect(facts.contentType).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/)
      expect(facts.extension).toMatch(/^[a-z]+$/)
      expect(facts.maxSourceBytes).toBeGreaterThan(0)
      // A source cap above the SVG cap would be a source that cannot be stored
      // inside the diagram it describes.
      expect(facts.maxSourceBytes).toBeLessThan(MAX_DIAGRAM_SVG_BYTES)
    }
  })

  it('recognises only its own members', () => {
    expect(isDiagramSourceKind('mermaid')).toBe(true)
    expect(isDiagramSourceKind('graphviz')).toBe(false)
    expect(isDiagramSourceKind(null)).toBe(false)
  })
})

describe('the producer tuple grew, and grew by two', () => {
  it('carries the diagram producers beside the first one', () => {
    // A producer is a KIND OF DELIVERABLE. The SVG and the PDF are two files a
    // reader uses for two different things, and since migration 0065 the
    // producer is half the idempotency key — so one `diagram` member would make
    // a diagram file one artifact or the other and never both.
    expect([...GENERATED_DOCUMENT_PRODUCERS]).toEqual(['deep_research', 'diagram_svg', 'diagram_pdf'])
  })

  it('did not disturb the producer that was already there', () => {
    // The first member has to stay first and stay spelled the same: it is a
    // value already written into `documents.authored_by_producer` on real rows.
    expect(GENERATED_DOCUMENT_PRODUCERS[0]).toBe('deep_research')
  })
})

describe('every refusal can be read, in both locales', () => {
  it('has English copy for every rejection', () => {
    const missing = DIAGRAM_SVG_REJECTIONS.filter((reason) => !en.diagrams.rejected[reason])
    expect(missing).toEqual([])
  })

  it('has German copy for every rejection', () => {
    // A missing key is not a compile error here — `rejected` is keyed by the
    // tuple, and the German namespace is annotated `typeof en.diagrams`, so the
    // two locales cannot drift from EACH OTHER. What they can both miss is a
    // member the tuple gained, which is what this pair catches.
    const missing = DIAGRAM_SVG_REJECTIONS.filter((reason) => !de.diagrams.rejected[reason])
    expect(missing).toEqual([])
  })

  it('says something different in each locale, so neither is a copy of the other', () => {
    for (const reason of DIAGRAM_SVG_REJECTIONS) {
      expect(de.diagrams.rejected[reason]).not.toBe(en.diagrams.rejected[reason])
    }
  })

  it('marks the PDF in both locales, and says it claims no dimensions', () => {
    // The marking is the artifact, not the chrome — it is what reaches the
    // Behörde. Both halves are load-bearing: that a machine wrote it, and that
    // it is schematic, which is the doctrine the schematic cards protect by
    // computing their geometry and this one can only state.
    expect(de.diagrams.marking).toContain('Von Piloti erstellt')
    expect(de.diagrams.marking).toContain('Schematisch')
    expect(en.diagrams.marking).toContain('Created by Piloti')
    expect(en.diagrams.marking).toContain('Schematic')
    expect(de.diagrams.schematicOnly).toBe('Schematisch — ohne Maßangabe.')
  })
})
