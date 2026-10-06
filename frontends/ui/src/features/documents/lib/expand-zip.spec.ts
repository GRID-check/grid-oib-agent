import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { MAX_ZIP_ENTRIES, expandZips } from './expand-zip'
import { isZipArchive, withZipAccepted } from './zip-types'

const text = (value: string): Uint8Array => strToU8(value)

/** A real archive, made the way a person's tool would. */
const zipFile = (name: string, entries: Record<string, Uint8Array>): File =>
  new File([zipSync(entries) as BlobPart], name, { type: 'application/zip' })

const pathOf = (file: File): string => file.webkitRelativePath

describe('isZipArchive', () => {
  it('takes a zip and leaves a model that merely ends in "zip"', () => {
    expect(isZipArchive({ name: 'Plaene.zip' })).toBe(true)
    expect(isZipArchive({ name: 'PLAENE.ZIP' })).toBe(true)
    expect(isZipArchive({ name: 'haus.ifczip' })).toBe(false)
    expect(isZipArchive({ name: 'zip' })).toBe(false)
  })
})

describe('withZipAccepted', () => {
  it('offers .zip once', () => {
    expect(withZipAccepted('.pdf,.docx')).toBe('.pdf,.docx,.zip')
    expect(withZipAccepted('.pdf, .ZIP')).toBe('.pdf, .ZIP')
  })
})

describe('expandZips', () => {
  it('hands loose files through untouched and in order', async () => {
    const a = new File(['a'], 'a.pdf')
    const b = new File(['b'], 'b.pdf')

    const { files, notes } = await expandZips([a, b])

    expect(files).toEqual([a, b])
    expect(notes).toEqual([])
  })

  it('keeps an archive\'s own top-level folder', async () => {
    const zip = zipFile('Einreichung.zip', {
      'Wohnbau/EG/grundriss.pdf': text('pdf'),
      'Wohnbau/OG/grundriss.pdf': text('pdf2'),
    })

    const { files } = await expandZips([zip])

    expect(files.map(pathOf)).toEqual(['Wohnbau/EG/grundriss.pdf', 'Wohnbau/OG/grundriss.pdf'])
    expect(files.map((file) => file.name)).toEqual(['grundriss.pdf', 'grundriss.pdf'])
  })

  it('puts loose members under a folder named after the archive', async () => {
    const zip = zipFile('Statik.zip', { 'a.pdf': text('a'), 'sub/b.pdf': text('b') })

    const { files } = await expandZips([zip])

    expect(files.map(pathOf)).toEqual(['Statik/a.pdf', 'Statik/sub/b.pdf'])
  })

  it('does not strip the root when the members merely start alike', async () => {
    const zip = zipFile('Mix.zip', { 'A/x.pdf': text('x'), 'B/y.pdf': text('y') })

    const { files } = await expandZips([zip])

    expect(files.map(pathOf)).toEqual(['Mix/A/x.pdf', 'Mix/B/y.pdf'])
  })

  it('carries the bytes and the MIME type a picker would have given', async () => {
    const zip = zipFile('Doku.zip', { 'Doku/bericht.pdf': text('%PDF-1.7'), 'Doku/notiz.txt': text('hallo') })

    const { files } = await expandZips([zip])

    const pdf = files.find((file) => file.name === 'bericht.pdf')!
    expect(pdf.type).toBe('application/pdf')
    expect(await pdf.text()).toBe('%PDF-1.7')
    expect(files.find((file) => file.name === 'notiz.txt')!.type).toBe('text/plain')
  })

  it('drops what macOS and Office put in archives without being asked', async () => {
    const zip = zipFile('Mac.zip', {
      'Mac/plan.pdf': text('plan'),
      'Mac/.DS_Store': text('x'),
      '__MACOSX/Mac/._plan.pdf': text('x'),
      'Mac/~$entwurf.docx': text('x'),
      'Mac/Thumbs.db': text('x'),
    })

    const { files, notes } = await expandZips([zip])

    expect(files.map(pathOf)).toEqual(['Mac/plan.pdf'])
    expect(notes).toEqual([])
  })

  it('refuses a name that climbs out of its folder instead of filing it somewhere else', async () => {
    const zip = zipFile('Boese.zip', { 'ok/a.pdf': text('a'), 'ok/../../etc/passwd': text('x') })

    const { files } = await expandZips([zip])

    expect(files.map(pathOf)).toEqual(['ok/a.pdf'])
  })

  it('passes a type the shelf does not accept, and a zip inside a zip, on as files', async () => {
    const inner = zipSync({ 'x.pdf': text('x') })
    const zip = zipFile('Outer.zip', { 'Outer/tool.exe': text('x'), 'Outer/inner.zip': inner })

    const { files } = await expandZips([zip])

    // Not decided here: the validator that already reports a type by name does.
    expect(files.map((file) => file.name)).toEqual(['inner.zip', 'tool.exe'])
  })

  it('unpacks several archives and keeps loose files between them', async () => {
    const loose = new File(['l'], 'l.pdf')

    const { files } = await expandZips([
      zipFile('One.zip', { 'a.pdf': text('a') }),
      loose,
      zipFile('Two.zip', { 'b.pdf': text('b') }),
    ])

    expect(files.map((file) => file.name)).toEqual(['a.pdf', 'l.pdf', 'b.pdf'])
    expect(pathOf(files[0])).toBe('One/a.pdf')
    expect(files[1]).toBe(loose)
  })

  it('says so for an archive that is not a zip', async () => {
    const broken = new File(['this is not a zip'], 'kaputt.zip')

    const { files, notes } = await expandZips([broken])

    expect(files).toEqual([])
    expect(notes).toEqual([{ zip: 'kaputt.zip', reason: 'unreadable', limit: '' }])
  })

  it('says so for an archive with nothing in it, and for one with only junk', async () => {
    const empty = zipFile('Leer.zip', { 'Leer/': new Uint8Array() })
    const junk = zipFile('Muell.zip', { '.DS_Store': text('x') })

    const { notes } = await expandZips([empty, junk])

    expect(notes.map((note) => [note.zip, note.reason])).toEqual([
      ['Leer.zip', 'empty'],
      ['Muell.zip', 'empty'],
    ])
  })

  it('refuses an archive with too many files rather than taking some of them', async () => {
    const entries: Record<string, Uint8Array> = {}
    for (let index = 0; index <= MAX_ZIP_ENTRIES; index += 1) entries[`Viele/${index}.txt`] = text('x')

    const { files, notes } = await expandZips([zipFile('Viele.zip', entries)])

    expect(files).toEqual([])
    expect(notes).toEqual([{ zip: 'Viele.zip', reason: 'tooManyFiles', limit: String(MAX_ZIP_ENTRIES) }])
  })

  it('keeps one bad archive from costing the good ones next to it', async () => {
    const { files, notes } = await expandZips([
      new File(['nope'], 'kaputt.zip'),
      zipFile('Gut.zip', { 'a.pdf': text('a') }),
    ])

    expect(files.map(pathOf)).toEqual(['Gut/a.pdf'])
    expect(notes).toHaveLength(1)
  })
})
