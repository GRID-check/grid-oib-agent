/**
 * A delimited-text (CSV/TSV) reader, for showing a table to a person.
 *
 * Deliberately not a CSV library. A parser you would put behind an import runs
 * over data you then compute with: it needs streaming, type coercion, an error
 * channel, a dialect option for every producer that ever shipped. This one feeds
 * a viewer — the rows are bounded before they arrive, nothing downstream does
 * arithmetic on a cell, and a file it reads wrongly is a file the reader can see
 * is wrong. That difference is what keeps it here instead of in `package.json`.
 *
 * It follows RFC 4180 for the part that matters in practice: quoted fields may
 * contain the delimiter, a newline, or a doubled quote. Everything else — BOM,
 * CRLF, a trailing newline, a ragged row — it absorbs, because a real export
 * from a real spreadsheet carries all four and a viewer that refuses one of them
 * shows a grey box where the file was.
 */

/** Delimiters this reader sniffs for, in the order it prefers them. */
const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const

/**
 * The delimiter a file most likely uses, by the one that divides its first lines
 * most evenly.
 *
 * A semicolon export from a German Excel is the common case this exists for: a
 * comma-only reader renders it as one column of full rows, which looks less like
 * a parse failure than a file with one column. Counting outside quotes matters —
 * a prose column full of commas otherwise wins every vote.
 */
export function sniffDelimiter(sample: string): string {
  const lines = sample.split('\n').slice(0, 20).filter((line) => line.trim() !== '')
  if (lines.length === 0) return ','

  let best = ','
  let bestScore = -1
  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter))
    const total = counts.reduce((sum, n) => sum + n, 0)
    if (total === 0) continue
    // Consistency first, volume second: the delimiter that yields the same
    // number of splits on every line is the structural one, and a tie on
    // consistency goes to the one that splits more.
    const mean = total / counts.length
    const variance = counts.reduce((sum, n) => sum + (n - mean) ** 2, 0) / counts.length
    const score = mean / (1 + variance)
    if (score > bestScore) {
      bestScore = score
      best = delimiter
    }
  }
  return best
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') i += 1
      else inQuotes = !inQuotes
    } else if (char === delimiter && !inQuotes) {
      count += 1
    }
  }
  return count
}

/**
 * Rows of cells, with the delimiter sniffed when one is not given.
 *
 * `maxRows` bounds the result because the caller renders every row it gets back
 * and a browser laying out a hundred thousand `<td>`s is a frozen tab, not a
 * preview. A file longer than the cap comes back cut, which the caller says out
 * loud — see `getDocumentTextPreview` for the same argument about bytes.
 */
export function parseDelimited(
  input: string,
  { delimiter, maxRows = 500 }: { delimiter?: string; maxRows?: number } = {}
): { rows: string[][]; delimiter: string; truncated: boolean } {
  // A BOM survives every round trip through Excel and renders as a stray glyph
  // welded to the first header cell.
  const text = input.replace(/^﻿/, '')
  const sep = delimiter ?? sniffDelimiter(text)

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let truncated = false

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    // A trailing newline is not a row of one empty cell.
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
  }

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"' && field === '') {
      inQuotes = true
    } else if (char === sep) {
      endField()
    } else if (char === '\n') {
      endRow()
      if (rows.length >= maxRows) {
        truncated = true
        break
      }
    } else if (char !== '\r') {
      field += char
    }
  }

  // Whatever the last line left behind, unless the loop stopped at the cap.
  if (!truncated && (field !== '' || row.length > 0)) endRow()

  return { rows, delimiter: sep, truncated }
}
