/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  OFFICE_RENDITION_CONTENT_TYPES,
  OFFICE_RENDITION_EXTENSIONS,
} from '@/lib/documents/preview-types'
import { de } from '@/i18n/dictionaries/de'
import { en } from '@/i18n/dictionaries/en'
import { createTranslator } from '@/i18n/translate'
import {
  extChipTint,
  fileExtensionLabel,
  fileFormatMessage,
  inferDocumentKind,
  type FileFormatKey,
} from './document-kind'

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

describe('fileFormatMessage', () => {
  const tDe = createTranslator(de, 'files')
  const tEn = createTranslator(en, 'files')
  const label = (
    t: typeof tDe,
    file: { filename?: string | null; contentType?: string | null }
  ): string | null => {
    const message = fileFormatMessage(file)
    return message ? t(`preview.formats.${message.key}`, message.values) : null
  }

  it('names the office formats instead of their MIME type', () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    expect(label(tDe, { filename: 'Vertrag.docx', contentType: docx })).toBe('Word-Dokument')
    expect(label(tEn, { filename: 'Vertrag.docx', contentType: docx })).toBe('Word document')
    expect(label(tDe, { filename: 'Kosten.xlsx' })).toBe('Excel-Tabelle')
    expect(label(tDe, { filename: 'Vortrag.pptx' })).toBe('PowerPoint-Präsentation')
    expect(label(tDe, { filename: 'Bericht.odt' })).toBe('OpenDocument-Text')
    expect(label(tDe, { filename: 'Liste.ods' })).toBe('OpenDocument-Tabelle')
    expect(label(tDe, { filename: 'Folien.odp' })).toBe('OpenDocument-Präsentation')
  })

  it('names the building-office formats', () => {
    expect(label(tDe, { filename: 'Bescheid.pdf', contentType: 'application/pdf' })).toBe('PDF')
    expect(label(tDe, { filename: 'Termine.csv', contentType: 'text/csv' })).toBe('CSV-Tabelle')
    expect(label(tDe, { filename: 'Notiz.md' })).toBe('Markdown')
    expect(label(tDe, { filename: 'Haus.ifc' })).toBe('IFC-Modell')
    expect(label(tEn, { filename: 'Haus.ifc' })).toBe('IFC model')
  })

  it('labels images by their format, normalising the spellings', () => {
    expect(label(tDe, { filename: 'foto.png', contentType: 'image/png' })).toBe('Bild (PNG)')
    expect(label(tEn, { filename: 'foto.jpg' })).toBe('Image (JPEG)')
    expect(label(tDe, { filename: 'scan', contentType: 'image/svg+xml' })).toBe('Bild (SVG)')
  })

  it('trusts a known extension over a generic stored type', () => {
    expect(label(tDe, { filename: 'Plan.docx', contentType: 'application/octet-stream' })).toBe(
      'Word-Dokument'
    )
    expect(label(tDe, { filename: 'Plan.docx', contentType: null })).toBe('Word-Dokument')
  })

  it('falls back to a known type when the name has no extension, ignoring parameters and case', () => {
    expect(label(tDe, { filename: 'Protokoll', contentType: 'text/Markdown; charset=utf-8' })).toBe(
      'Markdown'
    )
  })

  it('falls back to the extension in caps, then to the raw type, then to nothing', () => {
    expect(label(tDe, { filename: 'Detail.dwg', contentType: 'application/acad' })).toBe('DWG-Datei')
    expect(label(tEn, { filename: 'Detail.dwg' })).toBe('DWG file')
    expect(label(tDe, { filename: 'Export', contentType: 'application/x-custom' })).toBe(
      'application/x-custom'
    )
    expect(fileFormatMessage({ filename: 'Export', contentType: null })).toBeNull()
  })

  it('names every office type and extension the BFF renders (preview-types.ts)', () => {
    for (const contentType of OFFICE_RENDITION_CONTENT_TYPES) {
      expect(fileFormatMessage({ filename: 'x', contentType })?.key, contentType).not.toMatch(
        /^(extension|raw)$/
      )
    }
    for (const ext of OFFICE_RENDITION_EXTENSIONS) {
      expect(fileFormatMessage({ filename: `x${ext}` })?.key, ext).not.toMatch(/^(extension|raw)$/)
    }
  })

  it('has a label for every format key in every dictionary', () => {
    const keys: FileFormatKey[] = [
      'pdf', 'word', 'excel', 'powerpoint', 'odText', 'odSpreadsheet', 'odPresentation', 'rtf',
      'csv', 'tsv', 'markdown', 'plainText', 'ifc', 'email', 'image', 'extension', 'raw',
    ]
    for (const dictionary of [en, de]) {
      for (const key of keys) {
        expect(typeof dictionary.files.preview.formats[key], key).toBe('string')
      }
    }
  })
})
