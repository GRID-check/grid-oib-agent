/**
 * @vitest-environment node
 */

/**
 * The guard that keeps the copy from calling a file a plan.
 *
 * Nothing knows a file is a drawing until its Dokumentart says so: a name with
 * an index says the file has Fassungen, not what it is. The folder brief once
 * announced „Planstände“ for every file whose name carried an index, contracts
 * and Gutachten included, and the product owner made it a rule (CONTEXT.md,
 * „Fassung“; AGENTS.md, „Name a file“). This spec is that rule's ratchet for
 * the namespaces that talk about files.
 *
 * What stays allowed: a Dokumentart that IS a drawing type („Lageplan“,
 * „Floor plan“) is a compound or a fixed phrase and does not match, and the
 * research plan in `chat`/`runs` is not about files, so those namespaces are
 * not scanned.
 */

import { describe, expect, it } from 'vitest'
import { de } from './dictionaries/de'
import { en } from './dictionaries/en'

/**
 * The namespaces whose copy names files. `chat` is not here: its research-plan
 * copy („Plan genehmigen“, „Plan anzeigen“) is the approval of a research plan,
 * not a file, and it is a legitimate hit.
 */
const FILE_NAMESPACES = [
  'files',
  'archiv',
  'uploadBatches',
  'knowledge',
  'onboarding',
  'projects',
  'bim',
  'common',
  'nav',
  'errors',
] as const

const FORBIDDEN: Record<'de' | 'en', RegExp> = {
  de: /(?<![\p{L}-])(Plan|Pläne|Plänen|Plans|Planstand|Planstände|Planständen)(?![\p{L}-])/u,
  // „floor plan“ and „site plan“ are Dokumentarten that are drawings by definition.
  en: /(?<!\b(?:floor|site)\s)\bplans?\b(?!-)/i,
}

function leaves(node: unknown, path: string, found: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof node === 'string') found.push([path, node])
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) leaves(value, path ? `${path}.${key}` : key, found)
  }
  return found
}

describe('file copy never calls a file a plan', () => {
  for (const [locale, dictionary] of [
    ['de', de],
    ['en', en],
  ] as const) {
    it(`${locale}: no „Plan“ wording in the file namespaces`, () => {
      const scanned = FILE_NAMESPACES.filter((ns) => ns in dictionary)
      expect(scanned).toContain('files')
      const offenders = scanned
        .flatMap((ns) => leaves((dictionary as Record<string, unknown>)[ns], ns))
        .filter(([, text]) => FORBIDDEN[locale].test(text))
        .map(([path, text]) => `${path}: ${text}`)
      expect(offenders).toEqual([])
    })
  }
})
