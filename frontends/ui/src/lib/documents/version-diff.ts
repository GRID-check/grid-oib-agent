/**
 * A line diff between two versions of a document's text.
 *
 * ## Why a dependency
 *
 * "Buy, don't build": a diff is somebody else's domain — Myers' algorithm, the
 * postprocessing that decides whether a moved paragraph is a move or a
 * delete-plus-insert, and the edge cases around trailing newlines are all
 * solved, and solved better than a weekend of ours would. `diff` (jsdiff) is
 * pure JavaScript, has no native toolchain, no transitive dependencies, and is
 * BSD-3. It went into `package.json` in the same change that first needed it,
 * which is what the version pane's own header comment asked for: "Adding the
 * dependency is a decision with its own PR … the library exists, we simply have
 * not adopted one."
 *
 * ## Why a module rather than a call inside the component
 *
 * Everything below is a pure function of two strings. Keeping it out of the
 * component means the alignment, the line numbering and the context folding are
 * testable without rendering anything, and the component is left with one job:
 * showing rows. It is also where the two decisions a diff has to take live, so
 * they are taken once:
 *
 *   **Line endings are normalized first.** A version written on Windows and a
 *   version written by Piloti differ on EVERY line otherwise, and the reader is
 *   shown a rewrite where nothing changed. This is the same class of bug as the
 *   NFC normalization in `name-match.ts`: two strings that render identically
 *   and are different bytes.
 *
 *   **Unchanged runs are folded.** A twelve-page Aktenvermerk with one corrected
 *   Gebäudeklasse is a diff nobody scrolls. Three lines of context on each side
 *   of a change, and a counted gap for the rest.
 */

import { diffLines } from 'diff'

/** Unchanged lines kept on each side of a change, so a change has a place. */
export const DIFF_CONTEXT_LINES = 3

/**
 * Hard ceiling on rendered rows. A diff of two 5 000-line files is not a thing
 * a person reads; it is a thing that freezes a panel. The cap is stated in the
 * result rather than applied silently.
 */
export const DIFF_MAX_ROWS = 2000

export type DiffRowKind = 'context' | 'added' | 'removed'

export interface DiffTextRow {
  kind: DiffRowKind
  text: string
  /** 1-based line number in the older version; null for an added line. */
  fromLine: number | null
  /** 1-based line number in the newer version; null for a removed line. */
  toLine: number | null
}

/** A counted run of unchanged lines that was folded away. */
export interface DiffGapRow {
  kind: 'gap'
  skipped: number
}

export type DiffRow = DiffTextRow | DiffGapRow

export interface VersionDiff {
  rows: DiffRow[]
  /** Lines only in the newer version. */
  added: number
  /** Lines only in the older version. */
  removed: number
  /** True when the two texts are byte-identical after newline normalization. */
  identical: boolean
  /** True when `DIFF_MAX_ROWS` cut the row list short. */
  truncated: boolean
}

/**
 * `\r\n` and a lone `\r` both become `\n`.
 *
 * Not cosmetic: without it a file that merely travelled through Windows diffs
 * as a total rewrite, which is the most misleading answer this panel can give.
 */
const normalizeNewlines = (text: string): string => text.replace(/\r\n?/g, '\n')

/**
 * Split a jsdiff chunk into lines WITHOUT inventing a trailing empty one.
 *
 * jsdiff hands back chunks that keep their newlines, so `'a\nb\n'.split('\n')`
 * ends in `''` — an empty row per chunk, which reads as a blank line that is
 * not in either document.
 */
function chunkLines(value: string): string[] {
  const lines = value.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Every line of both versions, aligned and numbered, before folding. */
function alignRows(from: string, to: string): { rows: DiffTextRow[]; added: number; removed: number } {
  const rows: DiffTextRow[] = []
  let fromLine = 0
  let toLine = 0
  let added = 0
  let removed = 0

  for (const change of diffLines(from, to)) {
    for (const text of chunkLines(change.value)) {
      if (change.added) {
        toLine += 1
        added += 1
        rows.push({ kind: 'added', text, fromLine: null, toLine })
        continue
      }
      if (change.removed) {
        fromLine += 1
        removed += 1
        rows.push({ kind: 'removed', text, fromLine, toLine: null })
        continue
      }
      fromLine += 1
      toLine += 1
      rows.push({ kind: 'context', text, fromLine, toLine })
    }
  }

  return { rows, added, removed }
}

/** Which aligned rows survive folding: every change, plus its context. */
function keptIndexes(rows: readonly DiffTextRow[]): Set<number> {
  const kept = new Set<number>()
  rows.forEach((row, index) => {
    if (row.kind === 'context') return
    const first = Math.max(0, index - DIFF_CONTEXT_LINES)
    const last = Math.min(rows.length - 1, index + DIFF_CONTEXT_LINES)
    for (let i = first; i <= last; i++) kept.add(i)
  })
  return kept
}

/** Replace each dropped run of context with one counted gap row. */
function fold(rows: readonly DiffTextRow[]): DiffRow[] {
  const kept = keptIndexes(rows)
  const folded: DiffRow[] = []
  let skipped = 0

  const flush = (): void => {
    if (skipped === 0) return
    folded.push({ kind: 'gap', skipped })
    skipped = 0
  }

  rows.forEach((row, index) => {
    if (!kept.has(index)) {
      skipped += 1
      return
    }
    flush()
    folded.push(row)
  })
  flush()
  return folded
}

/**
 * Diff two versions' text, line by line.
 *
 * Returns folded rows ready to render, the two counts the header states, and
 * the two facts a caller has to say out loud rather than imply: whether the
 * versions are identical, and whether the list was cut.
 */
export function diffVersionText(from: string, to: string): VersionDiff {
  const left = normalizeNewlines(from)
  const right = normalizeNewlines(to)
  if (left === right) {
    return { rows: [], added: 0, removed: 0, identical: true, truncated: false }
  }

  const aligned = alignRows(left, right)
  const folded = fold(aligned.rows)
  const truncated = folded.length > DIFF_MAX_ROWS
  return {
    rows: truncated ? folded.slice(0, DIFF_MAX_ROWS) : folded,
    added: aligned.added,
    removed: aligned.removed,
    identical: false,
    truncated,
  }
}
