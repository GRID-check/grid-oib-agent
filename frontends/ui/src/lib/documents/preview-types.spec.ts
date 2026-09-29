/**
 * The one preview list, pinned to the route that enforces it.
 *
 * Three surfaces decide "can this be shown": the preview route (which 415s
 * anything outside the list), the Files pane (which decides whether to ASK),
 * and the citation resolver (which decides whether a chip promises a viewer or
 * a download). They have drifted twice — BMP and TIFF both times — and each
 * copy looked locally correct, so nothing failed and a reader simply got told
 * the product could not show a file it renders fine.
 *
 * These are the assertions that make a fourth copy fail instead of ship.
 */

import { describe, expect, it } from 'vitest'
import {
  INLINE_PREVIEW_CONTENT_TYPES,
  OFFICE_RENDITION_CONTENT_TYPES,
  TEXT_PREVIEW_CONTENT_TYPES,
  isInlinePreviewable,
  isOfficeRenditionSource,
} from './preview-types'

describe('the preview content-type lists', () => {
  it('covers the image types the object store serves and the PDF', () => {
    expect([...INLINE_PREVIEW_CONTENT_TYPES]).toEqual([
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      // The two that went missing twice. Named individually because a length
      // check would pass the day someone swaps one for another.
      'image/bmp',
      'image/tiff',
    ])
  })

  it('never serves user-uploaded HTML as text from this origin', () => {
    // Same-origin HTML carries script into this origin. `service.ts` says so at
    // its own definition; this is the assertion behind the sentence.
    expect([...TEXT_PREVIEW_CONTENT_TYPES]).not.toContain('text/html')
  })

  it('matches case-insensitively and tolerates whitespace, because content types arrive as headers', () => {
    expect(isInlinePreviewable('APPLICATION/PDF')).toBe(true)
    expect(isInlinePreviewable(' image/png ')).toBe(true)
    expect(
      isInlinePreviewable('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    ).toBe(false)
    expect(isInlinePreviewable(null)).toBe(false)
    expect(isInlinePreviewable(undefined)).toBe(false)
  })

  it('keeps the two lists disjoint — a type is served one way or the other', () => {
    const inline = new Set<string>(INLINE_PREVIEW_CONTENT_TYPES)
    for (const type of TEXT_PREVIEW_CONTENT_TYPES) expect(inline.has(type)).toBe(false)
  })
})

/**
 * The third way of being shown (ADR-0070): not the stored bytes but a PDF the
 * BFF made from them. The preview route, the file route and the ingest dispatch
 * all ask this one predicate, so it is pinned here.
 */
describe('isOfficeRenditionSource', () => {
  it('recognises an office file by its stored type', () => {
    expect(
      isOfficeRenditionSource({
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename: 'Baubeschreibung',
      })
    ).toBe(true)
    expect(isOfficeRenditionSource({ contentType: 'application/vnd.ms-excel; charset=binary' })).toBe(true)
  })

  it('recognises one by its extension when the stored type is empty or generic', () => {
    expect(isOfficeRenditionSource({ contentType: null, filename: 'Kosten.XLSX' })).toBe(true)
    expect(isOfficeRenditionSource({ contentType: 'application/octet-stream', filename: 'Präsentation.pptx' })).toBe(
      true
    )
    expect(isOfficeRenditionSource({ filename: 'piloti/doc-1/bericht.docx' })).toBe(true)
    expect(isOfficeRenditionSource({ filename: 'protokoll.odt' })).toBe(true)
    expect(isOfficeRenditionSource({ filename: 'brief.rtf' })).toBe(true)
  })

  it('leaves everything that is shown some other way alone', () => {
    expect(isOfficeRenditionSource({ contentType: 'application/pdf', filename: 'plan.pdf' })).toBe(false)
    expect(isOfficeRenditionSource({ contentType: 'text/csv', filename: 'katalog.csv' })).toBe(false)
    expect(isOfficeRenditionSource({ contentType: 'image/png', filename: 'foto.png' })).toBe(false)
    expect(isOfficeRenditionSource({ filename: 'haus.ifc' })).toBe(false)
    expect(isOfficeRenditionSource({ filename: 'docx' })).toBe(false)
    expect(isOfficeRenditionSource({})).toBe(false)
  })

  it('never overlaps the inline list, so a stored PDF is never re-rendered', () => {
    const inline = new Set<string>(INLINE_PREVIEW_CONTENT_TYPES)
    for (const type of OFFICE_RENDITION_CONTENT_TYPES) expect(inline.has(type)).toBe(false)
  })
})
