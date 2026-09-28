/**
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `server.js` runs from the production image, where `src/` holds only the files
 * `deploy/Dockerfile` copies in by path. A relative `require` the Dockerfile
 * does not copy is a MODULE_NOT_FOUND crash loop before the gateway listens,
 * and nothing local sees it: `next dev` and vitest both run from the checkout.
 * `next-config-runtime-copies.spec.ts` guards `next.config.ts` the same way;
 * `server.js` had no such guard until its fourth required module.
 */

const UI_ROOT = path.resolve(__dirname, '../../..')

function relativeRequiresOf(source: string): string[] {
  const requires: string[] = []
  for (const match of source.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)) {
    requires.push(match[1].replace(/^\.\//, ''))
  }
  return requires
}

describe('server.js runtime image copies', () => {
  const source = readFileSync(path.join(UI_ROOT, 'server.js'), 'utf8')
  const dockerfile = readFileSync(path.join(UI_ROOT, 'deploy', 'Dockerfile'), 'utf8')
  const requires = relativeRequiresOf(source)

  it('has relative requires to check (guard against a silently empty regex)', () => {
    expect(requires.length).toBeGreaterThan(0)
  })

  it.each(requires)('copies %s into the production image', (file) => {
    expect(existsSync(path.join(UI_ROOT, file)), `server.js requires ${file}, which does not exist`).toBe(true)
    const copyPattern = new RegExp(`^COPY .* \\./${file.replace(/[/.]/g, (c) => `\\${c}`)}$`, 'm')
    expect(copyPattern.test(dockerfile), `deploy/Dockerfile must COPY ${file}: server.js requires it`).toBe(true)
  })
})
