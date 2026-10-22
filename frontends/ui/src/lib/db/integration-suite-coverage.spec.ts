/**
 * @vitest-environment node
 *
 * Every Postgres integration spec runs somewhere. A spec that reads
 * `GRID_TEST_DATABASE_URL` (a `*.integration.spec.ts`, or an end-to-end spec
 * such as `inbound-mail/review-first.e2e.spec.ts`) skips itself everywhere except under
 * `task db:test:rls` (`scripts/rls-test-db.sh`), which names each file it runs.
 * A spec missing from that list is green in every gate and proves nothing:
 * `folder-cards/repository.integration.spec.ts` sat outside it while its review
 * asked for `task db:test:rls` before merge, which would never have run it.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const UI = process.cwd()
const SCRIPT = join(UI, '..', '..', 'scripts', 'rls-test-db.sh')

/** Specs that predate this check and are not in the run. Remove a line when its spec joins the script. */
const NOT_YET_RUN = new Set([
  'src/lib/model-config/bootstrap-defaults.integration.spec.ts',
  'src/lib/model-config/platform-defaults.integration.spec.ts',
  'src/lib/model-config/service.integration.spec.ts',
  'src/lib/retrieval-settings/service.integration.spec.ts',
])

const THIS_SPEC = 'src/lib/db/integration-suite-coverage.spec.ts'

function specs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : specs(path)
    return /\.spec\.tsx?$/.test(entry.name) ? [relative(UI, path)] : []
  })
}

describe('the Postgres integration suite', () => {
  const script = readFileSync(SCRIPT, 'utf8')
  const needingPostgres = specs(join(UI, 'src')).filter(
    (path) => path !== THIS_SPEC && readFileSync(join(UI, path), 'utf8').includes('GRID_TEST_DATABASE_URL'),
  )

  it('runs every spec that needs Postgres', () => {
    const missing = needingPostgres.filter((path) => !script.includes(path) && !NOT_YET_RUN.has(path))
    expect(missing, 'Add these to scripts/rls-test-db.sh, or nothing ever runs them').toEqual([])
  })

  it('keeps the exemptions honest', () => {
    const stale = [...NOT_YET_RUN].filter((path) => script.includes(path) || !needingPostgres.includes(path))
    expect(stale, 'These run now (or are gone): drop them from NOT_YET_RUN').toEqual([])
  })
})
