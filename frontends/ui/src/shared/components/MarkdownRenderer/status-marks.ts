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

/**
 * What a status word says about its row beyond its tone: that the row HOLDS
 * for this project (the case that applies, the step the project is at, which
 * is what `condition_tree`'s active branch and `process_map`'s current step
 * were), or that the row is still OPEN and the reader can ask about it
 * („Dazu fragen", `requirement_checklist`'s chip on an open row).
 */
type StatusRole = 'holds' | 'open'

/**
 * The status vocabulary, in one list: every word the renderer recognises in a
 * cell, its tone and its role. These are DATA, not names: the model writes the
 * German word in the answer's own language, and each German word has its
 * English equivalent beside it for an answer written in English.
 */
const STATUS_WORDS: ReadonlyArray<readonly [word: string, tone: StatusTone, role?: StatusRole]> = [
  ['erfüllt', 'success'],
  ['erfuellt', 'success'],
  ['met', 'success'],
  ['compliant', 'success'],
  ['vorhanden', 'success'],
  ['present', 'success'],
  ['zulässig', 'success'],
  ['permitted', 'success'],
  ['erledigt', 'success'],
  ['done', 'success'],
  ['trifft zu', 'success', 'holds'],
  ['applies', 'success', 'holds'],
  ['aktuell', 'success', 'holds'],
  ['current', 'success', 'holds'],
  ['nicht erfüllt', 'destructive'],
  ['nicht erfuellt', 'destructive'],
  ['not met', 'destructive'],
  ['non-compliant', 'destructive'],
  ['unzulässig', 'destructive'],
  ['not permitted', 'destructive'],
  ['fehlt', 'destructive', 'open'],
  ['missing', 'destructive', 'open'],
  ['teilweise', 'warning'],
  ['partial', 'warning'],
  ['offen', 'warning', 'open'],
  ['open', 'warning', 'open'],
  ['zu prüfen', 'warning', 'open'],
  ['prüfen', 'warning', 'open'],
  ['to check', 'warning', 'open'],
  ['unklar', 'warning', 'open'],
  ['unclear', 'warning', 'open'],
  ['bedingt', 'info'],
  ['conditional', 'info'],
  ['erforderlich', 'muted'],
  ['required', 'muted'],
  ['nicht anwendbar', 'muted'],
  ['not applicable', 'muted'],
  ['n/a', 'muted'],
  ['trifft nicht zu', 'muted'],
  ['does not apply', 'muted'],
  ['ausstehend', 'muted'],
  ['pending', 'muted'],
]

const normal = (cellText: string) => cellText.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de')

const BY_WORD: ReadonlyMap<string, { tone: StatusTone; role?: StatusRole }> = new Map(
  STATUS_WORDS.map(([word, tone, role]) => [word, { tone, role }] as const)
)

/** The tone for a cell whose whole text is a status word, else null. */
export function statusTone(cellText: string): StatusTone | null {
  return BY_WORD.get(normal(cellText))?.tone ?? null
}

/** Whether a cell's whole text marks its row as the one that holds for this project. */
export const isActiveStatus = (cellText: string): boolean => BY_WORD.get(normal(cellText))?.role === 'holds'

/** Whether a cell's whole text leaves its row undecided. */
export const isOpenStatus = (cellText: string): boolean => BY_WORD.get(normal(cellText))?.role === 'open'

const TONE_NAMES: ReadonlySet<string> = new Set(STATUS_WORDS.map(([, tone]) => tone))

/** A tone read back off a hast property, which arrives as `unknown`. */
export function isStatusTone(value: unknown): value is StatusTone {
  return typeof value === 'string' && TONE_NAMES.has(value)
}
