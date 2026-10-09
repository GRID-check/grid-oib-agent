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
 * Windows-1252 maps every byte (the five holes cp1252 leaves become C1
 * controls, as Latin-1 would read them), so no input is refused or shortened.
 * It is decoded by `decodeWindows1252` below, not by `TextDecoder`; why is
 * written there.
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
 * WHATWG windows-1252 for bytes 0x80-0x9F, the only range where it differs
 * from Latin-1. Written out because the platform decoder cannot be trusted
 * with it: on Node 22.22.0 (ICU 77.1, what the floating `node:22-slim` image
 * shipped), `new TextDecoder('windows-1252')` returns the C1 controls
 * U+0080-U+009F for these bytes, so a German Excel export lost its € „ “ – to
 * invisible control characters. The five bytes cp1252 leaves undefined (0x81,
 * 0x8D, 0x8F, 0x90, 0x9D) map to the same-numbered C1 control, as WHATWG says.
 * The table is right whether or not a later Node fixes its decoder.
 *
 * Python's `cp1252` codec, which `decode_text` tries, has the same 27
 * characters. It refuses the five holes, though, and the backend then reads the
 * whole file as Latin-1; only for a file holding one of those bytes do the
 * index and the preview disagree on the rest of this range.
 */
// prettier-ignore
const CP1252_80_9F = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
] as const

function decodeWindows1252(bytes: Uint8Array): string {
  const codes = Array.from(bytes, (byte) => (byte >= 0x80 && byte <= 0x9f ? CP1252_80_9F[byte - 0x80] : byte))
  let text = ''
  // Chunked: spreading a whole 256 KiB preview into one call overflows the stack.
  for (let start = 0; start < codes.length; start += 0x2000) {
    text += String.fromCharCode(...codes.slice(start, start + 0x2000))
  }
  return text
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
