/**
 * @vitest-environment node
 *
 * Review first, held statically (ADR-0134, ratchet 2 of DECISION §10): nothing
 * reachable from the code that RECEIVES mail can file it.
 *
 * Mail at a project's address is held until a person files it. The guarantee
 * has three layers: the database refuses a filed part without a person's
 * `file` decision (migration 0186), the dynamic spec runs a perfect mail to
 * idle and counts zero documents (`review-first.e2e.spec.ts`), and this one,
 * which fails before anything runs: the webhook, the receive job, the
 * suggestion and the sweeps must not import, at any depth, a module that can
 * file a document. A receive path that never loads the filing code cannot call
 * it, whatever a later change does with flags or conditions.
 *
 * The walk follows every import a module makes (static, dynamic and
 * type-only, read by the TypeScript compiler's own pre-processor) through the
 * `@/` alias and relative paths. Filing code is named by module, and by what it
 * exports (`uploadDocument`, `uploadToShelf`), so moving the function to
 * another file does not move it out of the ratchet.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const SRC = join(process.cwd(), 'src')

/** The receive side. Each must exist: a rename must not walk out of the ratchet. */
const RECEIVE_ENTRIES = [
  'app/api/internal/signed/inbound-mail/route.ts',
  'lib/inbound-mail/receive.ts',
  'lib/inbound-mail/receive-job.ts',
  'lib/inbound-mail/announce.ts',
]

/** Receive-side modules later packages of the same change add; walked as soon as they exist. */
const LATER_ENTRIES = ['lib/inbound-mail/suggest.ts', 'lib/inbound-mail/suggest-job.ts', 'lib/inbound-mail/sweep.ts']

/** Modules that file, by path. */
const FILING_MODULES = [
  'lib/documents/shelf-upload.ts',
  'lib/mail-thread/append.ts',
  'lib/inbound-mail/file-job.ts',
  'lib/inbound-mail/follow-job.ts',
  // The job table imports every job, the filing and follow jobs among them.
  'lib/jobs-queue/handlers.ts',
]

/** Functions that file a document; a module that exports one is filing code wherever it lives. */
const FILING_EXPORTS = /\bexport\s+(?:async\s+)?function\s+(uploadDocument|uploadToShelf)\b/

const CANDIDATE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js']

function resolveImport(from: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2))
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier)
  else return null
  if (/\.(tsx?|m?js)$/.test(base) && existsSync(base)) return base
  for (const extension of CANDIDATE_EXTENSIONS) if (existsSync(base + extension)) return base + extension
  return null
}

function importsOf(file: string): string[] {
  const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
  return importedFiles.flatMap(({ fileName }) => {
    const resolved = resolveImport(file, fileName)
    return resolved ? [resolved] : []
  })
}

/** Every module reachable from `entries`, each with the module that first imported it. */
function reachable(entries: readonly string[]): Map<string, string | null> {
  const parents = new Map<string, string | null>()
  const queue: Array<[string, string | null]> = entries.map((entry) => [join(SRC, entry), null])
  while (queue.length > 0) {
    const [file, parent] = queue.shift() as [string, string | null]
    if (parents.has(file)) continue
    parents.set(file, parent)
    for (const imported of importsOf(file)) if (!parents.has(imported)) queue.push([imported, file])
  }
  return parents
}

/** `a -> b -> c`, from an entry to `file`. */
function chainTo(parents: ReadonlyMap<string, string | null>, file: string): string {
  const chain: string[] = []
  for (let at: string | null | undefined = file; at; at = parents.get(at)) chain.unshift(relative(SRC, at))
  return chain.join(' -> ')
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** Every module that files: the named ones and any that exports a filing function. */
const FILING = new Set([
  ...FILING_MODULES.map((path) => join(SRC, path)),
  ...sourceFiles(join(SRC, 'lib')).filter((file) => FILING_EXPORTS.test(readFileSync(file, 'utf8'))),
])

/** The filing modules reachable from `entries`, each with the import chain that reaches it. */
function filingReachedFrom(entries: readonly string[]): string[] {
  const parents = reachable(entries)
  return [...parents.keys()].filter((file) => FILING.has(file)).map((file) => chainTo(parents, file))
}

describe('review first: the receive side imports no filing code', () => {
  const entries = [...RECEIVE_ENTRIES, ...LATER_ENTRIES.filter((path) => existsSync(join(SRC, path)))]

  it('walks the receive side as it is (every named entry exists)', () => {
    expect(RECEIVE_ENTRIES.filter((path) => !existsSync(join(SRC, path)))).toEqual([])
  })

  it('reaches no module that files a document', () => {
    expect(filingReachedFrom(entries)).toEqual([])
  })

  it('walks deep enough to mean it: the receive side reaches its own parsers and the database', () => {
    const parents = reachable(entries)
    for (const path of ['lib/inbound-mail/mime.ts', 'lib/inbound-mail/sender-auth.ts', 'lib/db/index.ts']) {
      expect(parents.has(join(SRC, path)), path).toBe(true)
    }
    expect(parents.size).toBeGreaterThan(100)
  })

  it('knows the filing code by what it exports, and would catch a path to it', () => {
    // The upload funnel exists under the name the ratchet looks for…
    expect([...FILING].map((file) => relative(SRC, file))).toEqual(
      expect.arrayContaining(['lib/documents/shelf-upload.ts', 'lib/documents/service.ts']),
    )
    // …and a module that does import it is found, with its chain: the job table.
    expect(filingReachedFrom(['lib/jobs-queue/handlers.ts']).join('\n')).toContain('lib/documents/')
  })
})
