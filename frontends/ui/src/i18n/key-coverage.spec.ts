/**
 * @vitest-environment node
 */

/**
 * The guard that keeps translation keys resolvable.
 *
 * `Translator` is `(key: string, …) => string`. The key is a plain string, so
 * the compiler cannot tell `common.actions.cancel` from `common.cancel`, and a
 * miss does not throw — `createTranslator` falls back to the key itself and
 * warns only when `NODE_ENV !== 'production'`. A typo therefore ships a literal
 * dot-path into the UI: the delete-project dialog rendered a button labelled
 * "common.cancel" for exactly this reason, and `SectionCard`'s empty-state
 * fallback pointed at `platform.empty.title`, which did not exist.
 *
 * Locale-to-locale drift is already impossible — each German namespace is
 * annotated `typeof en.<ns>`, so a missing key is a compile error. This is the
 * other half: that the keys the CODE asks for exist in the dictionary at all.
 *
 * Same shape as `authz-coverage.spec.ts`, `rls-coverage.spec.ts` and the
 * exhaustive `CARD_INTERACTIVITY` map — the reminder is a failing build rather
 * than a review comment, and it lists the offenders by name.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from './dictionaries/en'
import { getByPath } from './translate'

const SRC_DIR = join(process.cwd(), 'src')
const I18N_DIR = join(SRC_DIR, 'i18n')

/**
 * Every `.ts`/`.tsx` under `src`, minus this directory — the dictionaries and
 * the translator itself legitimately mention keys without calling `t`.
 */
function sourceFiles(dir = SRC_DIR, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (path === I18N_DIR || entry.name === 'node_modules') continue
      sourceFiles(path, found)
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(path)
    }
  }
  return found
}

/**
 * Translator variables in a file, mapped to the namespace they were bound to.
 *
 * Catches both `useTranslations('chat')` and the server-side
 * `await getTranslations('chat')`, plus the un-namespaced form where the key is
 * already fully qualified.
 */
function translatorBindings(source: string): Map<string, string> {
  const bindings = new Map<string, string>()
  const namespaced = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*'([^']*)'\s*\)/g
  for (const match of source.matchAll(namespaced)) bindings.set(match[1], match[2])
  const bare = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*\)/g
  for (const match of source.matchAll(bare)) bindings.set(match[1], '')
  return bindings
}

/**
 * Every fully-literal key reference in the file, fully qualified.
 *
 * Single quotes only, which is all prettier lets this codebase write.
 */
function referencedKeys(source: string, bindings: Map<string, string>): string[] {
  const keys: string[] = []
  for (const [variable, namespace] of bindings) {
    const call = new RegExp(`\\b${variable}\\(\\s*'([^']+)'`, 'g')
    for (const match of source.matchAll(call)) {
      keys.push(namespace ? `${namespace}.${match[1]}` : match[1])
    }
  }
  return keys
}

/**
 * The static head of every computed key, fully qualified.
 *
 * A key like `t(\`roles.${role}\`)` cannot be resolved whole — the suffix is a
 * runtime value. Its PREFIX can be: `roles` must exist and must be a group of
 * strings rather than a leaf. That catches the failure that actually happens to
 * a computed key (the group was renamed or moved), without guessing at which
 * members it should have.
 */
function referencedKeyPrefixes(source: string, bindings: Map<string, string>): string[] {
  const prefixes: string[] = []
  for (const [variable, namespace] of bindings) {
    const call = new RegExp(`\\b${variable}\\(\\s*\`([^\`]+)\``, 'g')
    for (const match of source.matchAll(call)) {
      const head = match[1].split('${')[0].replace(/\.$/, '')
      if (!head) continue // fully dynamic, e.g. t(`${section}.title`) — nothing static to check
      prefixes.push(namespace ? `${namespace}.${head}` : head)
    }
  }
  return prefixes
}

describe('translation keys resolve against the dictionary', () => {
  const unresolved: string[] = []
  const danglingPrefixes: string[] = []
  let checked = 0
  let prefixesChecked = 0

  for (const file of sourceFiles()) {
    const source = readFileSync(file, 'utf8')
    const bindings = translatorBindings(source)
    if (bindings.size === 0) continue

    for (const key of referencedKeys(source, bindings)) {
      checked++
      if (typeof getByPath(en, key) !== 'string') unresolved.push(`${key}  (${file})`)
    }

    for (const prefix of referencedKeyPrefixes(source, bindings)) {
      prefixesChecked++
      const node = getByPath(en, prefix)
      if (node === undefined || typeof node !== 'object') {
        danglingPrefixes.push(`${prefix}  (${file})`)
      }
    }
  }

  it('every literal key a component asks for exists', () => {
    expect(
      unresolved.sort(),
      'These keys resolve to nothing, so the UI renders the literal dot-path. ' +
        'Fix the call site, or add the key to src/i18n/dictionaries/en (German ' +
        'follows by compile error).',
    ).toEqual([])
  })

  it('every computed key is rooted in a group that exists', () => {
    expect(
      danglingPrefixes.sort(),
      'The static head of a computed key names nothing, or names a single ' +
        'string rather than a group — so every value the suffix can take ' +
        'resolves to nothing.',
    ).toEqual([])
  })

  it('is actually looking at the call sites', () => {
    // Guards the guard: a regex that silently stops matching would make the
    // assertions above pass over nothing at all.
    expect(checked).toBeGreaterThan(1500)
    expect(prefixesChecked).toBeGreaterThan(50)
  })
})
