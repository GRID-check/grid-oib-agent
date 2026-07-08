/**
 * Framework-agnostic translation primitives.
 *
 * A dictionary is a nested plain object of strings. Keys are addressed with
 * dot paths (`profile.appearance.title`). Templates interpolate `{name}`
 * placeholders. Missing keys fall back to the key itself (and warn in dev) so
 * a typo degrades to a visible-but-harmless string rather than a crash.
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

/** Replace `{placeholder}` tokens in a template with the matching var. */
export function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
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
