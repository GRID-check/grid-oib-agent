/**
 * A zip writer is only correct if something else can read what it wrote, so
 * these tests parse the archive back out of the bytes rather than asserting on
 * offsets. The reader here is deliberately independent of the writer: it walks
 * the END-OF-CENTRAL-DIRECTORY record and the central directory, which is how
 * every real unzip finds entries, so a writer that only happens to produce
 * self-consistent local headers still fails.
 *
 * Checked against Info-ZIP (`unzip -t`) and Python's `zipfile` during
 * development; those cannot run in vitest, hence the reader below.
 */

import { describe, expect, it } from 'vitest'
import { createZip, crc32, type ZipEntry } from './zip'

interface ReadEntry {
  path: string
  content: string
  crcMatches: boolean
}

const decoder = new TextDecoder()

/** Read entries the way an unzip does: EOCD → central directory → local data. */
function readZip(bytes: Uint8Array): ReadEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let eocd = -1
  for (let at = bytes.length - 22; at >= 0; at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record')

  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  const entries: ReadEntry[] = []

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad central directory signature')
    const crc = view.getUint32(at + 16, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const localOffset = view.getUint32(at + 42, true)
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))

    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('bad local header signature')
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataAt = localOffset + 30 + localNameLength + localExtraLength
    const data = bytes.subarray(dataAt, dataAt + size)

    entries.push({ path, content: decoder.decode(data), crcMatches: crc32(data) === crc })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

const sample: ZipEntry[] = [
  { path: 'bcf.version', content: '<Version VersionId="2.1" />' },
  { path: 'a-topic/markup.bcf', content: '<Markup />' },
]

describe('createZip', () => {
  it('writes an archive an independent reader can walk', () => {
    const entries = readZip(createZip(sample))

    expect(entries.map((entry) => entry.path)).toEqual(['bcf.version', 'a-topic/markup.bcf'])
    expect(entries[0].content).toBe('<Version VersionId="2.1" />')
    expect(entries[1].content).toBe('<Markup />')
    expect(entries.every((entry) => entry.crcMatches)).toBe(true)
  })

  it('round-trips non-ASCII content and paths as UTF-8', () => {
    // A German ledger is all Umlaute; a writer that only handled ASCII would
    // pass every other test in this file.
    const entries = readZip(
      createZip([{ path: 'grüße/prüfbuch.bcf', content: 'Öffnungsmaß — 0,90 m ≥ 0,80 m' }])
    )

    expect(entries[0].path).toBe('grüße/prüfbuch.bcf')
    expect(entries[0].content).toBe('Öffnungsmaß — 0,90 m ≥ 0,80 m')
    expect(entries[0].crcMatches).toBe(true)
  })

  it('sets the UTF-8 name flag so readers do not decode paths as CP437', () => {
    const bytes = createZip([{ path: 'grüße.txt', content: 'x' }])
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800)
  })

  it('produces byte-identical output for identical input', () => {
    // The property the BCF exporter depends on: an unchanged ledger must
    // export to a file a reviewer can diff against the last one. A clock in
    // the header would break this and nothing else would notice.
    expect(createZip(sample)).toEqual(createZip(sample))
  })

  it('writes an empty archive rather than refusing one', () => {
    const bytes = createZip([])

    expect(readZip(bytes)).toEqual([])
    expect(bytes.length).toBe(22)
  })

  it('carries binary content through untouched', () => {
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a])
    const bytes = createZip([{ path: 'blob.bin', content: payload }])
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const nameLength = view.getUint16(26, true)
    const dataAt = 30 + nameLength

    expect([...bytes.subarray(dataAt, dataAt + payload.length)]).toEqual([...payload])
    expect(view.getUint32(14, true)).toBe(crc32(payload))
  })

  it('refuses a duplicate path instead of writing an ambiguous archive', () => {
    expect(() =>
      createZip([
        { path: 'markup.bcf', content: 'a' },
        { path: 'markup.bcf', content: 'b' },
      ])
    ).toThrow(/Duplicate zip entry path/)
  })

  it('marks a trailing-slash entry as a directory', () => {
    const bytes = createZip([{ path: 'topic/', content: '' }])
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    // External attributes live at +38 in the central directory header.
    let at = -1
    for (let i = bytes.length - 22; i >= 0; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) { at = view.getUint32(i + 16, true); break }
    }
    expect(view.getUint32(at + 38, true) & 0x10).toBe(0x10)
  })

  it('refuses a traversing path, not just an absolute one', () => {
    // The guard rejected '', '/x' and backslashes — and accepted the one shape
    // that actually escapes a target directory on extraction.
    expect(() => createZip([{ path: '../../etc/passwd', content: 'x' }])).toThrow(
      /Invalid zip entry path/
    )
  })

  it.each(['', '/absolute.txt', 'windows\\path.txt'])('refuses the path %j', (path) => {
    expect(() => createZip([{ path, content: 'x' }])).toThrow(/Invalid zip entry path/)
  })
})

describe('crc32', () => {
  it('matches the published check value', () => {
    // The IEEE 802.3 check value for "123456789" — the standard vector every
    // CRC-32 implementation is expected to reproduce.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('is zero for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})
