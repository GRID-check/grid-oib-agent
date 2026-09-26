/**
 * Status words a table cell may hold, and the mark each renders as.
 *
 * The answer writes a check as a Markdown table with a Status column
 * (`piloti_static.md`, <formatting> STRUCTURE) instead of a checklist card:
 * the same rows, no second channel. A cell of a Status column
 * (`table-shape.ts`) whose WHOLE text is one of these words renders as a
 * coloured mark. Anything else stays text: „offen" in a Bemerkung column is a
 * word, and so is a sentence that merely contains it. The word itself is always
 * shown — colour never travels alone.
 */

export type StatusTone = 'success' | 'destructive' | 'warning' | 'info' | 'muted'

const TONES: ReadonlyArray<readonly [StatusTone, readonly string[]]> = [
  ['success', ['erfüllt', 'erfuellt', 'vorhanden', 'zulässig', 'met', 'present', 'compliant']],
  [
    'destructive',
    [
      'nicht erfüllt',
      'nicht erfuellt',
      'fehlt',
      'unzulässig',
      'not met',
      'missing',
      'non-compliant',
    ],
  ],
  ['warning', ['teilweise', 'offen', 'zu prüfen', 'unklar', 'partial', 'open', 'unclear']],
  ['info', ['bedingt', 'conditional']],
  ['muted', ['erforderlich', 'nicht anwendbar', 'required', 'not applicable', 'n/a']],
]

const BY_WORD: ReadonlyMap<string, StatusTone> = new Map(
  TONES.flatMap(([tone, words]) => words.map((word) => [word, tone] as const))
)

/** The tone for a cell whose whole text is a status word, else null. */
export function statusTone(cellText: string): StatusTone | null {
  const word = cellText.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de')
  return BY_WORD.get(word) ?? null
}

const TONE_NAMES: ReadonlySet<string> = new Set(TONES.map(([tone]) => tone))

/** A tone read back off a hast property, which arrives as `unknown`. */
export function isStatusTone(value: unknown): value is StatusTone {
  return typeof value === 'string' && TONE_NAMES.has(value)
}
