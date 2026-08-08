import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/**
 * `next.config.ts` runs at server start in the PRODUCTION image, where almost
 * none of `src/` exists — only the files `deploy/Dockerfile` copies in
 * explicitly. A relative import the Dockerfile does not copy is a
 * MODULE_NOT_FOUND CrashLoopBackOff in production that no local check sees:
 * update 67 (avatar-hosts.ts) and update 83 (optimizable.ts) both shipped
 * exactly that. This spec is the guard those two incidents did not have: every
 * relative import of `next.config.ts` must appear as a COPY destination in
 * `deploy/Dockerfile`.
 *
 * Only DIRECT imports are checked — the imported modules carry a header
 * obligating them to stay import-free, and this spec fails on `next.config.ts`
 * if that obligation is ever dropped there.
 */

const UI_ROOT = path.resolve(__dirname, '../../..')

function relativeImportsOf(configSource: string): string[] {
  const imports: string[] = []
  const pattern = /from\s+['"](\.[^'"]+)['"]/g
  for (const match of configSource.matchAll(pattern)) {
    imports.push(match[1])
  }
  return imports
}

function resolveImport(specifier: string): string {
  for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
    const candidate = specifier + ext
    if (existsSync(path.join(UI_ROOT, candidate))) return candidate
  }
  throw new Error(`next.config.ts imports '${specifier}', which does not resolve to a file`)
}

describe('next.config.ts runtime image copies', () => {
  const configSource = readFileSync(path.join(UI_ROOT, 'next.config.ts'), 'utf8')
  const dockerfile = readFileSync(path.join(UI_ROOT, 'deploy', 'Dockerfile'), 'utf8')
  const imports = relativeImportsOf(configSource)

  it('has at least one relative import (guard against a silently empty regex)', () => {
    expect(imports.length).toBeGreaterThan(0)
  })

  it.each(imports.map((specifier) => [specifier, resolveImport(specifier)] as const))(
    'copies %s into the production image',
    (_specifier, file) => {
      const copyPattern = new RegExp(`^COPY .* ${file.replace(/[/.]/g, (c) => `\\${c}`)}$`, 'm')
      expect(
        copyPattern.test(dockerfile),
        `deploy/Dockerfile must COPY ${file} — next.config.ts imports it at server start`,
      ).toBe(true)
    },
  )
})
