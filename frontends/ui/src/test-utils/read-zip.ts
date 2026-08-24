/**
 * A zip reader for tests, deliberately independent of `lib/bim/zip.ts`.
 *
 * The writer is only correct if something that does not share its code can
 * find the entries, so this walks the end-of-central-directory record and the
 * central directory the way a real unzip does — not the local headers the
 * writer happens to emit first. A writer that produced self-consistent local
 * headers and a broken directory would pass a naive round trip and fail every
 * tool an architect actually opens the file in.
 *
 * Verified against Info-ZIP (`unzip -t`) and Python's `zipfile`, neither of
 * which can run inside vitest.
 */

import { crc32 } from '@/lib/bim/zip'

const decoder = new TextDecoder()

/** Entry path → decoded UTF-8 content, in central-directory order. */
export function readZipEntries(bytes: Uint8Array): Map<string, string> {
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
  const out = new Map<string, string>()

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
    const dataAt =
      localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true)
    const data = bytes.subarray(dataAt, dataAt + size)
    if (crc32(data) !== crc) throw new Error(`crc mismatch for ${path}`)

    out.set(path, decoder.decode(data))
    at += 46 + nameLength + extraLength + commentLength
  }
  return out
}
