/**
 * `.ifczip` — the container an IFC arrives in, and what has to be true before
 * its contents are read.
 *
 * A `.ifczip` is a plain zip wrapping one `.ifc`/`.ifcxml` model. Every layer
 * of this system already accepts one: the upload allow-list offers it, the
 * ceiling that governs it is the IFC ceiling, and `extractIfcModel` unwraps it
 * before parsing. Two things were still missing, and both of them are about the
 * fact that an archive is not its contents.
 *
 * ## 1. The ceiling was measured on the wrong number
 *
 * `MAX_IFC_BYTES` is checked against the OBJECT — the compressed archive — and
 * STEP text compresses by five to ten times. A 40 MB `.ifczip` is a 300 MB
 * model, so a file the extractor would refuse outright as a `.ifc` sailed
 * through as a `.ifczip` and was decompressed in full inside the BFF's Node
 * process, which is the exact failure the ceiling exists to prevent. The
 * parser's own guard is 4 GiB — a zip-bomb backstop, not a service limit — so
 * nothing between the two numbers stopped it.
 *
 * Zip declares the uncompressed size of every entry in its central directory,
 * before any byte is inflated. So the ceiling is checked THERE: an archive
 * whose model does not fit is refused with the same sentence a too-large `.ifc`
 * gets, having allocated nothing.
 *
 * ## 2. What the viewer is given must be the model, never the container
 *
 * The 3D viewport parses in the browser, and `@ifc-lite/geometry` does not
 * unwrap zip — only the parser does. So a `.ifczip` handed to it produces no
 * entities, no error, and an empty viewport under a model the server has
 * already read successfully. `unwrapForStorage` is what the extraction path
 * uses to make the derived source object STEP for every model, whatever the
 * upload was wrapped in. See `writeCompressedSource`.
 *
 * ## Why the central directory is read here rather than by a zip library
 *
 * The repository has no zip reader, `unwrapIfcZipWithLimit` (the parser's
 * limit-taking variant) is deliberately not part of its public exports, and
 * what is needed is one number per entry. The reader below is the smallest
 * thing that answers "how big is this when opened" — it never inflates
 * anything, and every failure to understand the bytes is a refusal rather than
 * a guess.
 */

import 'server-only'

/** Little-endian `PK\x03\x04`, the local file header every zip starts with. */
const LOCAL_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50

/** Extra-field header id carrying the 64-bit sizes when the 32-bit ones overflow. */
const ZIP64_EXTRA_FIELD_ID = 0x0001

/** A 32-bit size field set to this means "read the real one from the zip64 extra". */
const SIZE_OVERFLOW = 0xffffffff

/** The end-of-central-directory record is 22 bytes plus a comment of up to 64 KiB. */
const MAX_END_OF_CENTRAL_DIRECTORY_SCAN = 22 + 0xffff

/** Entries that hold a model, as opposed to a texture or a readme. */
const MODEL_ENTRY = /\.(ifc|ifcxml)$/i

/**
 * A refusal that names which of the archive's own properties caused it.
 *
 * `code` exists so the caller can map it onto the same two outcomes an ordinary
 * IFC has — the file is not a model we can read (`not-ifc`), or it is too big
 * to read here (`too-large`) — rather than inventing a third state for
 * something the user experiences as "my model would not open".
 */
export class IfcArchiveError extends Error {
  constructor(
    readonly code: 'not-ifc' | 'too-large',
    message: string
  ) {
    super(message)
    this.name = 'IfcArchiveError'
  }
}

/** One entry of the archive, as the central directory declares it. */
export interface IfcArchiveEntry {
  name: string
  /** Size once inflated, straight from the directory — nothing is decompressed. */
  uncompressedBytes: number
}

/** True when the buffer begins with the zip local-file-header signature. */
export function isZipArchive(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false
  return new DataView(buffer).getUint32(0, true) === LOCAL_HEADER_SIGNATURE
}

/** Offset of the end-of-central-directory record, or -1 when there is none. */
function findEndOfCentralDirectory(view: DataView): number {
  const from = Math.max(0, view.byteLength - MAX_END_OF_CENTRAL_DIRECTORY_SCAN)
  // Backwards: the record is at the very end unless the archive carries a
  // comment, and a forward scan could match the signature inside stored data.
  for (let offset = view.byteLength - 22; offset >= from; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset
  }
  return -1
}

/**
 * Where the central directory starts and how many entries it holds, following
 * the zip64 records when the 32-bit fields have overflowed.
 *
 * A model big enough to need zip64 is a model this pipeline will refuse anyway,
 * but reading the record is what makes that refusal say "300 MB, above the
 * 250 MB limit" instead of "the archive could not be read".
 */
function readDirectoryLocation(view: DataView): { offset: number; entries: number } | null {
  const eocd = findEndOfCentralDirectory(view)
  if (eocd < 0) return null

  let entries = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)

  if (entries === 0xffff || offset === SIZE_OVERFLOW) {
    const locator = eocd - 20
    if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) return null
    const record = Number(view.getBigUint64(locator + 8, true))
    if (
      !Number.isSafeInteger(record) ||
      record < 0 ||
      record + 56 > view.byteLength ||
      view.getUint32(record, true) !== ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE
    ) {
      return null
    }
    entries = Number(view.getBigUint64(record + 32, true))
    offset = Number(view.getBigUint64(record + 48, true))
  }

  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= view.byteLength) return null
  return { offset, entries }
}

