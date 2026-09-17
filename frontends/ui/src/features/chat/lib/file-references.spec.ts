import { describe, expect, it } from 'vitest'
import {
  fileNameFromHref,
  fileNamesPresentIn,
  fileReferenceHref,
  mentionsAnyFileType,
} from './file-references'

describe('mentionsAnyFileType', () => {
  it('fires on a filename the answer wrote', () => {
    expect(mentionsAnyFileType('Beginnen Sie mit pd8280-2.pdf.')).toBe(true)
  })

  it('fires on the formats a practice actually files', () => {
    for (const body of ['Bericht.docx', 'Massen.xlsx', 'Modell.ifc', 'Plan.dwg', 'Foto.jpeg']) {
      expect(mentionsAnyFileType(body)).toBe(true)
    }
  })

  // The gate exists to keep three list fetches off the answers that cannot
  // possibly need them, so a false positive costs real requests.
  it('stays quiet for prose with no document in it', () => {
    expect(mentionsAnyFileType('Die Fluchtweglänge beträgt 34 m [1].')).toBe(false)
    expect(mentionsAnyFileType('Siehe ris.bka.gv.at für die Fassung.')).toBe(false)
    expect(mentionsAnyFileType('Konzept v1.2 wurde verworfen.')).toBe(false)
  })
})

describe('fileNamesPresentIn', () => {
  const owned = ['pd8280-2.pdf', 'Wien-Lacknergasse-Grundrisse-floorplans.pdf', 'Statik.pdf']

  it('returns only the names the body actually writes', () => {
    const body = 'Zuerst pd8280-2.pdf, danach Wien-Lacknergasse-Grundrisse-floorplans.pdf.'
    expect(fileNamesPresentIn(body, owned)).toEqual([
      'Wien-Lacknergasse-Grundrisse-floorplans.pdf',
      'pd8280-2.pdf',
    ])
  })

  it('matches a name the answer spelled in a different case', () => {
    expect(fileNamesPresentIn('Siehe PD8280-2.PDF.', owned)).toEqual(['pd8280-2.pdf'])
  })

  it('handles a filename with spaces, which no grammar would', () => {
    const spaced = ['Wien Lacknergasse Schnitt.pdf']
    expect(fileNamesPresentIn('Der Schnitt Wien Lacknergasse Schnitt.pdf zeigt es.', spaced)).toEqual(
      spaced
    )
  })

  it('sorts longest first, so the longer name claims the text', () => {
    const both = ['Plan.pdf', 'Grundriss Plan.pdf']
    expect(fileNamesPresentIn('Siehe Grundriss Plan.pdf.', both)).toEqual([
      'Grundriss Plan.pdf',
      'Plan.pdf',
    ])
  })

  it('names nothing when the reader owns nothing the body mentions', () => {
    expect(fileNamesPresentIn('Siehe Konzept.pdf.', owned)).toEqual([])
  })

  it('ignores blank and duplicate index entries', () => {
    expect(fileNamesPresentIn('Statik.pdf', ['  ', 'Statik.pdf', 'statik.PDF'])).toEqual([
      'Statik.pdf',
    ])
  })
})

describe('the href a reference travels as', () => {
  it('round-trips a name', () => {
    const name = 'Wien Lacknergasse, Schnitt #2.pdf'
    expect(fileNameFromHref(fileReferenceHref(name))).toBe(name)
  })

  it('is not confused with a citation anchor or a heading link', () => {
    expect(fileNameFromHref('#answer-source-msg-1-3')).toBeNull()
    expect(fileNameFromHref('#gebaeudeklassen')).toBeNull()
  })

  it('survives a mangled escape sequence rather than throwing', () => {
    expect(fileNameFromHref('#file-ref-%E0%A4%A')).toBeNull()
  })
})
