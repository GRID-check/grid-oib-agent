/**
 * @vitest-environment node
 *
 * CI guard for the GENERATED platform-skills module: running the sync script in
 * --check mode must pass, or the generated module is stale. A skill file change
 * (builtin skill markdown under src/aiq_agent/skills) therefore fails the build
 * until `node scripts/sync-platform-skills.mjs` has been re-run (same shape as
 * the other generated-asset guards, e.g. scripts/generate-card-schemas.mjs).
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
// src/lib/skills -> src/lib -> src -> frontends/ui
const uiRoot = join(here, '..', '..', '..')
const script = join(uiRoot, 'scripts', 'sync-platform-skills.mjs')

describe('sync-platform-skills --check', () => {
  it('reports the generated module as up-to-date', () => {
    let output = ''
    try {
      output = execFileSync('node', [script, '--check'], { cwd: uiRoot, encoding: 'utf8' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect.fail(`platform skills are stale: ${message}`)
    }
    expect(output).toContain('ok')
  })
})