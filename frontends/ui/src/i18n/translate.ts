/**
 * Framework-agnostic translation primitives.
 *
 * A dictionary is a nested plain object of strings. Keys are addressed with
 * dot paths (`profile.appearance.title`). Templates interpolate `{name}`
 * placeholders. Missing keys fall back to the key itself (and warn in dev) so
 * a typo degrades to a visible-but-harmless string rather than a crash.
 *
 * ## Counting
 *
 * A template may also carry a plural block, so a string that puts a number in
 * front of a noun can spell the noun both ways:
 *
 *     '{count, plural, one {# Abschnitt} other {# Abschnitte}}'
 *
 * `#` stands for the number, and `{name}` placeholders inside a branch are
 * interpolated as usual. This is the ICU plural syntax, cut down to the two
 * categories German and English actually distinguish.
 *
 * It is here because the alternative did not scale. The dictionaries had
 * accumulated one hand-written pair per counted noun — `hitCount`/`hitCountOne`,
 * `countOne`/`countOther`, `sharedOne`/`sharedMany`, `titleOne`/`titleMany` —
 * each with its own suffix spelling and each requiring the COMPONENT to pick,
 * which is why the several dozen counted strings that never got a pair simply
 * said "1 Schritte" and "1 hits". Choosing in the component means every new
 * counted noun is two keys plus a ternary in a file the translator does not
 * own; choosing in the template means it is one string, in the dictionary,
 * where the person writing the German can see both forms at once.
 *
 * The pairs that already exist keep working and are deliberately left alone:
 * they are correct today, and rewriting them would touch a dozen components
 * for no reader-visible gain.
 *
 * ### Why one rule serves both locales
 *
 * CLDR gives German and English the same cardinal categories: `one` for
 * exactly 1, `other` for everything else, including 0. So the selection is
 * `n === 1`, with no per-locale plural table — and this stays true only for as
 * long as `locales` is de + en. A locale with a dual, a paucal or a distinct
 * zero (pl, ru, ar, cs …) needs the real CLDR rules, and this function is the
 * one place that would change.
 */

/** Interpolation variables. Values are coerced to strings. */
export type TranslationVars = Record<string, string | number>

/** A translator function scoped to a locale (and optionally a namespace). */
export type Translator = (key: string, vars?: TranslationVars) => string

/** Read a dot-path (`a.b.c`) out of a nested object. */
export function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, segment) => {
    if (acc && typeof acc === 'object' && segment in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[segment]
    }
    return undefined
  }, obj)
}

/** Cheap pre-check so the scanner runs only for templates that count. */
const HAS_PLURAL_RE = /,\s*plural\s*,/

/** Header of a plural block: `{count, plural, ` at the start of a slice. */
const PLURAL_HEADER_RE = /^\{(\w+),\s*plural,\s*/

/** A branch label and its opening brace: `one {` at the start of a slice. */
const PLURAL_BRANCH_RE = /^\s*(\w+)\s*\{/

/**
 * Index of the `}` closing the `{` at `open`, or -1 when the braces do not
 * balance. Counting rather than matching lazily is what lets a branch contain
 * `{name}` placeholders of its own.
 */
function closingBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** Split a plural block's body into its `label -> text` branches. */
function parseBranches(body: string): Record<string, string> {
  const branches: Record<string, string> = {}
  let cursor = 0
  while (cursor < body.length) {
    const label = PLURAL_BRANCH_RE.exec(body.slice(cursor))
    if (!label) break
    const open = cursor + label[0].length - 1
    const close = closingBrace(body, open)
    if (close === -1) break
    branches[label[1]] = body.slice(open + 1, close)
    cursor = close + 1
  }
  return branches
}

/**
 * Resolve every `{name, plural, one {…} other {…}}` block in a template.
 *
 * A block whose variable is missing or is not a number falls to `other`, which
 * is the form that reads correctly for an unknown quantity — the same instinct
 * as `interpolate` leaving an unknown placeholder visible rather than blanking
 * the sentence.
 */
function applyPlurals(template: string, vars: TranslationVars): string {
  let out = ''
  let cursor = 0

  while (cursor < template.length) {
    const start = template.indexOf('{', cursor)
    if (start === -1) {
      out += template.slice(cursor)
      return out
    }

    const header = PLURAL_HEADER_RE.exec(template.slice(start))
    const close = header ? closingBrace(template, start) : -1
    if (!header || close === -1) {
      // An ordinary `{name}` placeholder (or an unbalanced block): copy the
      // brace through and let `interpolate` deal with it.
      out += template.slice(cursor, start + 1)
      cursor = start + 1
      continue
    }

    const branches = parseBranches(template.slice(start + header[0].length, close))
    const value = vars[header[1]]
    const count = typeof value === 'number' ? value : Number(value)
    const chosen =
      Number.isFinite(count) && count === 1 && branches.one !== undefined
        ? branches.one
        : (branches.other ?? '')

    out += template.slice(cursor, start) + chosen.split('#').join(String(value ?? ''))
    cursor = close + 1
  }

  return out
}

/**
 * Replace `{placeholder}` tokens in a template with the matching var, choosing
 * the singular or plural branch of any `{n, plural, …}` block first.
 */
export function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) return template
  const resolved = HAS_PLURAL_RE.test(template) ? applyPlurals(template, vars) : template
  return resolved.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * Build a translator bound to a dictionary. Pass a `namespace` to scope keys
 * so callers can write `t('title')` instead of `t('profile.title')`.
 */
export function createTranslator(dictionary: unknown, namespace?: string): Translator {
  return (key, vars) => {
    const fullKey = namespace ? `${namespace}.${key}` : key
    const value = getByPath(dictionary, fullKey)

    if (typeof value === 'string') {
      return interpolate(value, vars)
    }

    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn(`[i18n] Missing translation for key: "${fullKey}"`)
    }
    return fullKey
  }
}
