/**
 * Text the built-in PDF faces can actually draw.
 *
 * ## The failure this prevents
 *
 * pdfkit's built-in faces (Helvetica, Courier — see the font note in
 * `blocks-to-pdf.tsx`) are encoded WinAnsi. A character outside that encoding is
 * not dropped and does not raise: it is written as a byte pair the viewer reads
 * as two unrelated letters. `≤ 40 m` prints as `d 40 m`, and `≥ 27 cm` as
 * `e 27 cm`.
 *
 * That is the worst class of bug this exporter can have. The document does not
 * look broken — it looks fine, and it states a different requirement than the
 * answer did. In a Befund that is read by somebody who cannot check it against
 * the app, a comparator that silently turned into a letter is a wrong figure
 * with no visible warning attached.
 *
 * ## Why substitution and not a font
 *
 * The real fix is a Unicode face, registered with `Font.register`. There is no
 * font file anywhere in this repository, and fetching one at render time is out
 * (an export must not depend on the network). So the characters that matter in
 * this domain — the comparators, the arrows, the Bauphysik Greek — are spelled
 * out in a form WinAnsi carries, and the rest is decomposed.
 *
 * `<=` for `≤` is a legible, unambiguous downgrade. It is not as good as the
 * symbol, and it is the honest version of it.
 *
 * When a real font file lands in the repo, this module does not disappear: the
 * cover, the chrome and the body would all have to be on that face before it
 * could, and until then a single unmapped character is still a wrong glyph.
 */

/**
 * The characters WinAnsi has in 0x80–0x9F, where Latin-1 has controls.
 *
 * Worth naming because they are exactly the ones a model's prose is full of —
 * curly quotes, the en dash, the ellipsis, the bullet — and treating them as
 * unprintable would rewrite ordinary German typography into ASCII for nothing.
 */
const WIN_ANSI_HIGH = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ')

/** Whether a single character survives the encoding untouched. */
const isPrintable = (character: string): boolean => {
  const code = character.codePointAt(0)
  if (code === undefined) return false
  // Tab and newline are layout, not glyphs; react-pdf breaks lines on them.
  if (code === 0x09 || code === 0x0a) return true
  if (code >= 0x20 && code <= 0x7e) return true
  if (code >= 0xa0 && code <= 0xff) return true
  return WIN_ANSI_HIGH.has(character)
}

/**
 * The substitutions worth writing by hand.
 *
 * Everything here is a character that occurs in Austrian building-code work and
 * whose decomposition would be wrong or empty: a comparator (`≤`), a direction
 * (`→`), a Bauphysik quantity (`λ`, `ρ`), or a space that is not a space.
 * Anything else falls through to {@link decompose}.
 */
const SUBSTITUTIONS: Record<string, string> = {
  // Comparators — the ones that make a wrong document rather than an ugly one.
  '≤': '<=',
  '≥': '>=',
  '≠': '!=',
  '≈': '~',
  '≙': '=',
  '≡': '=',
  '−': '-',
  '⁄': '/',
  '∕': '/',
  // Arrows. A model writes these in comparisons and in change descriptions.
  '→': '->',
  '←': '<-',
  '↔': '<->',
  '⇒': '=>',
  '⇐': '<=',
  '↑': '^',
  '↓': 'v',
  // Diameter, the way a plan writes it. `Ø` IS in WinAnsi; the symbol is not.
  '⌀': 'Ø',
  '∅': 'Ø',
  // Bauphysik. λ is thermal conductivity, ρ density, Δ a difference — all of
  // which appear in a thermal-envelope or acoustic card as bare letters.
  'Δ': 'Delta',
  '∆': 'Delta',
  'δ': 'delta',
  'λ': 'lambda',
  'ρ': 'rho',
  'σ': 'sigma',
  'α': 'alpha',
  'β': 'beta',
  'γ': 'gamma',
  'ε': 'epsilon',
  'η': 'eta',
  'θ': 'theta',
  'π': 'pi',
  'φ': 'phi',
  'ψ': 'psi',
  'ω': 'omega',
  'Σ': 'Sigma',
  'Ω': 'Ohm',
  // U+03BC, the Greek letter, as opposed to U+00B5 MICRO SIGN, which WinAnsi has.
  'μ': 'µ',
  '∞': 'inf',
  '√': 'sqrt',
  '∑': 'Sigma',
  // Verdict marks, as they arrive in a model-written table.
  '✓': '+',
  '✔': '+',
  '✗': 'x',
  '✘': 'x',
  '☑': '[x]',
  '☐': '[ ]',
  // Spaces that are not the space: thin, hair, narrow no-break, figure.
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  // Zero-width joiners and marks, which have no width to lose.
  '​': '',
  '‌': '',
  '‍': '',
  '﻿': '',
  // Non-breaking and figure hyphens.
  '‑': '-',
  '‒': '-',
  '―': '-',
}

/**
 * The last resort: decompose, then keep what survives.
 *
 * NFKD is what turns `㎡` into `m2` and `⁴` into `4` — compatibility forms that
 * are genuinely the same information in a plainer spelling. A character with no
 * usable decomposition becomes `?`, which is deliberate: a visible gap is a
 * thing the reader can ask about, and a silently wrong letter is not.
 */
const decompose = (character: string): string => {
  const stripped = character
    .normalize('NFKD')
    // The combining marks a decomposition leaves behind; the base letter is
    // already in WinAnsi, and a floating acute is not.
    .replace(/[̀-ͯ]/g, '')
  const kept = Array.from(stripped).filter(isPrintable).join('')
  return kept || '?'
}

/** Cheap check, so a document of ordinary German prose is not rewritten at all. */
// eslint-disable-next-line no-control-regex
const ALL_PRINTABLE = /^[\t\n -~ -ÿ€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]*$/

/**
 * One string, in characters the document's faces can draw.
 *
 * Applied at every point a string becomes a `Text` — headings, runs, table
 * headers, the cover title — rather than once over the block list, so a caller
 * that renders blocks itself cannot bypass it.
 */
export function printable(text: string): string {
  if (ALL_PRINTABLE.test(text)) return text
  return Array.from(text)
    .map((character) =>
      isPrintable(character) ? character : (SUBSTITUTIONS[character] ?? decompose(character))
    )
    .join('')
}