/**
 * The 64-bit uncompressed size from an entry's zip64 extra field.
 *
 * It is the FIRST value in that field, and only present when the 32-bit size
 * said `0xFFFFFFFF` — the fields are packed in a fixed order and each one is
 * written only if its 32-bit counterpart overflowed.
 */
function readZip64UncompressedSize(view: DataView, extraStart: number, extraLength: number): number | null {
  let cursor = extraStart
  const end = extraStart + extraLength
  while (cursor + 4 <= end) {
    const id = view.getUint16(cursor, true)
    const size = view.getUint16(cursor + 2, true)
    if (cursor + 4 + size > end) return null
    if (id === ZIP64_EXTRA_FIELD_ID && size >= 8) {
      const value = Number(view.getBigUint64(cursor + 4, true))
      return Number.isSafeInteger(value) ? value : null
    }
    cursor += 4 + size
  }
  return null
}

/**
 * Every model entry the archive declares, with its opened size.
 *
 * @throws {IfcArchiveError} when the bytes cannot be read as a zip directory.
 *   Not a guess: an archive whose structure we cannot follow is one whose
 *   contents we cannot bound, and unwrapping it anyway is the behaviour this
 *   module exists to remove.
 */
export function readArchiveModelEntries(buffer: ArrayBuffer): IfcArchiveEntry[] {
  const view = new DataView(buffer)
  const location = readDirectoryLocation(view)
  if (!location) {
    throw new IfcArchiveError('not-ifc', 'The archive directory could not be read')
  }

  const entries: IfcArchiveEntry[] = []
  let cursor = location.offset
  for (let index = 0; index < location.entries; index += 1) {
    if (cursor + 46 > view.byteLength) {
      throw new IfcArchiveError('not-ifc', 'The archive directory could not be read')
    }
    if (view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new IfcArchiveError('not-ifc', 'The archive directory could not be read')
    }
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const nameStart = cursor + 46
    if (nameStart + nameLength + extraLength + commentLength > view.byteLength) {
      throw new IfcArchiveError('not-ifc', 'The archive directory could not be read')
    }

    const name = new TextDecoder('utf-8').decode(
      new Uint8Array(buffer, nameStart, nameLength)
    )
    let uncompressedBytes = view.getUint32(cursor + 24, true)
    if (uncompressedBytes === SIZE_OVERFLOW) {
      const wide = readZip64UncompressedSize(view, nameStart + nameLength, extraLength)
      if (wide === null) {
        throw new IfcArchiveError('not-ifc', 'The archive directory could not be read')
      }
      uncompressedBytes = wide
    }

    // Directory entries (`foo/`) and macOS resource forks are not models; the
    // regex already excludes them, and matching on the basename keeps a
    // `__MACOSX/._haus.ifc` sidecar from being counted as a second model.
    const basename = name.slice(name.lastIndexOf('/') + 1)
    if (MODEL_ENTRY.test(basename) && !basename.startsWith('._')) {
      entries.push({ name, uncompressedBytes })
    }
    cursor = nameStart + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * The model's own bytes, whether or not it arrived in a container.
 *
 * Non-zip input is returned unchanged, so callers do not branch on the
 * extension — `.ifc` files that are really archives (a common export slip) and
 * `.ifczip` files that are really plain STEP both do the right thing.
 *
 * @param maxBytes The extraction ceiling, applied to the OPENED size. Checked
 *   from the directory first (nothing allocated) and again on the result, so a
 *   directory that lies about a size cannot get past it either.
 * @throws {IfcArchiveError}
 */
export async function unwrapIfcArchive(
  buffer: ArrayBuffer,
  maxBytes: number
): Promise<{ bytes: ArrayBuffer; archived: boolean }> {
  if (!isZipArchive(buffer)) return { bytes: buffer, archived: false }

  const entries = readArchiveModelEntries(buffer)
  if (entries.length === 0) {
    throw new IfcArchiveError('not-ifc', 'The archive contains no IFC file')
  }
  if (entries.length > 1) {
    // The parser refuses this too, and for the same reason: silently picking
    // one of several models risks indexing a building nobody asked about.
    throw new IfcArchiveError(
      'not-ifc',
      `The archive contains ${entries.length} IFC files; it must contain exactly one`
    )
  }

  const [entry] = entries
  if (entry.uncompressedBytes > maxBytes) {
    throw new IfcArchiveError('too-large', tooLargeMessage(entry.uncompressedBytes, maxBytes))
  }

  const { unwrapIfcZip } = await import('@ifc-lite/parser')
  let bytes: ArrayBuffer
  try {
    bytes = await unwrapIfcZip(buffer)
  } catch (error) {
    throw new IfcArchiveError(
      'not-ifc',
      `The archive could not be opened: ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
  // The directory is metadata, and metadata can disagree with the stream. The
  // check that costs nothing has already run; this is the one that is true.
  if (bytes.byteLength > maxBytes) {
    throw new IfcArchiveError('too-large', tooLargeMessage(bytes.byteLength, maxBytes))
  }
  return { bytes, archived: true }
}

/**
 * Same shape as `IfcTooLargeError`'s sentence, about the size that actually
 * applies. English here, German at the surface: `runBimExtraction` owns the
 * wording the user reads, exactly as it does for `IfcExtractionError`.
 */
function tooLargeMessage(bytes: number, maxBytes: number): string {
  const mb = (value: number): number => Math.round(value / 1024 / 1024)
  return `Unpacked model is ${mb(bytes)} MB, above the ${mb(maxBytes)} MB extraction limit`
}
