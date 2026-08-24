/**
 * The bytes the geometry kernel is allowed to see.
 *
 * `@ifc-lite/geometry` parses STEP. It does not unwrap zip — only the parser
 * does — and it does not complain when it is handed something else: the entity
 * scan finds nothing, `processAdaptive` yields no batches, and the viewport
 * finishes "successfully" on an empty scene. A `.ifczip` therefore rendered as
 * nothing at all, under a model the server had already read, indexed and
 * listed as ready.
 *
 * Extraction now writes the UNWRAPPED model to the viewer's source object
 * (`lib/bim/ifc-archive.ts`), so the ordinary path never reaches the branch
 * below. It stays because two cases still can:
 *
 *   - models extracted before that change, whose `_bim/source.ifc.gz` holds
 *     the archive;
 *   - the fallback in `getModelSource`, which serves the ORIGINAL object when
 *     the derived one is missing — and for a `.ifczip` upload the original is
 *     the container.
 *
 * Neither is worth a migration, and neither should cost the ordinary model
 * anything: non-zip input is decided by four bytes and returned unchanged, and
 * the parser (with its zip dependency) is only imported when an archive is
 * actually in hand.
 */

/** Little-endian `PK\x03\x04` — the signature every zip begins with. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

/** Whether these bytes are a zip container rather than a model. */
export function looksLikeArchive(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && ZIP_MAGIC.every((byte, index) => bytes[index] === byte)
}

/**
 * The model inside the container, or the input unchanged when there is none.
 *
 * Failing to open an archive returns the input rather than throwing: the
 * kernel's own "no geometry" outcome is no worse than an error here, and a
 * viewer that refuses to try is strictly worse than one that tries and shows
 * what it can.
 */
export async function unwrapModelSource(bytes: Uint8Array): Promise<Uint8Array> {
  if (!looksLikeArchive(bytes)) return bytes
  try {
    const { unwrapIfcZip } = await import('@ifc-lite/parser')
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer
    return new Uint8Array(await unwrapIfcZip(buffer))
  } catch {
    return bytes
  }
}
