import { describe, expect, it } from 'vitest'
import {
  buildPassageIndex,
  findPassage,
  locatePassage,
  MIN_WINDOW_SCORE,
  normalizePassage,
  passageBounds,
  type TextChunk,
} from './passage-highlight'

/**
 * Lay out a line of text as pdf.js would hand it over: one positioned run per
 * word, advancing left to right on a shared baseline. Six units per character
 * keeps the arithmetic in the assertions readable.
 */
const CHAR_WIDTH = 6
const LINE_HEIGHT = 12

const line = (text: string, y: number, startX = 0): TextChunk[] => {
  const chunks: TextChunk[] = []
  let x = startX
  for (const word of text.split(' ')) {
    chunks.push({ text: word, x, y, width: word.length * CHAR_WIDTH, height: LINE_HEIGHT })
    x += (word.length + 1) * CHAR_WIDTH
  }
  return chunks
}

const page = (...lines: string[]): TextChunk[] =>
  lines.flatMap((text, index) => line(text, index * LINE_HEIGHT * 1.5))

describe('normalizePassage', () => {
  it('folds ligatures and case into one comparable form', () => {
    expect(normalizePassage('Die Auﬂage ist deﬁniert')).toBe('die auflage ist definiert')
  })

  it('turns punctuation into word boundaries rather than characters to agree about', () => {
    expect(normalizePassage('Die „Auﬂage“, so § 3 Abs. 1, gilt.')).toBe(
      'die auflage so 3 abs 1 gilt',
    )
  })

  it('collapses runs of whitespace and trims the ends', () => {
    expect(normalizePassage('  der   Bescheid \n\t ist  ')).toBe('der bescheid ist')
  })

  it('rejoins a word the PDF broke across a line', () => {
    expect(normalizePassage('die Ver-\nwaltung')).toBe('die verwaltung')
    // Any of the typographic dashes wraps a word just as a plain hyphen does.
    expect(normalizePassage('die Ver‐\nwaltung')).toBe('die verwaltung')
  })

  it('treats a hyphen that is not a line break as a boundary', () => {
    expect(normalizePassage('Bau-Recht')).toBe('bau recht')
    expect(normalizePassage('Seiten 3 - 5')).toBe('seiten 3 5')
  })

  it('drops soft hyphens and zero-width characters without splitting the word', () => {
    expect(normalizePassage('Ver­waltung​sakt')).toBe('verwaltungsakt')
  })
})

describe('buildPassageIndex', () => {
  it('separates adjacent runs so words do not weld together', () => {
    const index = buildPassageIndex(line('der bescheid ist', 0))
    expect(index.haystack).toBe('der bescheid ist')
  })

  it('maps every surviving character back to the run it came from', () => {
    const index = buildPassageIndex(line('der bescheid', 0))
    const first = index.chars[0]!
    expect(first).toEqual({ ch: 'd', chunk: 0, offset: 0 })
    // The space between two runs belongs to neither.
    expect(index.chars[3]).toEqual({ ch: ' ', chunk: -1, offset: -1 })
    expect(index.chars[4]).toEqual({ ch: 'b', chunk: 1, offset: 0 })
  })
})

describe('findPassage — exact', () => {
  const chunks = page(
    'Der Bescheid ist dem Antragsteller zuzustellen',
    'Die Frist betraegt vier Wochen ab Zustellung',
  )

  it('scores an exact hit at 1 and covers only the matched words', () => {
    const match = findPassage(buildPassageIndex(chunks), 'Die Frist betraegt vier Wochen')
    expect(match).not.toBeNull()
    expect(match!.matcher).toBe('exact')
    const bounds = passageBounds(match!.rects)!
    expect(bounds.y).toBe(LINE_HEIGHT * 1.5)
    expect(bounds.x).toBe(0)
    // "Die Frist betraegt vier Wochen" is 30 characters of the 43-character line.
    expect(bounds.width).toBeCloseTo(30 * CHAR_WIDTH, 5)
  })

  it('matches across case, ligature, quote and punctuation differences', () => {
    const rendered = page('Die Auﬂage ist zu erfüllen')
    expect(locatePassage(rendered, 'DIE AUFLAGE IST ZU ERFÜLLEN')?.matcher).toBe('exact')
    expect(locatePassage(rendered, 'die "Auflage" ist zu erfüllen.')?.matcher).toBe('exact')
  })

  it('matches a snippet whose word the PDF hyphenated across the line break', () => {
    const chunks = [...line('die Ver-', 0), ...line('waltung entscheidet', LINE_HEIGHT * 1.5)]
    const match = locatePassage(chunks, 'die Verwaltung entscheidet')
    expect(match?.matcher).toBe('exact')
    // Both lines light up, one band each.
    expect(match!.rects).toHaveLength(2)
  })

  it('returns one merged band per line rather than one per run', () => {
    const match = locatePassage(page('Der Bescheid ist dem Antragsteller zuzustellen'), 'Bescheid ist dem')
    expect(match!.rects).toHaveLength(1)
    expect(match!.rects[0]!.width).toBeCloseTo(16 * CHAR_WIDTH, 5)
  })

  it('does not bridge a gap wide enough to be a second column', () => {
    const chunks = [
      { text: 'links', x: 0, y: 0, width: 30, height: LINE_HEIGHT },
      { text: 'rechts', x: 300, y: 0, width: 36, height: LINE_HEIGHT },
    ]
    const match = locatePassage(chunks, 'links rechts')
    expect(match!.rects).toHaveLength(2)
  })
})

