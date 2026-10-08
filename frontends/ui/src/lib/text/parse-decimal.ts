/**
 * Read a number an operator typed into a form field, strictly.
 *
 * The platform editors (price list, organization allowance, storage quota) each
 * had their own parse, and each was lenient in a way that cost money:
 * `parseFloat('2.5x')` is 2.5, `parseFloat('ten')` is NaN and the caller turned
 * NaN into `null`, and `null` is how those APIs spell UNLIMITED. A typo became
 * "no limit" and the UI reported success. A `type="number"` input is no
 * better: it reports an unparseable entry as `''`, which reads as blank.
 *
 * So there is one parse, and it answers three ways: the field is blank, it holds
 * a number, or it holds something that is not one. What blank MEANS is the
 * caller's decision (a required rate, or "unlimited"), and the caller has to
 * say so, because the answer is never silently folded into a number.
 *
 * Both separators are accepted as the decimal mark, so "2,5" and "2.5" are the
 * same number in either locale. Exponents, hex, `Infinity` and digit grouping
 * are not numbers here.
 *
 * One shape is refused as ambiguous rather than guessed: a single LOCALE GROUP
 * separator followed by exactly three digits. In German "100.000" means one
 * hundred thousand; read as a decimal it is one hundred, a thousandfold slip on
 * an allowance. The rule keys on the locale's group separator, so a value
 * rendered back with the locale's decimal mark ("1,125" in German) is never
 * refused, and "2.5" typed into a German form still reads as two and a half.
 */

export type DecimalInput =
  | { status: 'blank' }
  | { status: 'valid'; value: number }
  | { status: 'invalid'; reason: 'notANumber' | 'ambiguous' }

const DECIMAL = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/

/**
 * One group separator followed by exactly three digits, per separator a locale
 * can use here. Literal patterns rather than one built from the separator: the
 * value comes from `Intl`, but a regex assembled at runtime is what the SAST
 * gate refuses, and two constants say the same thing.
 */
const GROUPED_THOUSAND: Record<string, RegExp> = {
  '.': /^[+-]?[1-9]\d{0,2}\.\d{3}$/,
  ',': /^[+-]?[1-9]\d{0,2},\d{3}$/,
}

const separator = (locale: string | undefined, type: 'decimal' | 'group'): string | undefined =>
  new Intl.NumberFormat(locale).formatToParts(1234.5).find((part) => part.type === type)?.value

export function parseDecimalInput(raw: string, locale?: string): DecimalInput {
  const text = raw.trim()
  if (text === '') return { status: 'blank' }
  if (!DECIMAL.test(text)) return { status: 'invalid', reason: 'notANumber' }

  const ambiguous = GROUPED_THOUSAND[separator(locale, 'group') ?? '']
  if (ambiguous?.test(text)) {
    return { status: 'invalid', reason: 'ambiguous' }
  }

  const value = Number(text.replace(',', '.'))
  // A run of several hundred digits is a valid pattern and an infinite number.
  return Number.isFinite(value)
    ? { status: 'valid', value }
    : { status: 'invalid', reason: 'notANumber' }
}

/**
 * Render a stored number back into an editable field: the locale's decimal mark,
 * no grouping, so whatever this writes {@link parseDecimalInput} reads back as
 * the same number.
 */
export function formatDecimalInput(value: number | null, locale?: string): string {
  if (value === null || !Number.isFinite(value)) return ''
  const text = String(value)
  // String() switches to exponent notation for very small and very large
  // values; those are not something an operator types, so write them out.
  const plain = /e/i.test(text)
    ? value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
    : text
  return plain.replace('.', separator(locale, 'decimal') ?? '.')
}
