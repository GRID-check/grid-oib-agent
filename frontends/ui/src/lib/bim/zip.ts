/**
 * A minimal, deterministic ZIP writer.
 *
 * BCF is a zip container, and this repository has no zip dependency. Adding
 * one for a format we write (never read) and use in exactly one place is a
 * poor trade: the store-only subset of PKZIP is about a hundred lines, has no
 * transitive surface, and — unlike a general library — can be made
 * BYTE-DETERMINISTIC, which matters here. Two exports of an unchanged ledger
 * must produce identical bytes so a reviewer can diff them, and a timestamp
 * baked in at write time would defeat that.
 *
 * Store-only (compression method 0) is a deliberate choice too. BCF payloads
 * are a few kilobytes of XML per topic; deflating them saves nothing worth a
 * `zlib` round trip, and every BCF reader supports stored entries because the
 * format's own snapshots are already-compressed PNGs.
 *
 * Not a general-purpose archiver: no directories, no zip64, no encryption. It
 * refuses inputs it cannot encode correctly rather than truncating them.
 */

/** 4 GiB — beyond this the central directory needs zip64 fields we do not write. */
const MAX_ENTRY_BYTES = 0xffffffff
/** The 16-bit entry counter in the end-of-central-directory record. */
const MAX_ENTRIES = 0xffff

/** Bit 11: the file name is UTF-8 rather than CP437. */
const FLAG_UTF8_NAMES = 0x0800

/**
 * The single timestamp every entry carries: 1980-01-01T00:00:00, the earliest
 * a DOS date can express. A real clock would make the archive irreproducible.
 */
const DOS_DATE = (1 << 5) | 1
const DOS_TIME = 0

export interface ZipEntry {
  /** Forward-slash path inside the archive, e.g. `<guid>/markup.bcf`. */
  path: string
  content: string | Uint8Array
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Writes little-endian fields in the order the PKZIP records declare them. */
class ByteWriter {
  private readonly chunks: Uint8Array[] = []
  private length = 0

  u16(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]))
  }

  u32(value: number): void {
    this.push(
      new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff])
    )
  }

  bytes(value: Uint8Array): void {
    this.push(value)
  }

  get offset(): number {
    return this.length
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length)
    let at = 0
    for (const chunk of this.chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  }

  private push(chunk: Uint8Array): void {
    this.chunks.push(chunk)
    this.length += chunk.length
  }
}

const encoder = new TextEncoder()

const toBytes = (content: string | Uint8Array): Uint8Array =>
  typeof content === 'string' ? encoder.encode(content) : content

/**
 * Pack entries into a stored-only zip archive.
 *
 * Entry order is preserved rather than sorted: BCF readers do not care, but a
 * caller that emits `bcf.version` first produces an archive whose first bytes
 * identify the format, which is what a human running `unzip -l` wants to see.
 */
export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`Cannot write ${entries.length} zip entries; the format caps at ${MAX_ENTRIES}`)
  }
  const seen = new Set<string>()
  const body = new ByteWriter()
  const directory = new ByteWriter()

  for (const entry of entries) {
    if (entry.path === '' || entry.path.startsWith('/') || entry.path.includes('\\')) {
      throw new Error(`Invalid zip entry path: ${JSON.stringify(entry.path)}`)
    }
    if (seen.has(entry.path)) throw new Error(`Duplicate zip entry path: ${entry.path}`)
    seen.add(entry.path)

    const name = encoder.encode(entry.path)
    const data = toBytes(entry.content)
    if (data.length > MAX_ENTRY_BYTES) {
      throw new Error(`Zip entry ${entry.path} is too large for a non-zip64 archive`)
    }
    const checksum = crc32(data)
    const localOffset = body.offset

    body.u32(0x04034b50)
    body.u16(20) // version needed to extract
    body.u16(FLAG_UTF8_NAMES)
    body.u16(0) // stored
    body.u16(DOS_TIME)
    body.u16(DOS_DATE)
    body.u32(checksum)
    body.u32(data.length)
    body.u32(data.length)
    body.u16(name.length)
    body.u16(0) // extra field length
    body.bytes(name)
    body.bytes(data)

    directory.u32(0x02014b50)
    directory.u16(20) // version made by
    directory.u16(20) // version needed to extract
    directory.u16(FLAG_UTF8_NAMES)
    directory.u16(0) // stored
    directory.u16(DOS_TIME)
    directory.u16(DOS_DATE)
    directory.u32(checksum)
    directory.u32(data.length)
    directory.u32(data.length)
    directory.u16(name.length)
    directory.u16(0) // extra field length
    directory.u16(0) // comment length
    directory.u16(0) // disk number start
    directory.u16(0) // internal attributes
    directory.u32(0) // external attributes
    directory.u32(localOffset)
    directory.bytes(name)
  }

  const out = new ByteWriter()
  out.bytes(body.finish())
  const directoryOffset = out.offset
  out.bytes(directory.finish())
  const directorySize = out.offset - directoryOffset

  out.u32(0x06054b50)
  out.u16(0) // this disk
  out.u16(0) // disk with the central directory
  out.u16(entries.length)
  out.u16(entries.length)
  out.u32(directorySize)
  out.u32(directoryOffset)
  out.u16(0) // archive comment length
  return out.finish()
}
