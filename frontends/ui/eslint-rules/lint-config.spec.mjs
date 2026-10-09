/**
 * The lint CONFIG, run end to end: every guarded rule still fires where it is
 * meant to, through the real `.oxlintrc.json` and the real oxlint binary.
 *
 * The rule specs beside this file test each rule module on its own. They cannot
 * see the two ways a guard goes quiet without anyone noticing: the config stops
 * switching the rule on for the paths it guards (a glob typo, an override that
 * lands after the one that switched it off), or the JS plugin stops loading or
 * resolving bindings after an oxlint upgrade — JS plugins are alpha and not
 * under semver. Either way `bun run lint` stays green, and green is the
 * failure. So this lints one planted violation per guard, at the path the
 * guard covers, and fails if any of them comes back clean.
 *
 * The fixtures live in a temporary copy of the layout (`src/app/…`,
 * `src/lib/…`, `tests/…`) rather than in the tree, because a planted violation
 * in `src/` would fail the real lint run.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OXLINT = path.join(UI, 'node_modules', 'oxlint', 'bin', 'oxlint')

const FIXTURES = {
  'src/app/canary/page.tsx': [
    "'use client'",
    "import { useEffect, useState } from 'react'",
    "import { getGridSession } from '@/lib/auth/session'",
    'export async function unscoped() { return getGridSession() }',
    'export const anything: any = 1',
    'export default function Page({ flag, id }: { flag: boolean; id: string }) {',
    '  if (flag) { const [x] = useState(0); void x }',
    '  useEffect(() => { void id }, [])',
    '  return <div className="transition-all"><img src="/x.png" alt="" /></div>',
    '}',
  ].join('\n'),
  'src/lib/canary.ts': [
    "import { getCached } from '@/lib/cache'",
    'export const load = (projectId: string) => getCached(`digest:${projectId}`, 1000, async () => 1)',
    'export const rollback = (tx: { rollback(): void }) => tx.rollback()',
    "export const isDuplicate = (error: { code: string }) => error.code === '23505'",
    'export const text = (page: { getTextContent(): void }) => page.getTextContent()',
  ].join('\n'),
  // Specs may spell the tenant boundary's failure modes on purpose.
  'src/lib/canary.spec.ts': [
    "import { getCached } from '@/lib/cache'",
    'export const load = (projectId: string) => getCached(`digest:${projectId}`, 1000, async () => 1)',
    "export const isDuplicate = (error: { code: string }) => error.code === '23505'",
  ].join('\n'),
  'src/features/grid-cards/schematics/kit.tsx': "export const size = 'text-sm'",
  'tests/canary.test.ts': 'export const fixture: any = {}',
}

/** [file, rule] pairs that MUST be reported. */
const EXPECTED = [
  ['src/app/canary/page.tsx', 'grid(require-tenant-scope)'],
  ['src/app/canary/page.tsx', 'typescript(no-explicit-any)'],
  ['src/app/canary/page.tsx', 'react-hooks(rules-of-hooks)'],
  ['src/app/canary/page.tsx', 'react-hooks(exhaustive-deps)'],
  ['src/app/canary/page.tsx', 'grid(motion-vocabulary)'],
  ['src/app/canary/page.tsx', 'next(no-img-element)'],
  ['src/lib/canary.ts', 'grid(require-tenant-cache-key)'],
  ['src/lib/canary.ts', 'grid(no-restricted-syntax)'],
  ['src/features/grid-cards/schematics/kit.tsx', 'grid(card-type-scale)'],
  ['tests/canary.test.ts', 'typescript(no-explicit-any)'],
]

let workdir
let findings

beforeAll(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-lint-canary-'))
  const config = fs
    .readFileSync(path.join(UI, '.oxlintrc.json'), 'utf8')
    .replace('"./eslint-rules/index.mjs"', JSON.stringify(path.join(UI, 'eslint-rules', 'index.mjs')))
  fs.writeFileSync(path.join(workdir, '.oxlintrc.json'), config)
  for (const [file, source] of Object.entries(FIXTURES)) {
    fs.mkdirSync(path.dirname(path.join(workdir, file)), { recursive: true })
    fs.writeFileSync(path.join(workdir, file), `${source}\n`)
  }

  let stdout
  try {
    stdout = execFileSync(process.execPath, [OXLINT, '-c', '.oxlintrc.json', '-f', 'json', 'src', 'tests'], {
      cwd: workdir,
      encoding: 'utf8',
    })
  } catch (error) {
    // Findings exit non-zero; the report is still on stdout.
    stdout = error.stdout
  }
  findings = JSON.parse(stdout).diagnostics.map((d) => [d.filename, d.code])
}, 60_000)

afterAll(() => {
  if (workdir) fs.rmSync(workdir, { recursive: true, force: true })
})

describe('.oxlintrc.json', () => {
  it.each(EXPECTED)('%s reports %s', (file, rule) => {
    expect(findings).toContainEqual([file, rule])
  })

  it('reports each restricted selector once', () => {
    const restricted = findings.filter(([f, r]) => f === 'src/lib/canary.ts' && r === 'grid(no-restricted-syntax)')
    expect(restricted).toHaveLength(3)
  })

  it('leaves specs out of the tenant-boundary and restricted-syntax rules', () => {
    expect(findings.filter(([file]) => file === 'src/lib/canary.spec.ts')).toEqual([])
  })
})
