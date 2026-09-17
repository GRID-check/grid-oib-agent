/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { extChipTint, fileExtensionLabel, inferDocumentKind } from './document-kind'

describe('inferDocumentKind', () => {
  describe('tag-based inference (controlled vocabulary wins)', () => {
    it('maps the controlled tags onto their kinds', () => {
      expect(inferDocumentKind({ filename: 'x.pdf', tags: ['Grundriss'] })).toBe('floorplan')
      expect(inferDocumentKind({ filename: 'x.pdf', tags: ['Schnitt'] })).toBe('section')
      expect(inferDocumentKind({ filename: 'x.pdf', tags: ['Ansicht'] })).toBe('section')
      expect(inferDocumentKind({ filename: 'x.pdf', tags: ['Bebauungsplan'] })).toBe('siteplan')
      expect(inferDocumentKind({ filename: 'x.pdf', tags: ['Flächenwidmungsplan'] })).toBe('siteplan')
      expect(inferDocumentKind({ filename: 'x.pdf', tags: ['Bescheid'] })).toBe('notice')
      expect(inferDocumentKind({ filename: 'x.pdf', tags: ['Foto'] })).toBe('photo')
    })

    it('prefers tags over filename heuristics', () => {
      expect(
        inferDocumentKind({ filename: 'grundriss_eg.pdf', tags: ['Bescheid'] })
      ).toBe('notice')
    })

    it('skips non-distinctive tags and keeps scanning', () => {
      expect(
        inferDocumentKind({ filename: 'x.pdf', tags: ['Brandschutz', 'Schnitt'] })
      ).toBe('section')
    })

    it('falls through to other signals when no tag matches', () => {
      expect(inferDocumentKind({ filename: 'gutachten.pdf', tags: ['Gutachten'] })).toBe('document')
    })
  })

  describe('content-type inference', () => {
    it('treats any image/* content type as a photo', () => {
      expect(inferDocumentKind({ filename: 'scan_001.tif', contentType: 'image/tiff' })).toBe('photo')
      expect(inferDocumentKind({ filename: 'baustelle', contentType: 'image/jpeg' })).toBe('photo')
    })
  })

  describe('filename heuristics', () => {
    it('detects floor plans', () => {
      expect(inferDocumentKind({ filename: 'Grundriss_EG.pdf' })).toBe('floorplan')
      expect(inferDocumentKind({ filename: 'floor-plan-L2.pdf' })).toBe('floorplan')
      expect(inferDocumentKind({ filename: 'einreichplan.pdf' })).toBe('floorplan')
    })

    it('detects sections and elevations', () => {
      expect(inferDocumentKind({ filename: 'Schnitt_A-A.pdf' })).toBe('section')
      expect(inferDocumentKind({ filename: 'ansicht-nord.pdf' })).toBe('section')
    })

    it('detects site plans before the generic plan pattern', () => {
      expect(inferDocumentKind({ filename: 'Lageplan_1-500.pdf' })).toBe('siteplan')
      expect(inferDocumentKind({ filename: 'site-plan.pdf' })).toBe('siteplan')
      expect(inferDocumentKind({ filename: 'Bebauungsplan_7769.pdf' })).toBe('siteplan')
      expect(inferDocumentKind({ filename: 'flaechenwidmung.pdf' })).toBe('siteplan')
    })

    it('detects official notices', () => {
      expect(inferDocumentKind({ filename: 'Baubescheid_2025.pdf' })).toBe('notice')
      expect(inferDocumentKind({ filename: 'baugenehmigung.pdf' })).toBe('notice')
    })

    it('detects photos by extension and name', () => {
      expect(inferDocumentKind({ filename: 'IMG_2041.jpeg' })).toBe('photo')
      expect(inferDocumentKind({ filename: 'baustellenfoto.pdf' })).toBe('photo')
    })

    it('defaults to a generic document', () => {
      expect(inferDocumentKind({ filename: 'vertrag_2024.docx', tags: [], contentType: null })).toBe(
        'document'
      )
      expect(inferDocumentKind({ filename: 'anhang_c', tags: [], contentType: null })).toBe('document')
    })
  })

  /**
   * The bug this rule exists for: `plan` matches ANYWHERE in a filename, so a
   * `.md` called `Projektplan` drew a floor-plan card — outer walls, interior
   * partitions and a door swing over a file that is prose. The format is the
   * one signal that cannot be wrong about this, so it is read first.
   */
  describe('format beats every other signal', () => {
    it('never draws a drawing for a format whose bytes cannot be one', () => {
      expect(inferDocumentKind({ filename: 'Projektplan.md' })).toBe('text')
      expect(inferDocumentKind({ filename: 'Sanierungsplanung.txt' })).toBe('text')
      expect(inferDocumentKind({ filename: 'Zeitplan.csv' })).toBe('sheet')
      expect(inferDocumentKind({ filename: 'Grundriss_Auszug.xlsx' })).toBe('sheet')
    })

    it('outranks an ingestion tag, exactly as the .ifc rule does', () => {
      expect(inferDocumentKind({ filename: 'auszug.md', tags: ['Grundriss'] })).toBe('text')
      expect(inferDocumentKind({ filename: 'raumbuch.csv', tags: ['Schnitt'] })).toBe('sheet')
      expect(inferDocumentKind({ filename: 'Grundriss EG.ifc', tags: ['Grundriss'] })).toBe('model')
    })

    it('reads the content type too, for a name that carries no extension', () => {
      expect(inferDocumentKind({ filename: 'Bauzeitplan', contentType: 'text/markdown' })).toBe('text')
      expect(inferDocumentKind({ filename: 'Bauzeitplan', contentType: 'text/csv' })).toBe('sheet')
      expect(
        inferDocumentKind({
          filename: 'Kostenplan',
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
      ).toBe('sheet')
    })

    it('leaves the formats that really can be drawings to the heuristics', () => {
      expect(inferDocumentKind({ filename: 'Grundriss EG.pdf' })).toBe('floorplan')
      expect(inferDocumentKind({ filename: 'Lageplan.dwg' })).toBe('siteplan')
    })
  })
})

describe('fileExtensionLabel', () => {
  it('extracts and uppercases the extension', () => {
    expect(fileExtensionLabel('plan.pdf')).toBe('PDF')
    expect(fileExtensionLabel('archive.tar.gz')).toBe('GZ')
    expect(fileExtensionLabel('Entwurf.DOCX')).toBe('DOCX')
  })

  it('returns an empty string when there is no extension', () => {
    expect(fileExtensionLabel('README')).toBe('')
    expect(fileExtensionLabel('')).toBe('')
  })
})

describe('extChipTint', () => {
  it('uses token-based CSS values only (no hex)', () => {
    for (const ext of ['pdf', 'docx', 'dwg', 'ifc', 'jpg', 'zzz', '']) {
      const tint = extChipTint(ext)
      expect(tint.background).toMatch(/^var\(--/)
      expect(tint.color).toMatch(/^var\(--/)
      expect(tint.background).not.toMatch(/#/)
      expect(tint.color).not.toMatch(/#/)
    }
  })

  it('groups extensions sensibly and is case-insensitive', () => {
    expect(extChipTint('PDF')).toEqual(extChipTint('docx'))
    expect(extChipTint('dwg')).toEqual(extChipTint('ifc'))
    expect(extChipTint('jpg')).toEqual(extChipTint('png'))
    expect(extChipTint('pdf')).not.toEqual(extChipTint('dwg'))
    // Unknown extensions get the neutral tint.
    expect(extChipTint('zzz')).toEqual(extChipTint(''))
  })
})
