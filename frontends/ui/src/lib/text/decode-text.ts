/**
 * Decode the bytes of a text file whose encoding nobody declared.
 *
 * The same order the knowledge layer reads them in
 * (`sources/knowledge_layer/src/llamaindex/text_formats.py`, `decode_text`), so
 * the preview shows the text the index was built from: a byte-order mark
 * decides; else strict UTF-8; else Windows-1252. A Windows-authored `.csv` or
 * `.txt` is cp1252 more often than not, and reading it as UTF-8 with
 * replacement glyphs turned every „ä", „ß" and „€" into a „�".
 *
 * The WHATWG `windows-1252` decoder maps every byte (the five holes cp1252
 * leaves become C1 controls, as Latin-1 would read them), so it is also the
 * floor the backend reaches through Latin-1: no input is refused or shortened.
 *
 * UTF-32 is left out on purpose: `TextDecoder` has no decoder for it, and a
 * UTF-32 text file in a planning office is a curiosity rather than a case.
 */

export type DecodedTextEncoding = 'utf-8-sig' | 'utf-16le' | 'utf-16be' | 'utf-8' | 'windows-1252'

export interface DecodedText {
  text: string
  encoding: DecodedTextEncoding
}

const BOMS: ReadonlyArray<{ bytes: readonly number[]; encoding: 'utf-8-sig' | 'utf-16le' | 'utf-16be' }> = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8-sig' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
]

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.length <= bytes.length && prefix.every((byte, index) => bytes[index] === byte)
}

function strictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * How many trailing bytes form a UTF-8 sequence the cut left incomplete
 * (0 when the text ends on a character boundary).
 */
function incompleteUtf8Tail(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back]
    if ((byte & 0xc0) === 0x80) continue // continuation byte: keep looking for the lead
    if (byte < 0x80) return 0 // ASCII: the text ends on a boundary
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2
    return length > back ? back : 0
  }
  return 0
}

/**
 * `truncated` says the bytes are a prefix of the file (a ranged read). A cut
 * lands mid-character as often as not, and strict UTF-8 would then reject a
 * file that is UTF-8 throughout; the incomplete tail is dropped before the
 * strict test rather than letting it demote the whole text to cp1252.
 */
export function decodeTextBytes(bytes: Uint8Array, { truncated = false }: { truncated?: boolean } = {}): DecodedText {
  for (const bom of BOMS) {
    if (!startsWith(bytes, bom.bytes)) continue
    const label = bom.encoding === 'utf-8-sig' ? 'utf-8' : bom.encoding
    // The decoder strips the BOM itself (`ignoreBOM` defaults to false).
    return { text: new TextDecoder(label).decode(bytes), encoding: bom.encoding }
  }
  const body = truncated ? bytes.subarray(0, bytes.length - incompleteUtf8Tail(bytes)) : bytes
  const utf8 = strictUtf8(body)
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8' }
  return { text: decodeWindows1252(bytes), encoding: 'windows-1252' }
}

/**
 * What cp1252 puts at 0x80–0x9F, from the WHATWG `windows-1252` index. The five
 * holes (0x81, 0x8D, 0x8F, 0x90, 0x9D) stay the C1 control of the same number.
 */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d,
  0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d,
  0x17e, 0x178,
]

/**
 * `TextDecoder('windows-1252')`, with 0x80–0x9F mapped as the standard says.
 *
 * Node 22.22.0's decoder reads that range as Latin-1 (0x80 comes back as U+0080,
 * not „€"), and the `node:22-slim` image the BFF runs on floats onto it. A
 * conforming decoder never emits U+0080–U+009F except for the five holes, which
 * map to themselves here, so the remap is a no-op wherever the runtime is right.
 */
function decodeWindows1252(bytes: Uint8Array): string {
  return new TextDecoder('windows-1252')
    .decode(bytes)
    .replace(/[\u0080-\u009f]/g, (c) => String.fromCharCode(CP1252_HIGH[c.charCodeAt(0) - 0x80]!))
}
