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
import { listPlatformSkills } from './platform-skills'
import { KNOWN_SKILL_AGENTS, METADATA_AGENTS } from './types'

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

/**
 * `grid-agents` is the availability gate. A builtin that loses this key is
 * offered to every agent, including ones that cannot carry out its
 * instructions. Research/synthesis skills must keep `deep_researcher`; OIB and
 * BIM skills name both. The assertion is that the key is present and names a
 * known agent, not that every builtin is deep-research-only.
 */
describe('architect job playbooks are offers', () => {
  it.each(['einreichcheck', 'bestand'] as const)(
    '%s declares grid-catalog curated',
    (name) => {
      const skill = listPlatformSkills().find((row) => row.name === name)
      expect(skill).toBeDefined()
      expect(skill?.metadata['grid-catalog']).toBe('curated')
    },
  )
})

describe('nvidia leftover skills are offers, not machinery', () => {
  it.each([
    'forecast-analysis',
    'prediction-report-writer',
    'data-table-analysis',
    'lightweight-calculation',
  ] as const)('%s declares grid-catalog curated', (name) => {
    const skill = listPlatformSkills().find((row) => row.name === name)
    expect(skill).toBeDefined()
    expect(skill?.metadata['grid-catalog']).toBe('curated')
    expect(skill?.metadata['grid-agents']).toBe('deep_researcher')
  })
})

describe('every builtin scopes itself to the agent that can run it', () => {
  it.each(listPlatformSkills().map((skill) => [skill.name, skill] as const))(
    '%s declares grid-agents',
    (_name, skill) => {
      const raw = skill.metadata[METADATA_AGENTS] ?? ''
      const listed = raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
      expect(listed).not.toHaveLength(0)
      // A name outside the known set is IGNORED by both resolvers, so a typo
      // here is the same as declaring nothing at all.
      expect(
        listed.filter((name) => (KNOWN_SKILL_AGENTS as readonly string[]).includes(name)),
      ).not.toHaveLength(0)
    },
  )
})
