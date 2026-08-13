/**
 * @vitest-environment node
 *
 * The container, read before it is opened.
 *
 * Two failures both came from treating a `.ifczip` as if it were its contents:
 * the extraction ceiling was measured on the COMPRESSED object (so a 40 MB
 * archive holding a 300 MB model passed a limit that exists to keep the BFF
 * alive), and the viewer's source object was written from the archive (so the
 * browser's geometry kernel, which does not unwrap zip and does not complain,
 * rendered nothing at all).
 *
 * Fixtures are built with the repository's own deterministic zip writer, so
 * these tests need no binary fixture and no zip dependency of their own.
 */

import { describe, expect, it, vi } from 'vitest'
import { createZip } from './zip'

vi.mock('server-only', () => ({}))

import { IfcArchiveError, isZipArchive, readArchiveModelEntries, unwrapIfcArchive } from './ifc-archive'

/** Minimal STEP that `looksLikeStepIfc` and the parser both accept as a start. */
const STEP = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"

const asArrayBuffer = (view: Uint8Array): ArrayBuffer =>
  view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer

const archive = (entries: Array<{ path: string; content: string | Uint8Array }>): ArrayBuffer =>
  asArrayBuffer(createZip(entries))

const GENEROUS = 250 * 1e6

describe('isZipArchive', () => {
  it('decides on the magic bytes, not on the file name', () => {
    expect(isZipArchive(archive([{ path: 'haus.ifc', content: STEP }]))).toBe(true)
    expect(isZipArchive(asArrayBuffer(new TextEncoder().encode(STEP)))).toBe(false)
    // A truncated read is not a zip, and must not index past the buffer.
    expect(isZipArchive(asArrayBuffer(new Uint8Array([0x50, 0x4b])))).toBe(false)
  })
})

describe('readArchiveModelEntries', () => {
  it('reports the opened size straight from the directory', () => {
    const entries = readArchiveModelEntries(archive([{ path: 'haus.ifc', content: STEP }]))

    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('haus.ifc')
    expect(entries[0].uncompressedBytes).toBe(new TextEncoder().encode(STEP).byteLength)
  })

  it('counts models only — a texture beside the model is not a second model', () => {
    const entries = readArchiveModelEntries(
      archive([
        { path: 'haus.ifc', content: STEP },
        { path: 'textures/wand.png', content: new Uint8Array([1, 2, 3]) },
        { path: 'liesmich.txt', content: 'egal' },
      ])
    )

    expect(entries.map((entry) => entry.name)).toEqual(['haus.ifc'])
  })

  it('ignores a macOS resource fork, which is not the model somebody zipped', () => {
    const entries = readArchiveModelEntries(
      archive([
        { path: 'haus.ifc', content: STEP },
        { path: '__MACOSX/._haus.ifc', content: new Uint8Array([0, 0, 0, 0]) },
      ])
    )

    expect(entries.map((entry) => entry.name)).toEqual(['haus.ifc'])
  })

  it('refuses bytes it cannot follow rather than guessing at their contents', () => {
    const bytes = new Uint8Array(64)
    // Zip magic, and nothing else that a zip has.
    bytes.set([0x50, 0x4b, 0x03, 0x04])

    expect(() => readArchiveModelEntries(asArrayBuffer(bytes))).toThrow(IfcArchiveError)
  })
})

describe('unwrapIfcArchive', () => {
  it('returns a plain IFC unchanged, so callers never branch on the extension', async () => {
    const plain = asArrayBuffer(new TextEncoder().encode(STEP))
    const result = await unwrapIfcArchive(plain, GENEROUS)

    expect(result.archived).toBe(false)
    expect(result.bytes).toBe(plain)
  })

  it('opens a container and hands back the model', async () => {
    const result = await unwrapIfcArchive(archive([{ path: 'haus.ifc', content: STEP }]), GENEROUS)

    expect(result.archived).toBe(true)
    expect(new TextDecoder().decode(result.bytes)).toBe(STEP)
  })

  it('refuses a model that does not fit BEFORE inflating it', async () => {
    // The ceiling that matters is the opened size. Under the old check this
    // archive — a few hundred compressed bytes — passed the 250 MB limit and
    // was then decompressed in full inside the request process.
    const bomb = archive([{ path: 'gross.ifc', content: 'A'.repeat(100_000) }])

    await expect(unwrapIfcArchive(bomb, 50_000)).rejects.toMatchObject({
      name: 'IfcArchiveError',
      code: 'too-large',
    })
    // The number in the message is the OPENED size, which is the one the
    // uploader has to do something about.
    await expect(unwrapIfcArchive(bomb, 50_000)).rejects.toThrow(/Unpacked model is/)
  })

  it('says an archive holds no model rather than failing as "not IFC"', async () => {
    await expect(
      unwrapIfcArchive(archive([{ path: 'plan.pdf', content: 'x' }]), GENEROUS)
    ).rejects.toMatchObject({ name: 'IfcArchiveError', code: 'not-ifc' })
  })

  it('refuses to pick one of several models', async () => {
    await expect(
      unwrapIfcArchive(
        archive([
          { path: 'haus-a.ifc', content: STEP },
          { path: 'haus-b.ifc', content: STEP },
        ]),
        GENEROUS
      )
    ).rejects.toThrow(/exactly one/)
  })
})
