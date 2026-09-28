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
  [
    'success',
    ['erfüllt', 'erfuellt', 'vorhanden', 'zulässig', 'erledigt', 'trifft zu', 'aktuell', 'met', 'present', 'compliant', 'done', 'applies', 'current'],
  ],
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
  ['warning', ['teilweise', 'offen', 'zu prüfen', 'prüfen', 'unklar', 'partial', 'open', 'unclear', 'to check']],
  ['info', ['bedingt', 'conditional']],
  [
    'muted',
    [
      'erforderlich',
      'nicht anwendbar',
      'trifft nicht zu',
      'ausstehend',
      'required',
      'not applicable',
      'n/a',
      'does not apply',
      'pending',
    ],
  ],
]

const BY_WORD: ReadonlyMap<string, StatusTone> = new Map(
  TONES.flatMap(([tone, words]) => words.map((word) => [word, tone] as const))
)

/** The tone for a cell whose whole text is a status word, else null. */
export function statusTone(cellText: string): StatusTone | null {
  return BY_WORD.get(normal(cellText)) ?? null
}

/**
 * The words that mark a row as the one that holds for this project: the case
 * that applies, the step the project is at. Such a row is tinted
 * (`table-shape.ts`), which is what `condition_tree`'s active branch and
 * `process_map`'s current step were.
 */
const ACTIVE_WORDS: ReadonlySet<string> = new Set(['trifft zu', 'aktuell', 'applies', 'current'])

/**
 * The words that leave a row undecided: the reader can ask about it
 * („Dazu fragen", `requirement_checklist`'s chip on an open row).
 */
const OPEN_WORDS: ReadonlySet<string> = new Set([
  'offen',
  'zu prüfen',
  'prüfen',
  'unklar',
  'fehlt',
  'open',
  'unclear',
  'to check',
  'missing',
])

const normal = (cellText: string) => cellText.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de')

/** Whether a cell's whole text marks its row as the one that applies. */
export const isActiveStatus = (cellText: string): boolean => ACTIVE_WORDS.has(normal(cellText))

/** Whether a cell's whole text leaves its row undecided. */
export const isOpenStatus = (cellText: string): boolean => OPEN_WORDS.has(normal(cellText))

const TONE_NAMES: ReadonlySet<string> = new Set(TONES.map(([tone]) => tone))

/** A tone read back off a hast property, which arrives as `unknown`. */
export function isStatusTone(value: unknown): value is StatusTone {
  return typeof value === 'string' && TONE_NAMES.has(value)
}