describe('findPassage — anchored', () => {
  it('spans between the ends when the middle of the snippet drifted', () => {
    const chunks = page(
      'Der Antrag auf Erteilung einer Bewilligung ist schriftlich',
      'unter Anschluss der Unterlagen bei der Behoerde einzubringen',
    )
    // The snippet's middle says "sammt" where the page says "unter Anschluss der" —
    // no substring search finds this, both ends are intact.
    const match = locatePassage(
      chunks,
      'einer Bewilligung ist schriftlich sammt Unterlagen bei der Behoerde einzubringen',
    )
    expect(match).not.toBeNull()
    expect(match!.matcher).toBe('anchored')
    const bounds = passageBounds(match!.rects)!
    // Starts at "einer" on line one and runs to the end of line two.
    expect(bounds.y).toBe(0)
    expect(bounds.height).toBeGreaterThan(LINE_HEIGHT)
  })

  it('refuses an anchor phrase that occurs twice on the page', () => {
    const chunks = page(
      'die Behoerde entscheidet ueber den Antrag',
      'ein weiterer Absatz ohne jeden Bezug dazu',
      'die Behoerde entscheidet ueber den Einspruch',
    )
    // Both the opening anchor and the whole snippet are ambiguous, and the two
    // candidate windows tie — so nothing is pointed at.
    expect(locatePassage(chunks, 'die Behoerde entscheidet ueber den Bescheid')).toBeNull()
  })
})

describe('findPassage — windowed', () => {
  const chunks = page(
    'Vorbemerkungen zum Verfahren und seinen Beteiligten',
    'Der Sachverstaendige erstattet Befund und Gutachten ueber',
    'die Standsicherheit des bestehenden Dachstuhls',
  )

  it('finds the passage when both ends inflect differently', () => {
    // Every anchor the second matcher would try differs from the page by an
    // ending: sachverstaendige/-r, erstattet/-e, bestehenden/bestehende,
    // Dachstuhls/Dachstuhles. Only stem-level overlap recovers this.
    const match = locatePassage(
      chunks,
      'Sachverstaendiger erstattete Befund und Gutachten ueber die Standsicherheit des bestehende Dachstuhles',
    )
    expect(match).not.toBeNull()
    expect(match!.matcher).toBe('windowed')
    expect(match!.score).toBeGreaterThanOrEqual(MIN_WINDOW_SCORE)
    // It lands on the clause, not on the heading line above it.
    expect(passageBounds(match!.rects)!.y).toBe(LINE_HEIGHT * 1.5)
  })

  it('returns null rather than pointing at an unrelated paragraph', () => {
    expect(
      locatePassage(chunks, 'Die Brandschutzabnahme wurde am fuenfzehnten Maerz durchgefuehrt'),
    ).toBeNull()
  })

  it('withdraws rather than choose between two passages that score alike', () => {
    const twice = page(
      'Der Bauwerber hat die Fertigstellung der Behoerde anzuzeigen',
      'ein dazwischenliegender Absatz voellig anderen Inhalts',
      'Der Nachbar hat die Fertigstellung der Behoerde anzuzeigen',
    )
    expect(
      locatePassage(twice, 'Der Eigentuemer hat die Fertigstellung der Behoerde anzuzeigen'),
    ).toBeNull()
  })
})

describe('findPassage — guards', () => {
  it('ignores a snippet too short to identify anything', () => {
    expect(locatePassage(page('Der Bescheid ist zuzustellen'), 'der')).toBeNull()
  })

  it('handles a page with no text layer', () => {
    expect(locatePassage([], 'Der Bescheid ist zuzustellen')).toBeNull()
  })

  it('skips runs with no measurable width', () => {
    const chunks: TextChunk[] = [
      { text: 'unsichtbar', x: 0, y: 0, width: 0, height: LINE_HEIGHT },
      ...line('Der Bescheid ist zuzustellen', LINE_HEIGHT * 1.5),
    ]
    const match = locatePassage(chunks, 'Der Bescheid ist zuzustellen')
    expect(match!.rects.every((rect) => rect.width > 0)).toBe(true)
  })
})

describe('passageBounds', () => {
  it('unions the rectangles a multi-line match produced', () => {
    expect(
      passageBounds([
        { x: 30, y: 0, width: 60, height: 12 },
        { x: 0, y: 18, width: 40, height: 12 },
      ]),
    ).toEqual({ x: 0, y: 0, width: 90, height: 30 })
  })

  it('has nothing to bound when there was no match', () => {
    expect(passageBounds([])).toBeNull()
  })
})
